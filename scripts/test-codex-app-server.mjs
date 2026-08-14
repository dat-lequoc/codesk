import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const root = process.cwd()
const binary = path.join(root, 'target/debug/codeskd')
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'codesk-codex-app-server-'))
const dataDir = path.join(temp, 'data')
const binDir = path.join(temp, 'bin')
const fakeCodex = path.join(binDir, 'codex')
const port = 4700 + Math.floor(Math.random() * 200)
const base = `http://127.0.0.1:${port}`
let daemon
let managedRun
const exec = promisify(execFile)

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function request(route, options) {
  const response = await fetch(`${base}${route}`, { ...options, headers: { 'content-type': 'application/json', ...options?.headers } })
  const body = await response.json()
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
  return body
}
async function healthy() { for (let i = 0; i < 80; i++) { try { await request('/v1/health'); return } catch { await wait(100) } } throw new Error('daemon did not become healthy') }
async function events(runId) { return request(`/v1/runs/${runId}/events?after=0`) }
async function waitFor(runId, predicate, description) {
  for (let i = 0; i < 100; i++) {
    const current = await events(runId)
    const found = current.find(predicate)
    if (found) return found
    await wait(100)
  }
  throw new Error(`timed out waiting for ${description}`)
}
async function waitForStatus(runId, status) {
  for (let i = 0; i < 100; i++) {
    const run = await request(`/v1/runs/${runId}`)
    if (run.status === status) return run
    await wait(100)
  }
  throw new Error(`timed out waiting for run status ${status}`)
}

await fs.mkdir(binDir, { recursive: true })
await fs.writeFile(fakeCodex, `#!/usr/bin/env node
import readline from 'node:readline'
let thread = null
let threadCounter = 0
let turnCounter = 0
let activeTurn = null
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
const lines = readline.createInterface({ input: process.stdin })
lines.on('line', (line) => {
  const message = JSON.parse(line)
  if (!message.method && (message.id === 'approval-1' || message.id === 'input-1')) {
    send({ method: 'serverRequest/resolved', params: { threadId: thread, requestId: message.id } })
    return
  }
  const { id, method, params = {} } = message
  if (method === 'initialize') send({ id, result: { userAgent: 'fake', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'linux' } })
  else if (method === 'initialized') {}
  else if (method === 'thread/start') { thread = 'thread-' + (++threadCounter); send({ id, result: { thread: { id: thread, turns: [] }, model: 'fake', modelProvider: 'fake', cwd: params.cwd } }) }
  else if (method === 'thread/resume') { thread = params.threadId; send({ id, result: { thread: { id: thread, turns: [] }, model: 'fake', modelProvider: 'fake', cwd: params.cwd } }) }
  else if (method === 'thread/fork') { if (!params.lastTurnId || 'beforeTurnId' in params) send({ id, error: { code: -32602, message: 'lastTurnId is required by this fake' } }); else { thread = 'thread-' + (++threadCounter); send({ id, result: { thread: { id: thread, turns: [] }, model: 'fake', modelProvider: 'fake', cwd: params.cwd } }) } }
  else if (method === 'turn/start') {
    activeTurn = 'turn-' + (++turnCounter)
    send({ id, result: { turn: { id: activeTurn, status: 'inProgress', items: [] } } })
    send({ method: 'turn/started', params: { threadId: thread, turn: { id: activeTurn, status: 'inProgress', items: [] } } })
    send({ method: 'item/completed', params: { threadId: thread, turnId: activeTurn, item: { id: 'user-' + turnCounter, type: 'userMessage', content: [{ type: 'text', text: params.input[0].text }] } } })
    send({ method: 'item/agentMessage/delta', params: { threadId: thread, turnId: activeTurn, itemId: 'assistant-' + turnCounter, delta: 'working on ' + params.input[0].text } })
  }
  else if (method === 'turn/steer') {
    send({ id, result: { turnId: activeTurn } })
    send({ method: 'item/completed', params: { threadId: thread, turnId: activeTurn, item: { id: 'steer-' + turnCounter, type: 'userMessage', content: [{ type: 'text', text: params.input[0].text }] } } })
    if (params.input[0].text === 'needs approval') send({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { threadId: thread, turnId: activeTurn, itemId: 'cmd-1', command: 'npm test', reason: 'Run the test suite' } })
    if (params.input[0].text === 'needs input') send({ id: 'input-1', method: 'item/tool/requestUserInput', params: { threadId: thread, turnId: activeTurn, itemId: 'ask-1', isBlocking: true, questions: [{ id: 'scope', header: 'Scope', question: 'Which scope?', options: [{ label: 'Focused', description: 'Only the target area' }] }] } })
    if (params.input[0].text === 'finish current') { send({ method: 'turn/completed', params: { threadId: thread, turn: { id: activeTurn, status: 'completed', items: [] } } }); activeTurn = null }
  }
  else if (method === 'turn/interrupt') {
    send({ id, result: {} })
    send({ method: 'turn/completed', params: { threadId: thread, turn: { id: activeTurn, status: 'interrupted', items: [] } } })
    activeTurn = null
  }
})
`, { mode: 0o755 })

