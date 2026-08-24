// Measures the CPU cost of one managed Codex run inside `codeskd`.
//
// Two phases, both driven by a fake `codex app-server` so the result is
// deterministic and offline:
//
//   idle   - a Codex run is attached with its turn completed and nothing
//            happening. This isolates the per-run polling overhead.
//   stream - one turn emits a fixed number of streaming deltas. This isolates
//            the per-event ingest cost (normalize -> SQLite -> broadcast).
//
// Reported CPU is process CPU time from `ps -o time=`, summed over the daemon
// and its durable runner, so it is comparable between revisions on the same
// machine. Run it three times and compare the median.
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { daemonAuth } from './daemon-token.mjs'

const exec = promisify(execFile)
const root = process.cwd()
const binary = path.join(root, 'target/debug/codeskd')
const IDLE_SECONDS = Number(process.env.BENCH_IDLE_SECONDS || 12)
const STREAM_EVENTS = Number(process.env.BENCH_STREAM_EVENTS || 2000)
const port = 4800 + Math.floor(Math.random() * 150)
const base = `http://127.0.0.1:${port}`
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'codesk-bench-codex-'))
const dataDir = path.join(temp, 'data')
const binDir = path.join(temp, 'bin')

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function request(route, options) {
  const response = await fetch(`${base}${route}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...daemonAuth(dataDir), ...options?.headers },
  })
  const body = await response.json()
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
  return body
}

async function healthy() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await request('/v1/health')
      return
    } catch {
      await wait(100)
    }
  }
  throw new Error('daemon did not become healthy')
}

// `ps -o time=` prints cumulative CPU time as [[dd-]hh:]mm:ss.ss.
function parseCpuSeconds(value) {
  const [dayPart, clockPart] = value.trim().includes('-')
    ? value.trim().split('-')
    : [null, value.trim()]
  const parts = clockPart.split(':').map(Number)
  let seconds = parts.pop() ?? 0
  let scale = 60
  while (parts.length) {
    seconds += (parts.pop() ?? 0) * scale
    scale *= 60
  }
  return seconds + (dayPart ? Number(dayPart) * 86_400 : 0)
}

async function cpuSeconds(pids) {
  const alive = pids.filter(Boolean)
  if (!alive.length) return 0
  const { stdout } = await exec('ps', ['-o', 'time=', '-p', alive.join(',')])
  return stdout
    .split('\n')
    .filter((line) => line.trim())
    .reduce((total, line) => total + parseCpuSeconds(line), 0)
}

async function contextSwitches(pids) {
  const alive = pids.filter(Boolean)
  if (!alive.length) return 0
  const args = ['-l', '1', '-stats', 'pid,csw']
  for (const pid of alive) args.push('-pid', String(pid))
  const { stdout } = await exec('top', args)
  return stdout
    .split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)/))
    .filter(Boolean)
    .reduce((total, match) => total + Number(match[2]), 0)
}

async function descendantPids(pid) {
  const { stdout } = await exec('ps', ['-axo', 'pid=,ppid='])
  const children = new Map()
  for (const line of stdout.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/)
    if (!match) continue
    const parent = Number(match[2])
    if (!children.has(parent)) children.set(parent, [])
    children.get(parent).push(Number(match[1]))
  }
  const collected = []
  const queue = [pid]
  while (queue.length) {
    const current = queue.shift()
    for (const child of children.get(current) || []) {
      collected.push(child)
      queue.push(child)
    }
  }
  return collected
}

await fs.mkdir(binDir, { recursive: true })
// Fake `codex app-server`: completes the opening turn immediately so the run
// reaches a true idle state, then streams a fixed burst of deltas on demand.
await fs.writeFile(
  path.join(binDir, 'codex'),
  `#!/usr/bin/env node
import readline from 'node:readline'
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
let thread = null
let turns = 0
const lines = readline.createInterface({ input: process.stdin })
lines.on('line', (line) => {
  const message = JSON.parse(line)
  const { id, method, params = {} } = message
  if (method === 'initialize') { send({ id, result: { userAgent: 'bench', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'darwin' } }); return }
  if (method === 'initialized') return
  if (method === 'thread/start') { thread = 'thread-1'; send({ id, result: { thread: { id: thread, turns: [] }, model: 'bench', modelProvider: 'bench', cwd: params.cwd } }); return }
  if (method === 'turn/start') {
    const turn = 'turn-' + (++turns)
    const text = params.input?.[0]?.text || ''
    send({ id, result: { turn: { id: turn, status: 'inProgress', items: [] } } })
    send({ method: 'turn/started', params: { threadId: thread, turn: { id: turn, status: 'inProgress', items: [] } } })
    const burst = text.startsWith('BURST') ? Number(text.split(':')[1] || 0) : 0
    for (let index = 0; index < burst; index += 1) {
      send({ method: 'item/agentMessage/delta', params: { threadId: thread, turnId: turn, itemId: 'assistant-' + turn, delta: 'token ' + index + ' ' } })
    }
    send({ method: 'turn/completed', params: { threadId: thread, turn: { id: turn, status: 'completed', items: [] } } })
    return
  }
  if (method === 'turn/interrupt') { send({ id, result: {} }); return }
  if (id !== undefined) send({ id, result: {} })
})
`,
  { mode: 0o755 },
)

let daemon
let run
const report = {}

async function eventCount(runId) {
  return (await request(`/v1/runs/${runId}/events?after=0`)).length
}

// Counts only events past `after`, so polling for burst progress stays O(new)
// instead of re-serializing the whole run history on every check.
async function eventsSince(runId, after) {
  return (await request(`/v1/runs/${runId}/events?after=${after}`)).length
}

try {
  daemon = spawn(binary, [], {
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      CODESK_DATA_DIR: dataDir,
      CODESK_PORT: String(port),
      CODESK_RUN_TRANSPORT: 'structured',
    },
    stdio: 'ignore',
  })
  await healthy()

  const project = await request('/v1/projects', {
    method: 'POST',
    body: JSON.stringify({ name: 'codex-bench', path: root }),
  })
  run = await request('/v1/runs', {
    method: 'POST',
    body: JSON.stringify({
      project_id: project.id,
      provider: 'codex',
      prompt: 'bench warmup',
      workspace_mode: 'current_checkout',
    }),
  })

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await request(`/v1/runs/${run.id}`)).status === 'waiting_for_input') break
    await wait(100)
  }
  const processes = [daemon.pid, run.pid, ...(await descendantPids(run.pid))]
  report.measured_pids = processes.length

  // Phase 1: idle. Nothing is happening; all CPU here is polling overhead.
  await wait(1500)
  const idleBaseline = await cpuSeconds(processes)
  const idleCswBaseline = await contextSwitches(processes)
  const idleStarted = process.hrtime.bigint()
  await wait(IDLE_SECONDS * 1000)
  const idleElapsed = Number(process.hrtime.bigint() - idleStarted) / 1e9
  const idleCpu = (await cpuSeconds(processes)) - idleBaseline
  const idleCsw = (await contextSwitches(processes)) - idleCswBaseline
  report.idle_seconds = Number(idleElapsed.toFixed(2))
  report.idle_cpu_seconds = Number(idleCpu.toFixed(2))
  report.idle_cpu_percent = Number(((idleCpu / idleElapsed) * 100).toFixed(2))
  report.idle_context_switches_per_second = Math.round(idleCsw / idleElapsed)

  // Phase 2: wake latency. The pump has been idle long enough to have backed
  // off to its ceiling, so this is the worst-case delay between submitting
  // input and seeing the resulting event. It must not grow with the backoff.
  const beforeWake = await eventCount(run.id)
  const wakeStarted = process.hrtime.bigint()
  await request(`/v1/runs/${run.id}/input`, {
    method: 'POST',
    body: JSON.stringify({ message: 'BURST:1', request_id: 'bench-wake', delivery: 'auto' }),
  })
  let wakeLatency = null
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if ((await eventsSince(run.id, beforeWake)) > 1) {
      wakeLatency = Number(process.hrtime.bigint() - wakeStarted) / 1e6
      break
    }
    await wait(5)
  }
  report.wake_latency_ms = wakeLatency === null ? null : Number(wakeLatency.toFixed(1))
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await request(`/v1/runs/${run.id}`)).status === 'waiting_for_input') break
    await wait(50)
  }

  // Phase 3: streaming ingest of a fixed number of deltas.
  const before = await eventCount(run.id)
  const streamBaseline = await cpuSeconds(processes)
  const streamStarted = process.hrtime.bigint()
  await request(`/v1/runs/${run.id}/input`, {
    method: 'POST',
    body: JSON.stringify({
      message: `BURST:${STREAM_EVENTS}`,
      request_id: 'bench-burst',
      delivery: 'auto',
    }),
  })
  let ingested = 0
  for (let attempt = 0; attempt < 1200; attempt += 1) {
    ingested = await eventsSince(run.id, before)
    if (ingested >= STREAM_EVENTS) break
    await wait(100)
  }
  const streamElapsed = Number(process.hrtime.bigint() - streamStarted) / 1e9
  const streamCpu = (await cpuSeconds(processes)) - streamBaseline
  report.stream_events_requested = STREAM_EVENTS
  report.stream_events_ingested = ingested
  report.stream_wall_seconds = Number(streamElapsed.toFixed(2))
  report.stream_events_per_second = Math.round(ingested / streamElapsed)
  report.stream_cpu_seconds = Number(streamCpu.toFixed(2))
  report.stream_cpu_ms_per_event = Number(((streamCpu / Math.max(1, ingested)) * 1000).toFixed(3))

  // Correctness gate on the pump's byte-offset arithmetic. Each delta carries
  // its own index, so a dropped or double-counted line shows up here as a gap or
  // a duplicate rather than as a plausible-looking event count.
  const streamed = await request(`/v1/runs/${run.id}/events?after=${before}`)
  const indices = streamed
    .map((event) => /^token (\d+) $/.exec(event.payload?.text || '')?.[1])
    .filter((value) => value !== undefined)
    .map(Number)
  const unique = new Set(indices)
  report.delta_events_received = indices.length
  report.delta_events_unique = unique.size
  report.delta_sequence_intact =
    indices.length === STREAM_EVENTS &&
    unique.size === STREAM_EVENTS &&
    indices.every((value, position) => value === position)
  report.complete = ingested >= STREAM_EVENTS && report.delta_sequence_intact

  console.log(JSON.stringify(report, null, 2))
  if (!report.delta_sequence_intact) {
    throw new Error(
      `stream integrity failed: received ${indices.length} deltas (${unique.size} unique) of ${STREAM_EVENTS}`,
    )
  }
} finally {
  try {
    if (run?.id) await request(`/v1/runs/${run.id}/terminate`, { method: 'POST', body: '{}' })
  } catch {}
  try {
    if (run?.process_group_id) process.kill(-run.process_group_id, 'SIGTERM')
  } catch {}
  try {
    if (daemon && daemon.exitCode === null) {
      daemon.kill('SIGINT')
      await new Promise((resolve) => daemon.once('exit', resolve))
    }
  } catch {}
  await fs.rm(temp, { recursive: true, force: true }).catch(() => {})
}
