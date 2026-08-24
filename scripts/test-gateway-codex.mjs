import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { daemonAuth } from './daemon-token.mjs'

const root = process.cwd()
const binary = path.join(root, 'target/debug/codeskd')
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'codesk-gateway-codex-'))
const daemonData = path.join(temp, 'daemon-data')
const clientData = path.join(temp, 'client-data')
const binDir = path.join(temp, 'bin')
const fakeCodex = path.join(binDir, 'codex')
const daemonPort = 4900 + Math.floor(Math.random() * 100)
const gatewayPort = 5000 + Math.floor(Math.random() * 100)
const daemonBase = `http://127.0.0.1:${daemonPort}`
const gatewayBase = `http://127.0.0.1:${gatewayPort}`
let daemon
let gateway
let managedRun
const exec = promisify(execFile)

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function jsonRequest(base, route, options) {
  const response = await fetch(`${base}${route}`, { ...options, headers: { 'content-type': 'application/json', ...(base === daemonBase ? daemonAuth(daemonData) : {}), ...options?.headers } })
  const body = await response.json()
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
  return body
}
async function waitFor(description, callback) {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const value = await callback()
      if (value) return value
    } catch {}
    await wait(100)
  }
  throw new Error(`timed out waiting for ${description}`)
}
async function verifyOwnedChild(child, expected) {
  assert(child && child.exitCode === null, `${expected} is not running`)
  let command; let owner; let parent
  if (process.platform === 'linux') {
    command = await fs.readFile(`/proc/${child.pid}/cmdline`, 'utf8')
    const status = await fs.readFile(`/proc/${child.pid}/status`, 'utf8')
    const stat = await fs.readFile(`/proc/${child.pid}/stat`, 'utf8')
    owner = Number(status.match(/^Uid:\s+(\d+)/m)?.[1])
    parent = Number(stat.split(' ')[3])
  } else {
    const { stdout } = await exec('ps', ['-o', 'ppid=', '-o', 'uid=', '-o', 'command=', '-p', String(child.pid)])
    const match = stdout.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
    parent = Number(match?.[1]); owner = Number(match?.[2]); command = match?.[3] || ''
  }
  assert(command.includes(expected), `refusing to stop unexpected process ${command}`)
  assert.equal(owner, process.getuid(), `${expected} owner changed`)
  assert.equal(parent, process.pid, `${expected} is no longer the test process child`)
}
async function stopOwned(child, expected) {
  if (!child || child.exitCode !== null) return
  await verifyOwnedChild(child, expected)
  child.kill('SIGINT')
  await new Promise((resolve) => child.once('exit', resolve))
}
async function stopManagedRun() {
  if (!managedRun?.pid || !managedRun?.processGroupId) return
  try { await jsonRequest(daemonBase, `/v1/runs/${managedRun.id}/terminate`, { method: 'POST', body: '{}' }) } catch {}
  for (let attempt = 0; attempt < 30; attempt++) {
    try { process.kill(managedRun.pid, 0) } catch { return }
    await wait(100)
  }
  let command; let owner; let processGroupId
  if (process.platform === 'linux') {
    command = await fs.readFile(`/proc/${managedRun.pid}/cmdline`, 'utf8')
    const status = await fs.readFile(`/proc/${managedRun.pid}/status`, 'utf8')
    const stat = await fs.readFile(`/proc/${managedRun.pid}/stat`, 'utf8')
    owner = Number(status.match(/^Uid:\s+(\d+)/m)?.[1])
    processGroupId = Number(stat.split(' ')[4])
  } else {
    const { stdout } = await exec('ps', ['-o', 'uid=', '-o', 'pgid=', '-o', 'command=', '-p', String(managedRun.pid)])
    const match = stdout.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
    owner = Number(match?.[1]); processGroupId = Number(match?.[2]); command = match?.[3] || ''
  }
  assert(command.includes('codeskd') && command.includes('__runner') && command.includes(path.join(daemonData, 'runs', managedRun.id)), `refusing to stop unexpected runner ${command}`)
  assert.equal(owner, process.getuid(), 'runner process owner changed')
  assert.equal(processGroupId, managedRun.processGroupId, 'runner process group changed')
  process.kill(-managedRun.processGroupId, 'SIGTERM')
  for (let attempt = 0; attempt < 30; attempt++) { try { process.kill(managedRun.pid, 0) } catch { return }; await wait(100) }
  throw new Error('managed gateway test runner did not stop')
}

