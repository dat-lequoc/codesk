import express from 'express'
import http from 'node:http'
import { WebSocketServer } from 'ws'
import { Store } from './store.mjs'
import { Gateway } from './gateway.mjs'
import { createMappers } from './mappers.mjs'
import { createStateCache } from './state-cache.mjs'
import { registerRoutes } from './routes.mjs'

// Only the Tauri webview and local dev servers are legitimate cross-origin
// callers. A request with any other `Origin` is a page the user happened to
// visit reaching a loopback port that can drive their agents, so it is refused
// rather than merely denied a readable response. Callers with no `Origin` at
// all — the desktop shell, scripts, tests — are not browsers and pass through.
const allowedOrigin = (origin) =>
  Boolean(origin) &&
  (origin.startsWith('tauri://') ||
    origin.startsWith('http://tauri.localhost') ||
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))

const app = express(); const server = http.createServer(app); const store = new Store()
// The same rule has to be enforced here separately: WebSocket handshakes are
// exempt from CORS, so without this check any page could open /ws and read the
// live event stream regardless of what the HTTP layer allows.
const wss = new WebSocketServer({ server, path: '/ws', verifyClient: ({ origin }) => !origin || allowedOrigin(origin) })
// Clients that stop reading accumulate frames in the ws send buffer without
// bound. Skipping them instead of queueing is safe: the UI re-fetches state on
// reconnect and polls periodically, so a dropped frame heals itself.
const MAX_CLIENT_BUFFER = 4 * 1024 * 1024
function broadcast(type, payload) {
  const body = JSON.stringify({ type, payload })
  for (const client of wss.clients) {
    if (client.readyState !== 1 || client.bufferedAmount > MAX_CLIENT_BUFFER) continue
    client.send(body)
  }
}
const gateway = new Gateway(store, broadcast)
const mappers = createMappers(store)
const stateCache = createStateCache({ store, gateway, broadcast, mappers })

app.use((req, res, next) => {
  const origin = req.headers.origin
  // Omitting the allow-origin header only stops the page from reading the
  // reply; the request still ran. Mutating routes start agents and install
  // daemons, so a foreign origin has to be turned away before that happens.
  if (origin && !allowedOrigin(origin)) return res.status(403).json({ error: 'Cross-origin requests are not allowed' })
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  }
  res.setHeader('Access-Control-Allow-Headers', 'content-type')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})
app.use(express.json({ limit: '1mb' }))

gateway.onDaemonEvent = (hostId, event) => {
  const kind = event.kind || ''
  if (/^run\./.test(kind)) stateCache.scheduleHostRunsRefresh(hostId)
  else if (/^(control|turn|thread|queue)\./.test(kind)) stateCache.scheduleHostRefresh(hostId)
}
gateway.onHostOnline = (hostId) => stateCache.scheduleHostRefresh(hostId, 0)

wss.on('connection', (socket) => socket.send(JSON.stringify({ type: 'ready', payload: { now: new Date().toISOString() } })))

// --- Ownership -------------------------------------------------------------
// This gateway exists to serve desktop app instances. When the last one is gone
// there is nobody to serve, so it stops instead of lingering as a background
// service that keeps a polling daemon alive. See ARCHITECTURE.md §6.5.
//
// An empty owner set means "unowned", not "abandoned": `npm start`, `npm run
// dev`, and the test suite launch the gateway with no CODESK_OWNER_PID and must
// keep running until signalled.
const owners = new Set()
const initialOwner = Number(process.env.CODESK_OWNER_PID)
if (Number.isInteger(initialOwner) && initialOwner > 0) owners.add(initialOwner)

function ownerAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the PID exists but belongs to another user, so it is alive.
    return error.code === 'EPERM'
  }
}

let stopping = false
let ownerWatchdog
async function stop(reason, code = 0) {
  if (stopping) return
  stopping = true
  console.log(`Codesk client gateway stopping: ${reason}`)
  clearInterval(ownerWatchdog)
  stateCache.clearTimers()
  await gateway.shutdown()
  for (const socket of wss.clients) socket.terminate()
  // Give in-flight HTTP requests a moment to drain before exiting.
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 2000)
    timeout.unref?.()
    server.close(() => { clearTimeout(timeout); resolve() })
  })
  store.flushSync()
  process.exit(code)
}

ownerWatchdog = setInterval(() => {
  if (stopping || owners.size === 0) return
  for (const pid of owners) if (!ownerAlive(pid)) owners.delete(pid)
  if (owners.size === 0) void stop('every owning Codesk app instance exited')
}, 1000)
// A watchdog is not a reason to keep the event loop alive on its own.
ownerWatchdog.unref?.()

registerRoutes(app, { store, gateway, broadcast, stateCache, mappers, ownership: { owners, ownerAlive, stop } })

for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => void stop(`received ${signal}`))
process.on('unhandledRejection', (reason) => console.error('Unhandled rejection:', reason))

async function main() {
  await gateway.start()
  stateCache.refreshStaleHosts()
  const port = Number(process.env.PORT || 4242)
  server.on('error', (error) => {
    const message = error.code === 'EADDRINUSE'
      ? `Port ${port} is already in use. Stop the process holding it or set PORT to another port.`
      : `Gateway server error: ${error.message}`
    console.error(message)
    void stop(message, 1)
  })
  server.listen(port, '127.0.0.1', () => console.log(`Codesk client gateway listening on http://127.0.0.1:${port}`))
}
main().catch((error) => { console.error(error); void stop(`startup failed: ${error.message}`, 1) })
