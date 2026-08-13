import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = process.cwd()
const binary = path.join(root, 'target/debug/codeskd')
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codesk-survival-'))
const port = 4300 + Math.floor(Math.random() * 400)
const base = `http://127.0.0.1:${port}`
let daemon

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function request(route, options) {
  const response = await fetch(`${base}${route}`, { ...options, headers: { 'content-type': 'application/json', ...options?.headers } })
  const body = await response.json()
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
  return body
}
async function healthy() { for (let i = 0; i < 60; i++) { try { await request('/v1/health'); return } catch { await wait(100) } } throw new Error('daemon did not become healthy') }
function startDaemon() { daemon = spawn(binary, [], { env: { ...process.env, CODESK_DATA_DIR: dataDir, CODESK_PORT: String(port) }, stdio: 'ignore' }) }

try {
  startDaemon(); await healthy()
  const project = await request('/v1/projects', { method: 'POST', body: JSON.stringify({ name: 'codesk-test', path: root }) })
  const run = await request('/v1/runs', { method: 'POST', body: JSON.stringify({ project_id: project.id, provider: 'shell', prompt: 'daemon restart survival', workspace_mode: 'current_checkout', command: 'sh', args: ['-c', "trap 'echo interrupted; exit 130' INT; i=0; while true; do i=$((i+1)); echo durable-$i; sleep 0.2; done"] }) })
  await wait(700)
  daemon.kill('SIGINT'); await new Promise((resolve) => daemon.once('exit', resolve))
  await wait(500)
  process.kill(run.pid, 0)
  startDaemon(); await healthy(); await wait(500)
  const recovered = await request(`/v1/runs/${run.id}`)
  if (recovered.status !== 'running') throw new Error(`expected running after restart, got ${recovered.status}`)
  const before = await request(`/v1/runs/${run.id}/events?after=0`)
  if (before.filter((event) => event.kind === 'output').length < 3) throw new Error('missing replayed output')
  await request(`/v1/runs/${run.id}/interrupt`, { method: 'POST', body: '{}' })
  await wait(700)
  const finished = await request(`/v1/runs/${run.id}`)
  if (finished.status !== 'interrupted' || finished.exit_code !== 130) throw new Error(`unexpected terminal state ${finished.status}/${finished.exit_code}`)
  const after = await request(`/v1/runs/${run.id}/events?after=0`)
  const sequences = after.map((event) => event.run_sequence)
  if (new Set(sequences).size !== sequences.length) throw new Error('duplicate event sequence')
  console.log(`ok - daemon restart preserved run ${run.id}, replayed ${after.length} events, and interrupted cleanly`)
} finally {
  if (daemon && daemon.exitCode === null) daemon.kill('SIGINT')
  await fs.rm(dataDir, { recursive: true, force: true })
}
