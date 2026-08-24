import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { daemonAuth } from './daemon-token.mjs'

const root = await mkdtemp(join(tmpdir(), 'codesk-agy-live-'))
const projectRoot = join(root, 'project')
await mkdir(projectRoot, { recursive: true })
await writeFile(join(projectRoot, 'AGY_WORKSPACE_SENTINEL.txt'), 'AGY_WORKSPACE_VISIBLE\n')
const port = 46000 + Math.floor(Math.random() * 1000)
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
    headers: { 'content-type': 'application/json', ...daemonAuth(root), ...(options.headers || {}) },
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
    await sleep(400)
  }
  throw new Error(`timed out waiting for ${description}`)
}
const assistantText = (events) => events
  .filter((event) => event.kind === 'assistant.message')
  .map((event) => String(event.payload?.text || ''))
  .join('')
const terminalStatuses = new Set(['completed', 'failed', 'interrupted', 'killed', 'orphaned'])
const stopRun = async (id) => {
  try { await request(`/v1/runs/${id}/terminate`, { method: 'POST', body: '{}' }) } catch {}
  await waitFor(`run ${id} to stop`, async () => {
    const run = await request(`/v1/runs/${id}`)
    return terminalStatuses.has(run.status) ? run : false
  }, 30000).catch(() => false)
}

const runIds = []
let failed = false
try {
  await waitFor('Codesk health', async () => {
    try { return (await request('/v1/health')).ok } catch { return false }
  }, 30000)

  const capabilities = await request('/v1/capabilities')
  const agy = capabilities.find((item) => item.id === 'agy')
  if (!agy?.available || !agy.structured_output || !agy.resume || agy.fork || agy.live_input || agy.native_interrupt) {
    throw new Error(`unexpected Antigravity capability: ${JSON.stringify({ agy, capabilities })}`)
  }

  const project = await request('/v1/projects', {
    method: 'POST',
    body: JSON.stringify({ name: 'Codesk Antigravity live test', path: projectRoot }),
  })
  const initial = await request('/v1/runs', {
    method: 'POST',
    body: JSON.stringify({
      project_id: project.id,
      provider: 'agy',
      prompt: 'In the current Codesk project, use the run_command tool to execute `cat AGY_WORKSPACE_SENTINEL.txt && printf AGY_CODESK_TOOL_OK`, then reply exactly AGY_CODESK_INITIAL_OK.',
      workspace_mode: 'current_checkout',
    }),
  })
  runIds.push(initial.id)
  const initialEvents = () => request(`/v1/runs/${initial.id}/events`)
  const completed = await waitFor('Antigravity structured tool turn', async () => {
    const [run, events] = await Promise.all([request(`/v1/runs/${initial.id}`), initialEvents()])
    const tool = events.find((event) => event.kind === 'tool.output'
      && String(event.payload?.tool_title || '').includes('AGY_CODESK_TOOL_OK')
      && String(event.payload?.text || '').includes('AGY_WORKSPACE_VISIBLE'))
    const usage = events.find((event) => event.kind === 'usage.updated' && Number(event.payload?.total_tokens) > 0)
    const session = events.find((event) => event.kind === 'thread.session')
    return run.status === 'completed' && assistantText(events).includes('AGY_CODESK_INITIAL_OK') && tool && usage && session ? { run, events, tool, usage, session } : false
  })
  const sessionId = completed.session.raw_payload?.conversation_id || completed.run.provider_session_id
  if (!sessionId) throw new Error('Antigravity did not publish a conversation id')

  const resumed = await request('/v1/runs', {
    method: 'POST',
    body: JSON.stringify({
      project_id: project.id,
      provider: 'agy',
      prompt: 'Reply exactly AGY_CODESK_RESUME_OK and nothing else. Do not use tools.',
      workspace_mode: 'current_checkout',
      operation: 'resume',
      resume_session_id: sessionId,
    }),
  })
  runIds.push(resumed.id)
  const resumedResult = await waitFor('Antigravity conversation resume', async () => {
    const [run, events] = await Promise.all([
      request(`/v1/runs/${resumed.id}`),
      request(`/v1/runs/${resumed.id}/events`),
    ])
    return run.status === 'completed' && assistantText(events).includes('AGY_CODESK_RESUME_OK') ? { run, events } : false
  })
  if (resumedResult.run.provider_session_id !== sessionId) {
    throw new Error(`resume changed conversation id: ${resumedResult.run.provider_session_id} !== ${sessionId}`)
  }

  const sessions = await waitFor('Antigravity history index', async () => {
    const list = await request(`/v1/projects/${project.id}/sessions?limit=150`)
    return list.some((session) => session.provider === 'agy' && session.native_session_id === sessionId) ? list : false
  }, 30000)
  const history = await request(`/v1/projects/${project.id}/sessions/agy/${encodeURIComponent(sessionId)}/messages`)
  if (!history.some((message) => message.role === 'user')
      || !history.some((message) => message.role === 'assistant')
      || !history.some((message) => ['tool', 'tool_output'].includes(message.kind))) {
    throw new Error(`Antigravity history was not normalized: ${JSON.stringify(history.slice(-12))}`)
  }

  const interrupt = await request('/v1/runs', {
    method: 'POST',
    body: JSON.stringify({
      project_id: project.id,
      provider: 'agy',
      prompt: 'Use the run_command tool to execute `sleep 30`, then reply AGY_CODESK_INTERRUPT_MISSED.',
      workspace_mode: 'current_checkout',
    }),
  })
  runIds.push(interrupt.id)
  await waitFor('interruptible Antigravity process', async () => (await request(`/v1/runs/${interrupt.id}`)).status === 'running')
  await sleep(1200)
  await request(`/v1/runs/${interrupt.id}/interrupt`, { method: 'POST', body: '{}' })
  const interrupted = await waitFor('Antigravity process interruption', async () => {
    const run = await request(`/v1/runs/${interrupt.id}`)
    return terminalStatuses.has(run.status) ? run : false
  }, 30000)
  if (!['interrupted', 'failed'].includes(interrupted.status)) {
    throw new Error(`Antigravity interrupt ended unexpectedly: ${interrupted.status}`)
  }

  console.log(JSON.stringify({
    ok: true,
    provider: 'agy',
    sessionId,
    indexedSessions: sessions.filter((session) => session.provider === 'agy').length,
    tool: completed.tool.payload?.tool_title,
    usage: {
      input_tokens: completed.usage.payload?.input_tokens,
      output_tokens: completed.usage.payload?.output_tokens,
      thinking_tokens: completed.usage.payload?.thinking_tokens,
      cache_read_tokens: completed.usage.payload?.cache_read_tokens,
      total_tokens: completed.usage.payload?.total_tokens,
      duration_seconds: completed.usage.payload?.duration_seconds,
    },
  }))
} catch (error) {
  failed = true
  for (const id of runIds) {
    try {
      const [run, events] = await Promise.all([
        request(`/v1/runs/${id}`),
        request(`/v1/runs/${id}/events`),
      ])
      console.error(JSON.stringify({ error: String(error), run, events: events.map((event) => ({ kind: event.kind, text: event.payload?.text, tool: event.payload?.tool_title, provider_event_type: event.provider_event_type })) }))
    } catch {}
  }
  throw error
} finally {
  for (const id of runIds) await stopRun(id)
  if (daemon.exitCode === null) daemon.kill('SIGTERM')
  if (!failed) await rm(root, { recursive: true, force: true })
  else console.error(`live test data retained at ${root}`)
}
