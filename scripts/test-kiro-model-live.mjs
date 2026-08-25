import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { spawn } from 'node:child_process'
import { daemonAuth } from './daemon-token.mjs'

const exec = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), 'codesk-kiro-model-live-'))
const port = 46000 + Math.floor(Math.random() * 1000)
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
  throw new Error('timed out waiting for Kiro model state')
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
try {
  await waitFor(async () => {
    try { return (await request('/v1/health')).ok } catch { return false }
  }, 30000)
  const project = await request('/v1/projects', {
    method: 'POST',
    body: JSON.stringify({ name: 'Codesk Kiro model live test', path: process.cwd() }),
  })
  const run = await request('/v1/runs', {
    method: 'POST',
    body: JSON.stringify({
      project_id: project.id,
      provider: 'kiro',
      prompt: 'Reply with exactly KIRO_MODEL_OK and nothing else. Do not use tools.',
      workspace_mode: 'current_checkout',
    }),
  })
  runId = run.id
  const activeRun = await waitFor(async () => {
    const current = await request(`/v1/runs/${runId}`)
    if (current.status !== 'waiting_for_input' || !current.tmux_name || !current.provider_session_id) return false
    return (await capture(current.tmux_name)).split('KIRO_MODEL_OK').length >= 3 ? current : false
  })

  // The live model and effort must reach the session payload, or the composer
  // cannot show which model is running.
  const session = await waitFor(async () => {
    const sessions = await request(`/v1/projects/${project.id}/sessions?refresh=true&limit=30`)
    const match = sessions.find((item) => item.native_session_id === activeRun.provider_session_id)
    return match?.model && match.effort ? match : false
  }, 60000)

  const catalog = await request(`/v1/runs/${runId}/models`, { method: 'POST', body: '{}' })
  const models = catalog.models
  // Kiro shows only eight rows per page, so anything at or below that means the
  // picker was never paged past the first screen.
  if (!Array.isArray(models) || models.length <= 8) throw new Error(`model catalog was not fully paged: ${JSON.stringify(models.map((model) => model.id))}`)
  if (new Set(models.map((model) => model.id)).size !== models.length) throw new Error('model catalog contains duplicates')
  if (models.some((model) => !model.id || /\s/.test(model.id))) throw new Error(`model catalog has malformed ids: ${JSON.stringify(models)}`)
  if (!models.some((model) => model.id === session.model)) {
    throw new Error(`catalog omits the running model ${session.model}: ${models.map((model) => model.id).join(', ')}`)
  }
  // The composer offers the levels the harness reports, not a hardcoded list.
  const efforts = (catalog.efforts || []).map((item) => item.id)
  for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
    if (!efforts.includes(level)) throw new Error(`missing reasoning level ${level}: ${JSON.stringify(catalog.efforts)}`)
  }
  if (catalog.model !== session.model) {
    throw new Error(`the catalog reports a different live model than the session: ${catalog.model} !== ${session.model}`)
  }

  // Switching must take effect on the harness and be visible again as state.
  const target = models.find((model) => model.id !== session.model && !model.id.startsWith('auto'))
  const appliedModel = await request(`/v1/runs/${runId}/model`, {
    method: 'POST',
    body: JSON.stringify({ model: target.id }),
  })
  if (appliedModel.model !== target.id) throw new Error(`model did not change: ${JSON.stringify(appliedModel)}`)
  const switched = await waitFor(async () => {
    const sessions = await request(`/v1/projects/${project.id}/sessions?refresh=true&limit=30`)
    const match = sessions.find((item) => item.native_session_id === activeRun.provider_session_id)
    return match?.model === target.id ? match : false
  }, 60000)

  const effort = session.effort === 'high' ? 'medium' : 'high'
  const appliedEffort = await request(`/v1/runs/${runId}/model`, {
    method: 'POST',
    body: JSON.stringify({ effort }),
  })
  if (appliedEffort.effort !== effort) throw new Error(`effort did not change: ${JSON.stringify(appliedEffort)}`)
  if (appliedEffort.model !== target.id) throw new Error(`changing the effort moved the model: ${JSON.stringify(appliedEffort)}`)
  await waitFor(async () => {
    const sessions = await request(`/v1/projects/${project.id}/sessions?refresh=true&limit=30`)
    const match = sessions.find((item) => item.native_session_id === activeRun.provider_session_id)
    return match?.effort === effort
  }, 60000)

  // The picker must be dismissed and the pane still steerable afterwards.
  const marker = `KIRO_AFTER_MODEL_${Math.floor(Math.random() * 1e6)}`
  await request(`/v1/runs/${runId}/input`, {
    method: 'POST',
    body: JSON.stringify({ message: `Reply with exactly ${marker} and nothing else.`, delivery: 'steer', request_id: crypto.randomUUID() }),
  })
  await waitFor(async () => (await capture(activeRun.tmux_name)).split(marker).length >= 3)

  console.log(JSON.stringify({
    ok: true,
    provider: 'kiro',
    transport: 'tmux',
    models: models.length,
    startedOn: session.model,
    switchedTo: switched.model,
    effort,
    steerAfterSwitch: true,
  }))
} catch (error) {
  failed = true
  throw error
} finally {
  if (runId) {
    try { await request(`/v1/runs/${runId}/terminate`, { method: 'POST', body: '{}' }) } catch {}
  }
  if (daemon.exitCode === null) daemon.kill('SIGTERM')
  if (!failed) await rm(root, { recursive: true, force: true })
  else console.error(`live test data retained at ${root}`)
}