function startDaemon() {
  daemon = spawn(binary, [], { env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, CODESK_DATA_DIR: dataDir, CODESK_PORT: String(port) }, stdio: 'ignore' })
}
async function stopDaemon() {
  if (!daemon || daemon.exitCode !== null) return
  let command; let owner; let parent
  if (process.platform === 'linux') {
    command = await fs.readFile(`/proc/${daemon.pid}/cmdline`, 'utf8')
    const status = await fs.readFile(`/proc/${daemon.pid}/status`, 'utf8')
    const stat = await fs.readFile(`/proc/${daemon.pid}/stat`, 'utf8')
    owner = Number(status.match(/^Uid:\s+(\d+)/m)?.[1])
    parent = Number(stat.split(' ')[3])
  } else {
    const { stdout } = await exec('ps', ['-o', 'ppid=', '-o', 'uid=', '-o', 'command=', '-p', String(daemon.pid)])
    const match = stdout.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
    parent = Number(match?.[1]); owner = Number(match?.[2]); command = match?.[3] || ''
  }
  assert(command.includes('codeskd'), `refusing to stop unexpected process ${command}`)
  assert.equal(owner, process.getuid(), 'daemon process owner changed')
  assert.equal(parent, process.pid, 'daemon is no longer the test process child')
  daemon.kill('SIGINT')
  await new Promise((resolve) => daemon.once('exit', resolve))
}
async function stopManagedRun() {
  if (!managedRun?.pid || !managedRun?.process_group_id) return
  try { await request(`/v1/runs/${managedRun.id}/terminate`, { method: 'POST', body: '{}' }) } catch {}
  for (let attempt = 0; attempt < 30; attempt++) {
    try { process.kill(managedRun.pid, 0) } catch { return }
    await wait(100)
  }
  const command = await fs.readFile(`/proc/${managedRun.pid}/cmdline`, 'utf8')
  const status = await fs.readFile(`/proc/${managedRun.pid}/status`, 'utf8')
  const stat = await fs.readFile(`/proc/${managedRun.pid}/stat`, 'utf8')
  assert(command.includes('codeskd\0__runner') && command.includes(path.join(dataDir, 'runs', managedRun.id)), `refusing to stop unexpected runner ${command}`)
  assert.equal(Number(status.match(/^Uid:\s+(\d+)/m)?.[1]), process.getuid(), 'runner process owner changed')
  assert.equal(Number(stat.split(' ')[4]), managedRun.process_group_id, 'runner process group changed')
  process.kill(-managedRun.process_group_id, 'SIGTERM')
  for (let attempt = 0; attempt < 30; attempt++) { try { process.kill(managedRun.pid, 0) } catch { return }; await wait(100) }
  throw new Error('managed test runner did not stop')
}

