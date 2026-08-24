import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { daemonAuth } from './daemon-token.mjs'

const root = await mkdtemp(join(tmpdir(), 'codesk-kiro-live-'))
const port = 44000 + Math.floor(Math.random() * 1000)
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
const waitFor = async (predicate, timeoutMs = 120000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await sleep(400)
  }
  throw new Error('timed out waiting for Kiro ACP event')
}

let runId
let failed = false
try {
  await waitFor(async () => {
    try { return (await request('/v1/health')).ok } catch { return false }
  }, 30000)
  const capabilities = await request('/v1/capabilities')
  const kiro = capabilities.find((item) => item.id === 'kiro')
  if (!kiro?.available || !kiro.resume || kiro.fork) throw new Error(`unexpected Kiro capability: ${JSON.stringify({ kiro, capabilities })}`)

  const project = await request('/v1/projects', {
    method: 'POST',
    body: JSON.stringify({ name: 'Codesk Kiro live test', path: process.cwd() }),
  })
  const run = await request('/v1/runs', {
    method: 'POST',
    body: JSON.stringify({
      project_id: project.id,
      provider: 'kiro',
      prompt: 'Reply with exactly KIRO_CODESK_API_OK and nothing else. Do not use tools.',
      workspace_mode: 'current_checkout',
    }),
  })
  runId = run.id
  const events = () => request(`/v1/runs/${runId}/events`)
  await request(`/v1/runs/${runId}/input`, {
    method: 'POST',
    body: JSON.stringify({ message: 'Reply with exactly KIRO_CODESK_QUEUE_OK and nothing else. Do not use tools.', delivery: 'queue', request_id: crypto.randomUUID() }),
  })
  const initial = await waitFor(async () => {
    const list = await events()
    const assistant = list
      .filter((event) => event.kind === 'assistant.message')
      .map((event) => String(event.payload?.text || ''))
      .join('')
    const completed = list.some((event) => event.kind === 'turn.completed')
    const queued = list.some((event) => event.kind === 'queue.started')
    const queueCompleted = list.filter((event) => event.kind === 'turn.completed').length >= 2
    return assistant.includes('KIRO_CODESK_API_OK') && completed && queued && queueCompleted ? list : false
  })
  const sessionEvent = initial.find((event) => event.kind === 'thread.session')
  const sessionId = sessionEvent?.raw_payload?.sessionId || run.provider_session_id
  if (!sessionId) throw new Error('Kiro ACP did not publish a session id')

  const commandsEvent = initial.find((event) => event.kind === 'commands.updated')
  const commandNames = (commandsEvent?.payload?.commands || []).map((command) => command.name)
  for (const required of ['/usage', '/model', '/effort', '/compact']) {
    if (!commandNames.includes(required)) throw new Error(`Kiro did not advertise ${required}: ${JSON.stringify(commandNames)}`)
  }
  const sessionResponse = initial.find((event) => event.raw_payload?.result?.models?.currentModelId)
  const currentModel = sessionResponse?.raw_payload?.result?.models?.currentModelId
  const availableModels = sessionResponse?.raw_payload?.result?.models?.availableModels || []
  if (!currentModel || !availableModels.some((model) => model.modelId === currentModel)) throw new Error(`Kiro ACP model state unavailable: ${JSON.stringify(sessionResponse)}`)
  const currentEffort = [...initial].reverse().find((event) => typeof event.payload?.effort === 'string')?.payload?.effort
  if (!currentEffort) throw new Error('Kiro ACP effort state unavailable')

  const runCommand = async (message, expected) => {
    const before = await events()
    const beforeAssistant = before.filter((event) => event.kind === 'assistant.message').length
    const beforeCompleted = before.filter((event) => event.kind === 'turn.completed').length
    await request(`/v1/runs/${runId}/input`, {
      method: 'POST',
      body: JSON.stringify({ message, delivery: 'auto', request_id: crypto.randomUUID() }),
    })
    return waitFor(async () => {
      const list = await events()
      const assistant = list.filter((event) => event.kind === 'assistant.message').slice(beforeAssistant).map((event) => String(event.payload?.text || '')).join('')
      const completed = list.filter((event) => event.kind === 'turn.completed').length > beforeCompleted
      return completed && expected.test(assistant) ? { list, assistant } : false
    })
  }

  await runCommand('/model', new RegExp(currentModel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  await runCommand(`/model ${currentModel}`, new RegExp(`Model changed to ${currentModel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i'))
  await runCommand('/effort', /Available effort levels/i)
  await runCommand(`/effort ${currentEffort}`, new RegExp(`Effort set to ${currentEffort}`, 'i'))
  await runCommand('/compact', /compact/i)
  await runCommand('/usage', /Plan:|usage/i)

  const usage = await waitFor(async () => {
    const list = await events()
    return list.find((event) => event.kind === 'usage.updated') || false
  })
  if (!Number.isFinite(Number(usage.payload?.context_usage_percentage))) throw new Error(`usage card did not include a context snapshot: ${JSON.stringify(usage)}`)

  await waitFor(async () => {
    const current = await request(`/v1/runs/${runId}`)
    return current.status === 'waiting_for_input' ? current : false
  })
  await request(`/v1/runs/${runId}/terminate`, { method: 'POST', body: '{}' })
  await waitFor(async () => {
    const current = await request(`/v1/runs/${runId}`)
    return ['completed', 'failed', 'terminated', 'interrupted'].includes(current.status) ? current : false
  }, 30000)

  const resumed = await request('/v1/runs', {
    method: 'POST',
    body: JSON.stringify({
      project_id: project.id,
      provider: 'kiro',
      prompt: 'Reply with exactly KIRO_CODESK_RESUME_OK and nothing else. Do not use tools.',
      workspace_mode: 'current_checkout',
      operation: 'resume',
      resume_session_id: sessionId,
    }),
  })
  const resumedEvents = () => request(`/v1/runs/${resumed.id}/events`)
  await waitFor(async () => {
    const list = await resumedEvents()
    const assistant = list
      .filter((event) => event.kind === 'assistant.message')
      .map((event) => String(event.payload?.text || ''))
      .join('')
    return assistant.includes('KIRO_CODESK_RESUME_OK')
  })
  await request(`/v1/runs/${resumed.id}/terminate`, { method: 'POST', body: '{}' })
  console.log(JSON.stringify({ ok: true, provider: 'kiro', sessionId, commands: commandNames.length, model: currentModel, effort: currentEffort, usage: { context_usage_percentage: usage.payload.context_usage_percentage, metering_usage: usage.payload.metering_usage } }))
} catch (error) {
  failed = true
  if (runId) {
    try {
      const list = await request(`/v1/runs/${runId}/events`)
      console.error(JSON.stringify({ error: String(error), events: list.map((event) => ({ kind: event.kind, text: event.payload?.text, status: event.payload?.status, provider_event_type: event.provider_event_type })) }))
    } catch {}
  }
  throw error
} finally {
  if (daemon.exitCode === null) daemon.kill('SIGTERM')
  if (!failed) await rm(root, { recursive: true, force: true })
  else console.error(`live test data retained at ${root}`)
}
