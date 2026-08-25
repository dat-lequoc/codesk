// Live check that Codesk can read and change a Codex session's model and
// reasoning effort by driving Codex's own `/model` picker in a tmux pane.
// Requires a logged-in `codex` on PATH.
import { execFile, spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { daemonAuth } from './daemon-token.mjs'

const exec = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), 'codesk-codex-model-live-'))
const workspace = join(root, 'workspace')
await mkdir(workspace, { recursive: true })
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
const waitFor = async (predicate, timeoutMs = 120000, label = 'Codex model state') => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await sleep(500)
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

let runId
let failed = false
let lastCapture = ''
try {
  await waitFor(async () => {
    try { return (await request('/v1/health')).ok } catch { return false }
  }, 30000, 'the daemon')
  const project = await request('/v1/projects', {
    method: 'POST',
    body: JSON.stringify({ name: 'Codesk Codex model live test', path: workspace }),
  })
  const run = await request('/v1/runs', {
    method: 'POST',
    body: JSON.stringify({
      project_id: project.id,
      provider: 'codex',
      prompt: 'Reply with exactly CODEX_MODEL_OK and nothing else. Do not use tools.',
      workspace_mode: 'current_checkout',
    }),
  })
  runId = run.id
  const started = await waitFor(async () => {
    const current = await request(`/v1/runs/${runId}`)
    if (current.tmux_name) lastCapture = await capture(current.tmux_name)
    return current.input_transport === 'tmux' && current.tmux_name ? current : false
  }, 60000, 'a Codex tmux pane')

  // A new directory means Codex opens on its trust dialog, and a pending
  // release means it opens on an update notice. Both must be answered before
  // the composer exists, or the opening prompt is typed into a dialog instead
  // of being submitted.
  await waitFor(async () => {
    lastCapture = await capture(started.tmux_name)
    return lastCapture.includes('CODEX_MODEL_OK') && lastCapture.includes('% left')
  }, 120000, 'the opening prompt to reach the Codex composer')
  // Driving the picker needs an idle pane, and the opening turn is only here to
  // prove the prompt was submitted rather than typed into a dialog. Interrupt
  // it rather than waiting out a provider that is retrying a 503.
  const idle = async () => {
    lastCapture = await capture(started.tmux_name)
    return !lastCapture.includes('esc to interrupt')
  }
  const settled = await waitFor(idle, 45000, 'the opening turn to finish').catch(() => false)
  if (!settled) {
    await exec('tmux', ['-S', socket, 'send-keys', '-t', started.tmux_name, 'Escape'])
    await waitFor(idle, 30000, 'the interrupted turn to settle')
  }

  // Reading the catalog drives the picker, which refuses to run during a turn.
  const catalog = await waitFor(async () => {
    try { return await request(`/v1/runs/${runId}/models`, { method: 'POST', body: '{}' }) }
    catch (error) {
      lastCapture = await capture(started.tmux_name)
      if (!String(error.message).includes('busy')) throw error
      return false
    }
  }, 120000, 'an idle Codex pane')
  if (!catalog.models?.length) throw new Error(`no models were read: ${JSON.stringify(catalog)}`)
  const efforts = (catalog.efforts || []).map((item) => item.id)
  for (const level of ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']) {
    if (!efforts.includes(level)) throw new Error(`missing reasoning level ${level}: ${JSON.stringify(catalog.efforts)}`)
  }
  if (!catalog.model || !catalog.effort) {
    throw new Error(`the pane reported no live model or effort: ${JSON.stringify(catalog)}`)
  }

  // Max and Ultra sit behind a submenu, so change into one of them to prove the
  // whole picker is walkable, not just its first page.
  const nextEffort = catalog.effort === 'max' ? 'xhigh' : 'max'
  const changedEffort = await request(`/v1/runs/${runId}/model`, {
    method: 'POST',
    body: JSON.stringify({ effort: nextEffort }),
  })
  if (changedEffort.effort !== nextEffort) {
    throw new Error(`effort did not change: ${JSON.stringify(changedEffort)}`)
  }
  if (changedEffort.model !== catalog.model) {
    throw new Error(`changing the effort moved the model: ${JSON.stringify(changedEffort)}`)
  }

  const nextModel = catalog.models.map((item) => item.id).find((id) => id !== catalog.model)
  if (!nextModel) throw new Error('the catalog offers only one model')
  const changedModel = await request(`/v1/runs/${runId}/model`, {
    method: 'POST',
    body: JSON.stringify({ model: nextModel }),
  })
  if (changedModel.model !== nextModel) {
    throw new Error(`model did not change: ${JSON.stringify(changedModel)}`)
  }
  if (changedModel.effort !== nextEffort) {
    throw new Error(`changing the model dropped the reasoning level: ${JSON.stringify(changedModel)}`)
  }

  // A change made here must not wait out the discovery TTL before the rest of
  // Codesk sees it.
  const discovered = await waitFor(async () => {
    const agents = await request('/v1/agents/discover')
    const agent = agents.find((item) => item.tmux_session_name === started.tmux_name)
    return agent?.model === nextModel && agent?.effort === nextEffort ? agent : false
  }, 30000, 'discovery to report the change')

  // The pane must be left steerable, not sitting in a picker: a prompt sent
  // now has to be submitted rather than typed into a menu.
  const marker = `CODEX_AFTER_MODEL_${Math.floor(Math.random() * 1e6)}`
  await request(`/v1/runs/${runId}/input`, {
    method: 'POST',
    body: JSON.stringify({ message: `Reply with exactly ${marker} and nothing else.`, delivery: 'steer', request_id: crypto.randomUUID() }),
  })
  await waitFor(async () => {
    lastCapture = await capture(started.tmux_name)
    return lastCapture.includes(marker) && !lastCapture.includes(`Unrecognized`)
  }, 60000, 'the pane to accept a prompt after the change')

  console.log(JSON.stringify({
    ok: true,
    provider: 'codex',
    session: started.tmux_name,
    read: { model: catalog.model, effort: catalog.effort, models: catalog.models.length },
    effortChange: { to: nextEffort, viaSubmenu: nextEffort === 'max' },
    modelChange: { to: nextModel },
    discovered: { model: discovered.model, effort: discovered.effort },
    steerableAfterChange: true,
  }))
} catch (error) {
  failed = true
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
