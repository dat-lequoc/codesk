// Verifies that a web page cannot reach the gateway.
//
// The gateway listens on loopback and can start agents, install daemons, and
// stream everything those agents say. Any site the user visits can send it
// requests, so the only thing separating the Codesk UI from an attacker's page
// is the `Origin` header. Two transports have to enforce that independently:
// HTTP, and the /ws event stream, which browsers exempt from CORS entirely.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'

const root = process.cwd()
const binary = path.join(root, 'target/debug/codeskd')
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'codesk-origin-'))
const gatewayPort = 5200 + Math.floor(Math.random() * 200)
const daemonPort = 5400 + Math.floor(Math.random() * 200)
const base = `http://127.0.0.1:${gatewayPort}`
const clientData = path.join(temp, 'client')
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const evil = 'https://evil.example'
const trusted = ['tauri://localhost', 'http://tauri.localhost', 'http://localhost:5173', 'http://127.0.0.1:4242']

await fs.mkdir(clientData, { recursive: true })
await fs.writeFile(path.join(clientData, 'client-state.json'), JSON.stringify({
  hosts: [{ id: 'local', name: 'Origin test', type: 'local', daemonPort, status: 'checking', createdAt: new Date().toISOString() }],
  drafts: [],
  navigationByHost: {},
}))

const gateway = spawn(process.execPath, ['server/index.mjs'], {
  cwd: root,
  env: { ...process.env, PORT: String(gatewayPort), CODESK_CLIENT_DATA_DIR: clientData, CODESK_DATA_DIR: path.join(temp, 'daemon'), CODESK_DAEMON_BINARY: binary },
  stdio: 'ignore',
})

/// Resolves to the close code when the handshake is refused, so a rejection is
/// an ordinary result rather than an unhandled error.
function connect(origin) {
  return new Promise((resolve) => {
    const socket = new WebSocket(`${base}/ws`.replace('http', 'ws'), origin ? { origin } : undefined)
    const settle = (outcome) => { socket.removeAllListeners(); socket.close(); resolve(outcome) }
    socket.on('open', () => settle('open'))
    socket.on('error', (error) => settle(`refused: ${error.message}`))
    setTimeout(() => settle('timeout'), 5000)
  })
}

try {
  for (let attempt = 0; attempt < 120; attempt++) {
    try { if ((await fetch(`${base}/api/health`)).ok) break } catch {}
    await wait(100)
  }

  const anonymous = await fetch(`${base}/api/state`)
  assert.equal(anonymous.status, 200, 'a caller with no Origin is not a browser and must pass')

  for (const origin of trusted) {
    const response = await fetch(`${base}/api/state`, { headers: { origin } })
    assert.equal(response.status, 200, `${origin} is the app itself and must be served`)
    assert.equal(response.headers.get('access-control-allow-origin'), origin, `${origin} needs an allow-origin header to read the reply`)
    assert.equal(await connect(origin), 'open', `${origin} must be able to open the event stream`)
  }

  const read = await fetch(`${base}/api/state`, { headers: { origin: evil } })
  assert.equal(read.status, 403, 'a foreign origin read the gateway state')
  assert.equal(read.headers.get('access-control-allow-origin'), null, 'a foreign origin was handed an allow-origin header')

  // Turning the request away matters on its own: omitting the allow-origin
  // header only hides the reply, and these routes act before anyone reads it.
  const write = await fetch(`${base}/api/projects`, { method: 'POST', headers: { origin: evil, 'content-type': 'application/json' }, body: JSON.stringify({ hostId: 'local', name: 'x', path: root }) })
  assert.equal(write.status, 403, 'a foreign origin reached a mutating route')

  // A form post is a "simple request", so the browser sends it with no
  // preflight to hide behind.
  const simple = await fetch(`${base}/api/projects`, { method: 'POST', headers: { origin: evil, 'content-type': 'text/plain' }, body: 'hostId=local' })
  assert.equal(simple.status, 403, 'a foreign origin reached a mutating route without a preflight')

  const eavesdrop = await connect(evil)
  assert.match(eavesdrop, /^refused/, `a foreign origin opened the event stream (${eavesdrop})`)

  console.log('ok - the gateway serves the app and refuses foreign origins on both HTTP and the event stream')
} finally {
  gateway.kill('SIGTERM')
  await wait(500)
  if (gateway.exitCode === null && gateway.signalCode === null) gateway.kill('SIGKILL')
  await fs.rm(temp, { recursive: true, force: true })
}
