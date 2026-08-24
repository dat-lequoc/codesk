import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { spawn } from 'node:child_process'
import { daemonAuth } from './daemon-token.mjs'

const exec = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), 'codesk-kiro-tmux-live-'))
const port = 45000 + Math.floor(Math.random() * 1000)
const base = `http://127.0.0.1:${port}`
const socket = join(root, 'tmux', 'codesk.sock')
const daemon = spawn(join(process.cwd(), 'target/debug/codeskd'), [], {
  cwd: process.cwd(),
  env: { ...process.env, CODESK_DATA_DIR: root, CODESK_PORT: String(port), RUST_LOG: 'warn' },
  stdio: ['ignore', 'pipe', 'pipe'],
})

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
const waitFor = async (predicate, timeoutMs = 120000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await sleep(400)
  }
  throw new Error('timed out waiting for Kiro tmux state')
}
const capture = async (sessionName) => {
  try {
    return (await exec('tmux', ['-S', socket, 'capture-pane', '-p', '-S', '-', '-t', sessionName])).stdout
  } catch {
    return ''
  }
}

let runId
let failed = false
let lastCapture = ''
let lastSession = null
try {
  await waitFor(async () => {
    try { return (await request('/v1/health')).ok } catch { return false }
  }, 30000)
  const project = await request('/v1/projects', {
    method: 'POST',
    body: JSON.stringify({ name: 'Codesk Kiro tmux live test', path: process.cwd() }),
  })
  const run = await request('/v1/runs', {
    method: 'POST',
    body: JSON.stringify({
      project_id: project.id,
      provider: 'kiro',
      prompt: 'Reply with exactly KIRO_CODESK_TMUX_OK and nothing else. Do not use tools.',
      workspace_mode: 'current_checkout',
    }),
  })
  runId = run.id
  const activeRun = await waitFor(async () => {
    const current = await request(`/v1/runs/${runId}`)
    if (current.status !== 'waiting_for_input' || current.input_transport !== 'tmux' || !current.tmux_name || !current.provider_session_id) return false
    const output = await capture(current.tmux_name)
    return output.split('KIRO_CODESK_TMUX_OK').length >= 3 ? current : false
  })

  // Regression: once Kiro finishes a turn it stops holding its transcript open,
  // so discovery must recover the native session id from the owned tmux control.
  // Otherwise the app loses the live writer and offers "Resume" instead of Enter.
  const attachedSession = await waitFor(async () => {
    const sessions = await request(`/v1/projects/${project.id}/sessions?refresh=true&limit=30`)
    lastSession = sessions.find((item) => item.native_session_id === activeRun.provider_session_id) || null
    if (!lastSession) return false
    return lastSession.pid && lastSession.tmux_controlled === true && lastSession.input_transport === 'tmux' ? lastSession : false
  }, 60000)
  if (attachedSession.tmux_name !== activeRun.tmux_name) {
    throw new Error(`attached session points at the wrong pane: ${attachedSession.tmux_name} !== ${activeRun.tmux_name}`)
  }
  // The composer must be able to tell that this session is owned by a managed
  // run: the external-session input path refuses managed writers, so without
  // this the UI fails with "managed runs must use the run input API".
  if (attachedSession.managed_run_id !== runId) {
    throw new Error(`attached session does not report its managed run: ${JSON.stringify(attachedSession.managed_run_id)} !== ${runId}`)
  }

  await request(`/v1/runs/${runId}/input`, {
    method: 'POST',
    body: JSON.stringify({ message: '/usage', delivery: 'steer', request_id: crypto.randomUUID() }),
  })
  // `/usage` is painted in Kiro's terminal UI and never enters the transcript,
  // and Codesk dismisses that overlay as soon as it has been read, so the pane
  // text is transient. The durable contract is the run event.
  const usageEvent = await waitFor(async () => {
    const current = await request(`/v1/runs/${runId}`)
    if (!['running', 'waiting_for_input'].includes(current.status)) throw new Error(`Kiro tmux run exited early: ${JSON.stringify(current)}`)
    lastCapture = await capture(activeRun.tmux_name)
    const events = await request(`/v1/runs/${runId}/events`)
    return events.find((event) => event.kind === 'usage.updated') || false
  }, 60000)
  const metering = usageEvent.payload?.metering_usage
  if (!Array.isArray(metering) || !(Number(metering[0]?.value) > 0)) {
    throw new Error(`usage event carries no credit data: ${JSON.stringify(usageEvent.payload)}`)
  }

  // The overlay must be dismissed, otherwise the next steer types into it.
  const marker = `STEER_AFTER_USAGE_${Math.floor(Math.random() * 1e6)}`
  await request(`/v1/runs/${runId}/input`, {
    method: 'POST',
    body: JSON.stringify({ message: `Reply with exactly ${marker} and nothing else.`, delivery: 'steer', request_id: crypto.randomUUID() }),
  })
  await waitFor(async () => {
    lastCapture = await capture(activeRun.tmux_name)
    return lastCapture.split(marker).length >= 3
  })

  console.log(JSON.stringify({ ok: true, provider: 'kiro', transport: 'tmux', session: activeRun.tmux_name, attached: true, usage: true, plan: usageEvent.payload?.plan ?? null, steerAfterUsage: true }))
} catch (error) {
  failed = true
  if (lastSession) console.error(JSON.stringify({ session: lastSession }))
  if (lastCapture) console.error(JSON.stringify({ terminal: lastCapture.slice(-4000) }))
  throw error
} finally {
  if (runId) {
    try { await request(`/v1/runs/${runId}/terminate`, { method: 'POST', body: '{}' }) } catch {}
  }
  if (daemon.exitCode === null) daemon.kill('SIGTERM')
  if (!failed) await rm(root, { recursive: true, force: true })
  else console.error(`live test data retained at ${root}`)
}