await fs.mkdir(binDir, { recursive: true })
await fs.mkdir(clientData, { recursive: true })
await fs.writeFile(fakeCodex, `#!/usr/bin/env node
import readline from 'node:readline'
let thread = 'gateway-thread'
let turn = null
let counter = 0
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params = {} } = JSON.parse(line)
  if (method === 'initialize') send({ id, result: { userAgent: 'fake', platformFamily: 'unix', platformOs: 'linux' } })
  else if (method === 'initialized') {}
  else if (method === 'thread/start') send({ id, result: { thread: { id: thread, turns: [] } } })
  else if (method === 'thread/resume') { thread = params.threadId; send({ id, result: { thread: { id: thread, turns: [] } } }) }
  else if (method === 'turn/start') {
    turn = 'gateway-turn-' + (++counter)
    send({ id, result: { turn: { id: turn, status: 'inProgress', items: [] } } })
    send({ method: 'turn/started', params: { threadId: thread, turn: { id: turn, status: 'inProgress', items: [] } } })
    send({ method: 'item/completed', params: { threadId: thread, turnId: turn, item: { id: 'user-' + counter, type: 'userMessage', content: [{ type: 'text', text: params.input[0].text }] } } })
    send({ method: 'item/agentMessage/delta', params: { threadId: thread, turnId: turn, itemId: 'agent-' + counter, delta: 'gateway:' + params.input[0].text } })
  }
  else if (method === 'turn/steer') {
    send({ id, result: { turnId: turn } })
    send({ method: 'item/completed', params: { threadId: thread, turnId: turn, item: { id: 'steer-' + counter + '-' + Date.now(), type: 'userMessage', content: [{ type: 'text', text: params.input[0].text }] } } })
    send({ method: 'item/agentMessage/delta', params: { threadId: thread, turnId: turn, itemId: 'agent-' + counter, delta: '|gateway:' + params.input[0].text } })
  }
  else if (method === 'turn/interrupt') {
    send({ id, result: {} })
    send({ method: 'turn/completed', params: { threadId: thread, turn: { id: turn, status: 'interrupted', items: [] } } })
    turn = null
  }
})
`, { mode: 0o755 })
await fs.writeFile(path.join(clientData, 'client-state.json'), JSON.stringify({
  hosts: [{ id: 'local', name: 'Gateway test', type: 'local', daemonPort, status: 'checking', createdAt: new Date().toISOString() }],
  drafts: [],
  settings: { notifications: false },
}, null, 2))

function startDaemon() {
  daemon = spawn(binary, [], { env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, CODESK_DATA_DIR: daemonData, CODESK_PORT: String(daemonPort), CODESK_RUN_TRANSPORT: 'structured' }, stdio: 'ignore' })
}
function startGateway() {
  gateway = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env: { ...process.env, PORT: String(gatewayPort), CODESK_CLIENT_DATA_DIR: clientData, CODESK_DATA_DIR: daemonData, CODESK_DAEMON_BINARY: binary }, stdio: 'ignore' })
}

