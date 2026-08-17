import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const root = await mkdtemp(join(tmpdir(), 'codesk-dsh-live-'))
const port = 45000 + Math.floor(Math.random() * 1000)
const base = `http://127.0.0.1:${port}`
const daemon = spawn(join(process.cwd(), 'target/debug/codeskd'), [], {
  cwd: process.cwd(),
  env: { ...process.env, CODESK_DATA_DIR: root, CODESK_PORT: String(port), RUST_LOG: 'warn', CODESK_RUN_TRANSPORT: 'structured' },
  stdio: ['ignore', 'pipe', 'pipe'],
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const request = async (path, options = {}) => {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  })
  const text = await response.text()
  let body
  try { body = JSON.parse(text) } catch { body = text }
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${path}: ${response.status} ${text}`)
  return body
}
const waitFor = async (description, predicate, timeoutMs = 180000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await sleep(350)
  }
  throw new Error(`timed out waiting for ${description}`)
}
const textFrom = (events) => events.filter((event) => event.kind === 'assistant.message').map((event) => String(event.payload?.text || '')).join('')
const stopRun = async (id) => {
  try { await request(`/v1/runs/${id}/terminate`, { method: 'POST', body: '{}' }) } catch {}
  await waitFor(`run ${id} to stop`, async () => {
    const run = await request(`/v1/runs/${id}`)
    return ['completed', 'failed', 'interrupted', 'killed', 'orphaned'].includes(run.status) ? run : false
  }, 30000).catch(() => false)
}

const runIds = []
let failed = false
try {
  await waitFor('Codesk health', async () => {
    try { return (await request('/v1/health')).ok } catch { return false }
  }, 30000)
  const capabilities = await request('/v1/capabilities')
  const dsh = capabilities.find((item) => item.id === 'dsh')
  if (!dsh?.available || !dsh.resume || !dsh.fork || !dsh.live_input || !dsh.native_interrupt) {
    throw new Error(`unexpected DSH capability: ${JSON.stringify({ dsh, capabilities })}`)
  }

  const project = await request('/v1/projects', {
    method: 'POST',
    body: JSON.stringify({ name: 'Codesk DSH live test', path: process.cwd() }),
  })
  const run = await request('/v1/runs', {
    method: 'POST',
    body: JSON.stringify({
      project_id: project.id,
      provider: 'dsh',
      prompt: 'Use the bash tool to run `sleep 3`, then reply exactly DSH_CODESK_INITIAL_OK.',
      workspace_mode: 'current_checkout',
    }),
  })
  runIds.push(run.id)
  const events = () => request(`/v1/runs/${run.id}/events`)
  await request(`/v1/runs/${run.id}/input`, {
    method: 'POST',
    body: JSON.stringify({ message: 'Reply exactly DSH_CODESK_QUEUE_OK and nothing else. Do not use tools.', delivery: 'queue', request_id: crypto.randomUUID() }),
  })
  const initial = await waitFor('initial DSH tool turn and queued turn', async () => {
    const list = await events()
    const text = textFrom(list)
    const tool = list.some((event) => event.kind === 'tool.output' && event.payload?.tool_title)
    const queued = list.some((event) => event.kind === 'queue.added') && list.some((event) => event.kind === 'queue.started')
    const completed = list.filter((event) => event.kind === 'turn.completed').length >= 2
    return text.includes('DSH_CODESK_INITIAL_OK') && text.includes('DSH_CODESK_QUEUE_OK') && tool && queued && completed ? list : false
  })
  const sessionEvent = initial.find((event) => event.kind === 'thread.session')
  const sessionId = sessionEvent?.raw_payload?.sessionId || (await request(`/v1/runs/${run.id}`)).provider_session_id
  if (!sessionId) throw new Error('DSH did not publish a native session id')

  await request(`/v1/runs/${run.id}/input`, {
    method: 'POST',
    body: JSON.stringify({ message: 'Use the bash tool to run `sleep 5`, then reply DSH_CODESK_STEER_BASE.', delivery: 'auto', request_id: crypto.randomUUID() }),
  })
  const turnCount = initial.filter((event) => event.kind === 'turn.started').length
  await waitFor('DSH steer target turn', async () => {
    const list = await events()
    return list.filter((event) => event.kind === 'turn.started').length > turnCount && list.some((event) => event.kind === 'tool.output' && event.payload?.tool_status === 'in_progress')
  })
  await request(`/v1/runs/${run.id}/input`, {
    method: 'POST',
    body: JSON.stringify({ message: 'Steer: after the tool finishes, reply exactly DSH_CODESK_STEER_OK and nothing else.', delivery: 'steer', request_id: crypto.randomUUID() }),
  })
  await waitFor('native DSH steer response', async () => textFrom(await events()).includes('DSH_CODESK_STEER_OK'))

  await request(`/v1/runs/${run.id}/input`, {
    method: 'POST',
    body: JSON.stringify({ message: '/usage', delivery: 'auto', request_id: crypto.randomUUID() }),
  })
  const usage = await waitFor('DSH usage snapshot', async () => {
    const list = await events()
    return list.find((event) => event.kind === 'usage.updated' && Number(event.payload?.context_window) > 0) || false
  })

  await request(`/v1/runs/${run.id}/input`, {
    method: 'POST',
    body: JSON.stringify({ message: 'Use the bash tool to run `sleep 30`, then reply DSH_CODESK_CANCEL_MISSED.', delivery: 'auto', request_id: crypto.randomUUID() }),
  })
  await waitFor('cancellable DSH turn', async () => (await request(`/v1/runs/${run.id}`)).status === 'running')
  await request(`/v1/runs/${run.id}/interrupt`, { method: 'POST', body: '{}' })
  await waitFor('DSH cancellation to settle', async () => {
    const current = await request(`/v1/runs/${run.id}`)
    const list = await events()
    return current.status === 'waiting_for_input' && list.some((event) => event.kind === 'control.acknowledged' && event.provider_event_type === 'dsh.codesk.control.ack')
  })
  await stopRun(run.id)

  const resumed = await request('/v1/runs', {
    method: 'POST',
    body: JSON.stringify({
      project_id: project.id,
      provider: 'dsh',
      prompt: 'Reply exactly DSH_CODESK_RESUME_OK and nothing else. Do not use tools.',
      workspace_mode: 'current_checkout',
      operation: 'resume',
      resume_session_id: sessionId,
    }),
  })
  runIds.push(resumed.id)
  const resumedEvents = () => request(`/v1/runs/${resumed.id}/events`)
  await waitFor('DSH cold resume', async () => textFrom(await resumedEvents()).includes('DSH_CODESK_RESUME_OK'))
  const resumedSession = (await request(`/v1/runs/${resumed.id}`)).provider_session_id
  if (resumedSession !== sessionId) throw new Error(`resume changed session id: ${resumedSession} !== ${sessionId}`)
  await stopRun(resumed.id)

  const forked = await request('/v1/runs', {
    method: 'POST',
    body: JSON.stringify({
      project_id: project.id,
      provider: 'dsh',
      prompt: 'Reply exactly DSH_CODESK_FORK_OK and nothing else. Do not use tools.',
      workspace_mode: 'current_checkout',
      operation: 'fork',
      resume_session_id: sessionId,
    }),
  })
  runIds.push(forked.id)
  const forkedEvents = () => request(`/v1/runs/${forked.id}/events`)
  await waitFor('DSH fork', async () => textFrom(await forkedEvents()).includes('DSH_CODESK_FORK_OK'))
  const forkedSession = (await request(`/v1/runs/${forked.id}`)).provider_session_id
  if (!forkedSession || forkedSession === sessionId) throw new Error(`fork did not create a new session: ${forkedSession}`)
  await stopRun(forked.id)

  const sessions = await request(`/v1/projects/${project.id}/sessions?limit=150`)
  if (!sessions.some((session) => session.provider === 'dsh' && session.native_session_id === sessionId)) {
    throw new Error('DSH historical session was not indexed for the project')
  }
  const history = await request(`/v1/projects/${project.id}/sessions/dsh/${encodeURIComponent(sessionId)}/messages`)
  if (!history.some((message) => message.role === 'user') || !history.some((message) => message.role === 'assistant')) {
    throw new Error(`DSH historical messages were not normalized: ${JSON.stringify(history.slice(-10))}`)
  }

  console.log(JSON.stringify({
    ok: true,
    provider: 'dsh',
    sessionId,
    forkedSession,
    usage: {
      context_usage_percentage: usage.payload.context_usage_percentage,
      context_window: usage.payload.context_window,
      uncached_input_tokens: usage.payload.uncached_input_tokens,
      output_tokens: usage.payload.output_tokens,
    },
  }))
} catch (error) {
  failed = true
  for (const id of runIds) {
    try {
      const current = await request(`/v1/runs/${id}`)
      const list = await request(`/v1/runs/${id}/events`)
      console.error(JSON.stringify({ error: String(error), run: current, events: list.map((event) => ({ kind: event.kind, text: event.payload?.text, tool: event.payload?.tool_title, provider_event_type: event.provider_event_type })) }))
    } catch {}
  }
  throw error
} finally {
  for (const id of runIds) await stopRun(id)
  if (daemon.exitCode === null) daemon.kill('SIGTERM')
  if (!failed) await rm(root, { recursive: true, force: true })
  else console.error(`live test data retained at ${root}`)
}