try {
  startDaemon()
  await healthy()
  const project = await request('/v1/projects', { method: 'POST', body: JSON.stringify({ name: 'codex-bridge-test', path: root }) })
  const run = managedRun = await request('/v1/runs', { method: 'POST', body: JSON.stringify({ project_id: project.id, provider: 'codex', prompt: 'initial task', workspace_mode: 'current_checkout' }) })
  await waitFor(run.id, (event) => event.kind === 'thread.session' && event.raw_payload?.sessionId === 'thread-1', 'Codex thread session')
  await waitFor(run.id, (event) => event.kind === 'assistant.message' && event.payload.text === 'working on initial task', 'assistant stream')
  await waitFor(run.id, (event) => event.kind === 'user.message' && event.payload.text === 'initial task', 'user message with turn boundary')
  assert.equal((await request(`/v1/runs/${run.id}`)).status, 'running')
  await request(`/v1/runs/${run.id}/input`, { method: 'POST', body: JSON.stringify({ message: 'queued next', request_id: 'queue-1', delivery: 'queue' }) })
  await waitFor(run.id, (event) => event.kind === 'input.accepted' && event.raw_payload?.requestId === 'queue-1' && event.raw_payload?.action === 'queue', 'queue acknowledgment')
  const queued = await waitFor(run.id, (event) => event.kind === 'queue.added' && event.payload.text === 'queued next', 'durable queue item')
  assert.equal(typeof queued.payload.queue_id, 'string')
  await stopDaemon()
  process.kill(run.pid, 0)
  startDaemon()
  await healthy()
  assert.equal((await request(`/v1/runs/${run.id}`)).status, 'running', 'Codex bridge was not recovered after daemon restart')

  await request(`/v1/runs/${run.id}/input`, { method: 'POST', body: JSON.stringify({ message: 'steer now', request_id: 'steer-1', delivery: 'auto' }) })
  await waitFor(run.id, (event) => event.kind === 'input.accepted' && event.raw_payload?.requestId === 'steer-1' && event.raw_payload?.action === 'steer', 'steering acknowledgment')

  await request(`/v1/runs/${run.id}/input`, { method: 'POST', body: JSON.stringify({ message: 'finish current', request_id: 'finish-1', delivery: 'steer' }) })
  await waitFor(run.id, (event) => event.kind === 'queue.started' && event.payload.queue_id === queued.payload.queue_id, 'automatic queued turn start')
  await waitFor(run.id, (event) => event.kind === 'user.message' && event.payload.text === 'queued next', 'queued user turn')

  await request(`/v1/runs/${run.id}/input`, { method: 'POST', body: JSON.stringify({ message: 'paused after interrupt', request_id: 'queue-2', delivery: 'queue' }) })
  const pausedItem = await waitFor(run.id, (event) => event.kind === 'queue.added' && event.raw_payload?.requestId === 'queue-2', 'second queued item')
  await request(`/v1/runs/${run.id}/interrupt`, { method: 'POST', body: '{}' })
  await waitFor(run.id, (event) => event.kind === 'queue.paused' && event.payload.queue_id === pausedItem.payload.queue_id, 'queue pause after interrupt')
  await waitForStatus(run.id, 'waiting_for_input')
  await request(`/v1/runs/${run.id}/queue/start`, { method: 'POST', body: '{}' })
  await waitFor(run.id, (event) => event.kind === 'queue.started' && event.payload.queue_id === pausedItem.payload.queue_id, 'manual queued turn start')
  await waitFor(run.id, (event) => event.kind === 'user.message' && event.payload.text === 'paused after interrupt', 'manually started queued turn')
  await request(`/v1/runs/${run.id}/input`, { method: 'POST', body: JSON.stringify({ message: 'remove me', request_id: 'queue-remove', delivery: 'queue' }) })
  const removable = await waitFor(run.id, (event) => event.kind === 'queue.added' && event.raw_payload?.requestId === 'queue-remove', 'removable queued item')
  await request(`/v1/runs/${run.id}/queue/${encodeURIComponent(removable.payload.queue_id)}`, { method: 'DELETE' })
  await waitFor(run.id, (event) => event.kind === 'queue.removed' && event.payload.queue_id === removable.payload.queue_id, 'queued item removal')

  await request(`/v1/runs/${run.id}/input`, { method: 'POST', body: JSON.stringify({ message: 'needs approval', request_id: 'approval-steer', delivery: 'steer' }) })
  const approval = await waitFor(run.id, (event) => event.kind === 'approval.required', 'approval request')
  assert.equal(approval.payload.rpc_id, 'approval-1')
  await request(`/v1/runs/${run.id}/response`, { method: 'POST', body: JSON.stringify({ rpc_id: approval.payload.rpc_id, result: { decision: 'accept' } }) })
  await waitFor(run.id, (event) => event.provider_event_type === 'codex.serverRequest/resolved' && event.payload.request_id === 'approval-1', 'approval resolution')
  await request(`/v1/runs/${run.id}/input`, { method: 'POST', body: JSON.stringify({ message: 'needs input', request_id: 'input-steer', delivery: 'steer' }) })
  const input = await waitFor(run.id, (event) => event.kind === 'input.required' && event.payload.rpc_id === 'input-1', 'request-user-input event')
  assert.equal(input.payload.text, 'Which scope?')
  await request(`/v1/runs/${run.id}/response`, { method: 'POST', body: JSON.stringify({ rpc_id: input.payload.rpc_id, result: { answers: { scope: { answers: ['Focused'] } } } }) })
  await waitFor(run.id, (event) => event.provider_event_type === 'codex.serverRequest/resolved' && event.payload.request_id === 'input-1', 'request-user-input resolution')

  await request(`/v1/runs/${run.id}/interrupt`, { method: 'POST', body: '{}' })
  await waitFor(run.id, (event) => event.kind === 'control.acknowledged' && event.raw_payload?.action === 'interrupt', 'native interrupt acknowledgment')
  await waitForStatus(run.id, 'waiting_for_input')

  await request(`/v1/runs/${run.id}/input`, { method: 'POST', body: JSON.stringify({ message: 'invalid idle steer', request_id: 'idle-steer', delivery: 'steer' }) })
  await waitFor(run.id, (event) => event.kind === 'input.rejected' && event.raw_payload?.requestId === 'idle-steer', 'idle steering rejection')
  await request(`/v1/runs/${run.id}/input`, { method: 'POST', body: JSON.stringify({ message: 'second turn', request_id: 'turn-2', delivery: 'auto' }) })
  await waitFor(run.id, (event) => event.kind === 'input.accepted' && event.raw_payload?.requestId === 'turn-2' && event.raw_payload?.action === 'start', 'idle turn start acknowledgment')
  await request(`/v1/runs/${run.id}/interrupt`, { method: 'POST', body: '{}' })
  await waitForStatus(run.id, 'waiting_for_input')

  await request(`/v1/runs/${run.id}/input`, { method: 'POST', body: JSON.stringify({ message: 'edited queued task', request_id: 'fork-1', delivery: 'fork', last_turn_id: 'turn-1' }) })
  const forkedSession = await waitFor(run.id, (event) => event.kind === 'thread.session' && event.raw_payload?.sessionId === 'thread-2', 'forked thread session')
  assert.equal(forkedSession.payload.last_turn_id, 'turn-1')
  await waitFor(run.id, (event) => event.kind === 'input.accepted' && event.raw_payload?.requestId === 'fork-1' && event.raw_payload?.action === 'fork', 'fork-before acknowledgment')
  assert.equal((await request(`/v1/runs/${run.id}`)).provider_session_id, 'thread-2')

  await request(`/v1/runs/${run.id}/interrupt`, { method: 'POST', body: '{}' })
  await waitForStatus(run.id, 'waiting_for_input')
  await request(`/v1/runs/${run.id}/input`, { method: 'POST', body: JSON.stringify({ message: 'edited first task', request_id: 'rewind-first', delivery: 'fork', last_turn_id: null }) })
  const freshSession = await waitFor(run.id, (event) => event.kind === 'thread.session' && event.raw_payload?.sessionId === 'thread-3', 'fresh thread for first-prompt rewind')
  assert.equal(freshSession.payload.last_turn_id, null)
  await waitFor(run.id, (event) => event.kind === 'input.accepted' && event.raw_payload?.requestId === 'rewind-first', 'first-prompt rewind acknowledgment')

  await request(`/v1/runs/${run.id}/terminate`, { method: 'POST', body: '{}' })
  await waitForStatus(run.id, 'interrupted')
  console.log('ok - Codex app-server bridge steers, queues durably, responds, interrupts, continues, and rewinds at stable turn boundaries')
} finally {
  let cleanupError
  try { await stopManagedRun() } catch (error) { cleanupError ||= error }
  try { await stopDaemon() } catch (error) { cleanupError ||= error }
  try { await fs.rm(temp, { recursive: true, force: true }) } catch (error) { cleanupError ||= error }
  if (cleanupError) throw cleanupError
}