try {
  startDaemon()
  await waitFor('daemon health', () => jsonRequest(daemonBase, '/v1/health'))
  startGateway()
  await waitFor('gateway host connection', async () => (await jsonRequest(gatewayBase, '/api/state')).hosts.find((host) => host.id === 'local' && host.status === 'online'))

  const project = await jsonRequest(gatewayBase, '/api/projects', { method: 'POST', body: JSON.stringify({ hostId: 'local', name: 'gateway-codex', path: root }) })
  await jsonRequest(gatewayBase, '/api/state')
  const navigation = await jsonRequest(gatewayBase, '/api/navigation')
  assert(navigation.projects.some((item) => item.id === project.id), 'fast navigation snapshot did not retain the project')
  const run = managedRun = await jsonRequest(gatewayBase, '/api/runs', { method: 'POST', body: JSON.stringify({ hostId: 'local', project_id: project.id, provider: 'codex', prompt: 'through gateway', workspace_mode: 'current_checkout' }) })
  const immediateRunState = await jsonRequest(gatewayBase, '/api/state')
  assert(immediateRunState.runs.some((item) => item.id === run.id), 'new run was missing from the immediate gateway state snapshot')
  await waitFor('gateway event stream', async () => (await jsonRequest(gatewayBase, `/api/runs/local/${run.id}/events?after=0`)).find((event) => event.kind === 'assistant.message' && event.payload.text === 'gateway:through gateway'))

  await stopOwned(gateway, 'server/index.mjs')
  process.kill(run.pid, 0)
  await jsonRequest(daemonBase, `/v1/runs/${run.id}/input`, { method: 'POST', body: JSON.stringify({ message: 'while gateway was offline', request_id: 'offline-steer', delivery: 'steer' }) })
  await waitFor('offline steer on durable runner', async () => (await jsonRequest(daemonBase, `/v1/runs/${run.id}/events?after=0`)).find((event) => event.kind === 'assistant.message' && event.payload.text === '|gateway:while gateway was offline'))

  startGateway()
  await waitFor('gateway reconnect', async () => (await jsonRequest(gatewayBase, '/api/state')).hosts.find((host) => host.id === 'local' && host.status === 'online'))
  const replay = await jsonRequest(gatewayBase, `/api/runs/local/${run.id}/events?after=0`)
  assert(replay.some((event) => event.payload.text === '|gateway:while gateway was offline'), 'gateway did not replay events produced while disconnected')

  await jsonRequest(gatewayBase, `/api/runs/local/${run.id}/input`, { method: 'POST', body: JSON.stringify({ message: 'after gateway reconnect', request_id: 'reconnect-steer', delivery: 'auto' }) })
  await waitFor('post-reconnect steering', async () => (await jsonRequest(gatewayBase, `/api/runs/local/${run.id}/events?after=0`)).find((event) => event.kind === 'input.accepted' && event.raw_payload?.requestId === 'reconnect-steer'))
  await jsonRequest(gatewayBase, `/api/runs/local/${run.id}/interrupt`, { method: 'POST', body: '{}' })
  await waitFor('native interruption through gateway', async () => (await jsonRequest(gatewayBase, '/api/state')).runs.find((item) => item.id === run.id && item.status === 'waiting_for_input'))
  await jsonRequest(gatewayBase, `/api/runs/local/${run.id}/terminate`, { method: 'POST', body: '{}' })
  await waitFor('runner cleanup', async () => (await jsonRequest(gatewayBase, '/api/state')).runs.find((item) => item.id === run.id && item.status === 'interrupted'))

  const resumed = managedRun = await jsonRequest(gatewayBase, '/api/runs', { method: 'POST', body: JSON.stringify({ hostId: 'local', project_id: project.id, provider: 'codex', title: 'Historical conversation', prompt: 'continued from history', workspace_mode: 'current_checkout', operation: 'resume', resume_session_id: 'historical-thread' }) })
  assert.equal(resumed.sessionId, 'historical-thread')
  const immediateResumedState = await jsonRequest(gatewayBase, '/api/state')
  assert(immediateResumedState.runs.some((item) => item.id === resumed.id), 'resumed run was missing from the immediate gateway state snapshot')
  await waitFor('historical session continuation', async () => (await jsonRequest(gatewayBase, `/api/runs/local/${resumed.id}/events?after=0`)).find((event) => event.kind === 'assistant.message' && event.payload.text === 'gateway:continued from history'))
  await jsonRequest(gatewayBase, `/api/runs/local/${resumed.id}/terminate`, { method: 'POST', body: '{}' })
  await waitFor('resumed runner cleanup', async () => (await jsonRequest(gatewayBase, '/api/state')).runs.find((item) => item.id === resumed.id && item.status === 'interrupted'))

  await jsonRequest(gatewayBase, `/api/projects/local/${project.id}`, { method: 'DELETE' })
  const removed = await jsonRequest(gatewayBase, '/api/navigation')
  assert(!removed.projects.some((item) => item.id === project.id), 'removed project remained in the navigation cache')
  assert(!removed.runs.some((item) => item.projectId === project.id), 'removed project runs remained in navigation')
  const restored = await jsonRequest(gatewayBase, '/api/projects', { method: 'POST', body: JSON.stringify({ hostId: 'local', name: 'gateway-codex', path: root }) })
  assert.equal(restored.id, project.id, 're-adding a project should restore the existing registration and history')

  console.log('ok - gateway restart preserves Codex runners, historical sessions resume, and project removal updates navigation safely')
} finally {
  let cleanupError
  try { await stopManagedRun() } catch (error) { cleanupError ||= error }
  try { await stopOwned(gateway, 'server/index.mjs') } catch (error) { cleanupError ||= error }
  try { await stopOwned(daemon, 'codeskd') } catch (error) { cleanupError ||= error }
  try { await fs.rm(temp, { recursive: true, force: true }) } catch (error) { cleanupError ||= error }
  if (cleanupError) throw cleanupError
}
