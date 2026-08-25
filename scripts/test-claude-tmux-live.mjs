// Live Claude TUI: first turn, idle steer, then a queued follow-up that must
// wait until the active turn finishes. Print-mode Claude cannot steer; this is
// the path Codesk actually uses from the composer.
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { spawn } from 'node:child_process'
import { daemonAuth } from './daemon-token.mjs'

const exec = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), 'cctl-'))
const workspace = join(root, 'workspace')
await mkdir(workspace)
await writeFile(join(workspace, 'README.md'), '# claude live steer\n')
const port = 47000 + Math.floor(Math.random() * 1000)
const base = `http://127.0.0.1:${port}`
const socket = join(root, 'tmux', 'codesk.sock')
const daemon = spawn(join(process.cwd(), 'target/debug/codeskd'), [], {
  cwd: process.cwd(),
  env: { ...process.env, CODESK_DATA_DIR: root, CODESK_PORT: String(port), RUST_LOG: 'warn', PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}` },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let daemonErr = ''
daemon.stderr.on('data', (chunk) => { daemonErr += chunk.toString() })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const request = async (path, options = {}) => {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...daemonAuth(root), ...(options.headers || {}) },
  })
  const text = await response.text()
  let body
  try { body = JSON.parse(text) } catch { body = text }
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${path}: ${response.status} ${text}`)
  return body
}
const waitFor = async (predicate, timeoutMs = 180000, label = 'Claude tmux state') => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await sleep(400)
  }
  throw new Error(`timed out waiting for ${label}`)
}
const capture = async (sessionName) => {
  try {
    return (await exec('tmux', ['-S', socket, 'capture-pane', '-p', '-S', '-', '-t', sessionName])).stdout
  } catch {
    return ''
  }
}
const appeared = (output, marker) => output.split(marker).length >= 3

let runId
let failed = false
let lastCapture = ''
try {
  await waitFor(async () => {
    try { return (await request('/v1/health')).ok } catch { return false }
  }, 30000, 'daemon health')

  const project = await request('/v1/projects', {
    method: 'POST',
    body: JSON.stringify({ name: 'Codesk Claude tmux live test', path: workspace }),
  })
  const run = await request('/v1/runs', {
    method: 'POST',
    body: JSON.stringify({
      project_id: project.id,
      provider: 'claude',
      prompt: 'Reply with exactly CLAUDE_CODESK_TMUX_OK and nothing else. Do not use tools.',
      workspace_mode: 'current_checkout',
    }),
  })
  runId = run.id
  const activeRun = await waitFor(async () => {
    const current = await request(`/v1/runs/${runId}`)
    if (!current.tmux_name) return false
    lastCapture = await capture(current.tmux_name)
    if (lastCapture.includes('Login expired') || lastCapture.includes('Please run /login')) {
      throw new Error('Claude Code login is expired; run `claude /login` and retry this live test')
    }
    if (lastCapture.includes('Do you want to proceed') || lastCapture.includes('Allow this')) {
      throw new Error(`Claude is blocked on a permission prompt:\n${lastCapture.slice(-2000)}`)
    }
    return appeared(lastCapture, 'CLAUDE_CODESK_TMUX_OK') && ['waiting_for_input', 'running'].includes(current.status)
      ? current
      : false
  }, 180000, 'first Claude reply')

  await waitFor(async () => {
    const current = await request(`/v1/runs/${runId}`)
    lastCapture = await capture(activeRun.tmux_name)
    return current.status === 'waiting_for_input' && lastCapture.includes('❯') ? current : false
  }, 90000, 'idle composer after first turn')

  const steerMarker = `CLAUDE_STEER_${Math.floor(Math.random() * 1e6)}`
  await request(`/v1/runs/${runId}/input`, {
    method: 'POST',
    body: JSON.stringify({
      message: `Reply with exactly ${steerMarker} and nothing else. Do not use tools.`,
      delivery: 'steer',
      request_id: crypto.randomUUID(),
    }),
  })
  await waitFor(async () => {
    lastCapture = await capture(activeRun.tmux_name)
    return appeared(lastCapture, steerMarker) ? true : false
  }, 180000, 'idle steer reply')

  await waitFor(async () => {
    const current = await request(`/v1/runs/${runId}`)
    lastCapture = await capture(activeRun.tmux_name)
    return current.status === 'waiting_for_input' ? current : false
  }, 90000, 'idle after steer')

  const slowStart = `CLAUDE_SLOW_START_${Math.floor(Math.random() * 1e6)}`
  const slowDone = `CLAUDE_SLOW_DONE_${Math.floor(Math.random() * 1e6)}`
  const queueMarker = `CLAUDE_QUEUE_${Math.floor(Math.random() * 1e6)}`
  await request(`/v1/runs/${runId}/input`, {
    method: 'POST',
    body: JSON.stringify({
      message: `Start your reply with ${slowStart}. Then write the numbers 1 through 12 each on their own line. End with exactly ${slowDone}. Do not use tools.`,
      delivery: 'steer',
      request_id: crypto.randomUUID(),
    }),
  })
  await waitFor(async () => {
    lastCapture = await capture(activeRun.tmux_name)
    return lastCapture.includes(slowStart) ? true : false
  }, 120000, 'slow turn to start')
  await request(`/v1/runs/${runId}/input`, {
    method: 'POST',
    body: JSON.stringify({
      message: `Reply with exactly ${queueMarker} and nothing else. Do not use tools.`,
      delivery: 'queue',
      request_id: crypto.randomUUID(),
    }),
  })
  const queuedBeforeDone = !(await capture(activeRun.tmux_name)).includes(queueMarker)
  await waitFor(async () => {
    lastCapture = await capture(activeRun.tmux_name)
    return lastCapture.includes(slowDone) ? true : false
  }, 180000, 'slow turn to finish')
  await waitFor(async () => {
    lastCapture = await capture(activeRun.tmux_name)
    return appeared(lastCapture, queueMarker) ? true : false
  }, 180000, 'queued follow-up after idle')

  console.log(JSON.stringify({
    ok: true,
    provider: 'claude',
    transport: 'tmux',
    session: activeRun.tmux_name,
    firstTurn: true,
    steer: true,
    queueHeldUntilIdle: queuedBeforeDone,
    queueDelivered: true,
  }))
} catch (error) {
  failed = true
  if (lastCapture) console.error(JSON.stringify({ terminal: lastCapture.slice(-4000) }))
  if (daemonErr) console.error(JSON.stringify({ daemon: daemonErr.slice(-4000) }))
  throw error
} finally {
  if (runId) {
    try { await request(`/v1/runs/${runId}/terminate`, { method: 'POST', body: '{}' }) } catch {}
  }
  if (daemon.exitCode === null) daemon.kill('SIGTERM')
  if (!failed) await rm(root, { recursive: true, force: true })
  else console.error(`live test data retained at ${root}`)
}
