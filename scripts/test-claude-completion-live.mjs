// Live Claude Code: does Codesk see the turn while it runs, and notice when it
// ends?
//
// Those are the two signals the sidebar and the desktop notification are built
// on. `scripts/test-turn-completion.mjs` proves the parsing against synthetic
// transcripts for every harness; this one proves the same two signals against a
// real Claude Code process writing its own transcript, which is where a format
// change would first show up.
//
// Requires a logged-in Claude Code and real credits, so it is not part of
// `npm run test:backend`.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { daemonAuth } from './daemon-token.mjs'

const exec = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), 'codesk-claude-turn-'))
const workspace = join(root, 'workspace')
await mkdir(workspace)
await writeFile(join(workspace, 'README.md'), '# claude turn completion\n')
const port = 46600 + Math.floor(Math.random() * 300)
const base = `http://127.0.0.1:${port}`
const socket = join(root, 'tmux', 'codesk.sock')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const daemon = spawn(join(process.cwd(), 'target/debug/codeskd'), [], {
  cwd: process.cwd(),
  env: { ...process.env, CODESK_DATA_DIR: root, CODESK_PORT: String(port), RUST_LOG: 'warn', PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}` },
  stdio: ['ignore', 'ignore', 'pipe'],
})
let daemonErr = ''
daemon.stderr.on('data', (chunk) => { daemonErr += chunk.toString() })

const request = async (path, options = {}) => {
  const response = await fetch(`${base}${path}`, { ...options, headers: { 'content-type': 'application/json', ...daemonAuth(root), ...(options.headers || {}) } })
  const text = await response.text()
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${path}: ${response.status} ${text}`)
  return JSON.parse(text)
}
const waitFor = async (predicate, timeoutMs, label) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await sleep(500)
  }
  throw new Error(`timed out waiting for ${label}`)
}
const capture = async (name) => {
  try { return (await exec('tmux', ['-S', socket, 'capture-pane', '-p', '-S', '-', '-t', name])).stdout }
  catch { return '' }
}

let runId
let failed = false
let lastCapture = ''
try {
  await waitFor(async () => { try { return (await request('/v1/health')).ok } catch { return false } }, 30_000, 'daemon health')
  const project = await request('/v1/projects', { method: 'POST', body: JSON.stringify({ name: 'Claude turn completion live test', path: workspace }) })
  const run = await request('/v1/runs', {
    method: 'POST',
    body: JSON.stringify({
      project_id: project.id,
      provider: 'claude',
      // Long enough to still be running when the first samples land.
      prompt: 'Write the numbers 1 to 120, one per line, with no other text at all. Do not use tools.',
      workspace_mode: 'current_checkout',
    }),
  })
  runId = run.id

  const sessionOf = async () => {
    const sessions = await request(`/v1/projects/${project.id}/sessions?limit=20`)
    return sessions.find((session) => session.provider === 'claude' && session.pid)
  }
  const turnsOf = async (session) => {
    const messages = await request(`/v1/projects/${project.id}/sessions/claude/${encodeURIComponent(session.native_session_id)}/messages`)
    return messages.filter((message) => message.kind === 'turn_completed')
  }

  const started = await waitFor(async () => {
    const current = await request(`/v1/runs/${runId}`)
    if (current.tmux_name) {
      lastCapture = await capture(current.tmux_name)
      if (lastCapture.includes('Login expired') || lastCapture.includes('Please run /login'))
        throw new Error('Claude Code login is expired; run `claude /login` and retry this live test')
      if (lastCapture.includes('Do you want to proceed') || lastCapture.includes('Allow this'))
        throw new Error(`Claude is blocked on a permission prompt:\n${lastCapture.slice(-2000)}`)
    }
    const session = await sessionOf()
    return session?.status === 'running' ? session : false
  }, 120_000, 'the conversation to report a running turn')

  // A tmux run parks at waiting_for_input between turns, so its own status can
  // never say a turn finished. That is exactly why the transcript is watched.
  const runDuringTurn = await request(`/v1/runs/${runId}`)
  assert.equal(runDuringTurn.input_transport, 'tmux', 'this live path is meant to exercise the tmux transport')
  assert.equal((await turnsOf(started)).length, 0, 'a turn was marked finished while it was still running')

  const finished = await waitFor(async () => {
    const session = await sessionOf()
    if (!session || session.status === 'running') return false
    const turns = await turnsOf(session)
    return turns.length ? { session, turns } : false
  }, 240_000, 'the finished turn to be marked')

  assert.equal(finished.turns.length, 1, `the transcript reported ${finished.turns.length} finished turns for one prompt`)
  const [turn] = finished.turns
  assert.equal(turn.kind, 'turn_completed')
  assert.ok(turn.timestamp, 'the turn marker carries no timestamp, so nothing can order it')
  assert.ok(
    turn.duration_ms === undefined || turn.duration_ms > 0,
    `the turn marker reported a duration of ${turn.duration_ms}`,
  )

  console.log(JSON.stringify({
    ok: true,
    provider: 'claude',
    transport: 'tmux',
    sawRunningTurn: true,
    turnMarkers: finished.turns.length,
    durationMs: turn.duration_ms ?? null,
  }))
  console.log('ok - a live Claude Code turn reports running, then leaves exactly one turn marker behind')
} catch (error) {
  failed = true
  if (lastCapture) console.error(JSON.stringify({ terminal: lastCapture.slice(-3000) }))
  if (daemonErr) console.error(JSON.stringify({ daemon: daemonErr.slice(-3000) }))
  throw error
} finally {
  if (runId) { try { await request(`/v1/runs/${runId}/terminate`, { method: 'POST', body: '{}' }) } catch {} }
  await sleep(500)
  if (daemon.exitCode === null) daemon.kill('SIGTERM')
  await sleep(500)
  if (!failed) await rm(root, { recursive: true, force: true })
  else console.error(`live test data retained at ${root}`)
}
