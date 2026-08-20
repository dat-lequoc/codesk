import { spawn, execFile } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { promisify } from 'node:util'
import WebSocket from 'ws'

const sshOptions = ['-o','BatchMode=yes','-o','ExitOnForwardFailure=yes','-o','ConnectTimeout=7','-o','ServerAliveInterval=10','-o','ServerAliveCountMax=3','-o','ControlMaster=auto','-o','ControlPersist=10m','-o','ControlPath=~/.ssh/codesk-%C']
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const execFileAsync = promisify(execFile)

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => { const address = server.address(); server.close(() => resolve(address.port)) })
    server.on('error', reject)
  })
}

export class Gateway {
  constructor(store, broadcast) {
    this.store = store
    this.broadcast = broadcast
    this.processes = new Map()
    this.pollers = new Map()
    this.cursors = new Map()
    this.failures = new Map()
    this.eventSockets = new Map()
    this.eventFailures = new Map()
    this.bootstrapping = new Set()
    this.bootstrapAttempts = new Map()
    this.onDaemonEvent = null
    this.onHostOnline = null
  }

  async start() {
    await this.ensureLocal()
    for (const host of this.store.state.hosts.filter((item) => item.type === 'ssh')) this.connect(host.id)
  }

  endpoint(host) { return `http://127.0.0.1:${host.localPort || host.daemonPort}` }

  async ensureLocal() {
    const host = this.host('local')
    const configuredBinary = process.env.CODESK_DAEMON_BINARY
    const binary = configuredBinary && fs.existsSync(configuredBinary) ? configuredBinary : path.resolve(process.cwd(), 'target/debug/codeskd')
    if (await this.health(host)) return this.markOnline(host)
    const child = spawn(binary, [], { cwd: process.cwd(), env: { ...process.env, CODESK_PORT: String(host.daemonPort) }, stdio: ['ignore', 'pipe', 'pipe'] })
    this.processes.set(host.id, child)
    child.stderr.on('data', (data) => { host.error = data.toString().trim().split('\n').at(-1) })
    child.on('exit', () => { this.processes.delete(host.id); this.markOffline(host, 'Local daemon stopped'); setTimeout(() => this.ensureLocal(), 1500) })
    for (let attempt = 0; attempt < 30; attempt++) { await sleep(200); if (await this.health(host)) { this.markOnline(host); return } }
    this.markOffline(host, host.error || 'Local daemon did not start')
  }

  host(id) { return this.store.state.hosts.find((host) => host.id === id) }

  async health(host) {
    try {
      const response = await fetch(`${this.endpoint(host)}/v1/health`, { signal: AbortSignal.timeout(2500) })
      if (!response.ok) return false
      host.health = await response.json()
      return true
    } catch { return false }
  }

  markOnline(host) {
    const changed = host.status !== 'online'
    host.status = 'online'; host.error = null; host.bootstrapError = null; host.lastSeen = new Date().toISOString(); this.failures.set(host.id, 0); this.bootstrapAttempts.delete(host.id); this.store.save()
    if (changed) this.broadcast('host.updated', host)
    this.connectEvents(host.id)
    this.onHostOnline?.(host.id)
  }

  markOffline(host, error) {
    const changed = host.status !== 'offline' || host.error !== error
    host.status = 'offline'; host.error = error; this.store.save()
    const socket = this.eventSockets.get(host.id)
    if (socket) { this.eventSockets.delete(host.id); socket.close() }
    if (changed) this.broadcast('host.updated', host)
  }

  async connect(hostId) {
    const host = this.host(hostId)
    if (!host || host.type !== 'ssh' || this.processes.has(host.id)) return
    // An install is already in flight for this host; it reconnects when done.
    if (this.bootstrapping.has(host.id)) return
    host.status = 'connecting'; host.error = null; this.broadcast('host.updated', host)
    // Always allocate a fresh listener. A prior SSH control socket or a tunnel
    // lost during a network transition can leave the persisted port occupied;
    // reusing it makes the replacement tunnel fail even though the host is
    // reachable. Requests are already gated while the host is `connecting`.
    host.localPort = await freePort()
    this.store.save()
    // A multiplexed `ssh -N` may hand the forwarding request to an existing
    // ControlMaster and exit immediately. The forwarding can still exist, but
    // this gateway then mistakes the short-lived mux client for a disconnected
    // tunnel. Keep the long-lived tunnel as its own process so its lifetime is
    // an honest connection signal and reconnect/backoff remains deterministic.
    // OpenSSH uses the first value it sees for an option, so these overrides
    // must precede the shared multiplexing defaults below.
    const args = ['-o', 'ControlMaster=no', '-o', 'ControlPath=none', ...sshOptions, '-N', '-L', `127.0.0.1:${host.localPort}:127.0.0.1:${host.daemonPort || 4243}`, host.sshAlias]
    const child = spawn('ssh', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    this.processes.set(host.id, child)
    let error = ''
    child.stderr.on('data', (data) => { error = data.toString().trim().split('\n').at(-1) || error })
    child.on('exit', () => {
      this.processes.delete(host.id)
      this.markOffline(host, error || 'SSH tunnel disconnected')
      this.scheduleReconnect(host.id)
    })
    for (let attempt = 0; attempt < 30; attempt++) { await sleep(200); if (await this.health(host)) return this.markOnline(host); if (child.exitCode !== null) return }
    child.kill('SIGTERM')
    // SSH itself is fine, so the host is reachable and only the daemon is
    // missing or stopped. Provision it here instead of asking the user to run
    // an install by hand: connecting a host is the moment they expressed the
    // intent, and a remote with no codeskd is the normal first-connect state.
    if (await this.autoBootstrap(host)) return
    host.error = `SSH connected, but codeskd is not responding on VPS port ${host.daemonPort || 4243}. ${host.bootstrapError || 'Install/start the daemon, then reconnect.'}`
    this.store.save(); this.broadcast('host.updated', host)
  }

  // Returns true when an install ran (or is running) and a reconnect is
  // already scheduled, so the caller must not overwrite the host state.
  async autoBootstrap(host) {
    if (this.bootstrapping.has(host.id)) return true
    const attempts = this.bootstrapAttempts.get(host.id) || 0
    if (attempts >= 2) return false
    this.bootstrapping.add(host.id)
    this.bootstrapAttempts.set(host.id, attempts + 1)
    clearTimeout(this.pollers.get(`connect:${host.id}`))
    host.status = 'connecting'; host.error = `Installing codeskd on ${host.name}…`; host.bootstrapError = null
    this.store.save(); this.broadcast('host.updated', host)
    try {
      this.lastBootstrap = await this.bootstrapRemote(host.id, { reconnect: false })
      return true
    } catch (error) {
      host.bootstrapError = `Automatic install failed: ${error.message}`
      // autoBootstrap consumed the retry timer the tunnel exit scheduled, so a
      // failed install must schedule its own; otherwise the host stays offline
      // until someone reconnects it by hand.
      this.scheduleReconnect(host.id)
      return false
    } finally {
      this.bootstrapping.delete(host.id)
      if (!host.bootstrapError) this.reconnect(host.id)
    }
  }

  scheduleReconnect(hostId) {
    const failures = (this.failures.get(hostId) || 0) + 1
    this.failures.set(hostId, failures)
    const delay = Math.min(60_000, 1000 * (2 ** Math.min(failures, 6))) * (0.85 + Math.random() * 0.3)
    clearTimeout(this.pollers.get(`connect:${hostId}`))
    this.pollers.set(`connect:${hostId}`, setTimeout(() => this.connect(hostId), delay))
  }

  async inspectRemote(hostId) {
    const host=this.host(hostId); if(!host||host.type!=='ssh') throw new Error('SSH host not found')
    // Each field needs its own line: a bare `printf "daemon="` with no match
    // ran straight into the next field, so an unprovisioned host reported a
    // bogus daemon path and skipped installation.
    const script='set -e; echo "os=$(uname -s)"; echo "arch=$(uname -m)"; echo "daemon=$(command -v codeskd || true)"; echo "systemd_user=$(command -v systemctl >/dev/null && echo yes || echo no)"'
    const {stdout}=await execFileAsync('ssh',[...sshOptions,host.sshAlias,remoteShell(script)],{timeout:20000})
    const inspection = Object.fromEntries(stdout.trim().split('\n').map((line)=>line.split(/=(.*)/s).slice(0,2)))
    if (!inspection.daemon?.startsWith('/')) inspection.daemon = ''
    return inspection
  }

  async sshAliases() {
    const files = [path.join(os.homedir(), '.ssh', 'config')]
    const aliases = new Set()
    for (const file of files) {
      let text = ''
      try { text = await fs.promises.readFile(file, 'utf8') } catch { continue }
      for (const raw of text.split(/\r?\n/)) {
        const match = raw.match(/^\s*Host\s+(.+)$/i)
        if (!match) continue
        for (const value of match[1].trim().split(/\s+/)) if (!/[*?!]/.test(value)) aliases.add(value)
      }
    }
    return [...aliases].sort((a,b)=>a.localeCompare(b))
  }

  async bootstrapRemote(hostId, { artifactUrl, localBinaryPath, reconnect = true } = {}) {
    const host=this.host(hostId); if(!host||host.type!=='ssh') throw new Error('SSH host not found')
    const inspection = await this.inspectRemote(hostId)
    if (inspection.daemon) {
      // Binary is there but nothing is listening: (re)start the service.
      await execFileAsync('ssh',[...sshOptions,host.sshAlias,remoteShell(`set -eu; ${shellQuote(inspection.daemon)} install ${Number(host.daemonPort||4243)}`)],{timeout:60000,maxBuffer:1024*1024})
      if (reconnect) this.reconnect(hostId)
      return { ok:true, alreadyInstalled:true, inspection }
    }
    artifactUrl ||= releaseArtifactUrl(inspection)
    if (artifactUrl) return this.installRemote(hostId, artifactUrl, { reconnect })
    const binary = localBinaryPath && fs.existsSync(localBinaryPath) && matchesLocalPlatform(inspection)
      ? localBinaryPath
      : localArtifactFor(inspection) || await this.seedFromPeer(inspection)
    if (!binary) throw new Error(`codeskd is missing on ${host.name} and no ${inspection.os}/${inspection.arch} daemon artifact is available. Set CODESK_DAEMON_RELEASE_BASE_URL, drop a binary at dist/codeskd-${inspection.os}-${inspection.arch}, or connect another ${inspection.os}/${inspection.arch} host that already runs codeskd.`)
    const remoteTemp = `/tmp/codeskd-${Date.now()}`
    await execFileAsync('scp',[...sshOptions,binary,`${host.sshAlias}:${remoteTemp}`],{timeout:120000,maxBuffer:1024*1024})
    const command=`set -eu; chmod +x ${shellQuote(remoteTemp)}; ${shellQuote(remoteTemp)} install ${Number(host.daemonPort||4243)}; rm -f ${shellQuote(remoteTemp)}`
    const {stdout,stderr}=await execFileAsync('ssh',[...sshOptions,host.sshAlias,remoteShell(command)],{timeout:60000,maxBuffer:1024*1024})
    if (reconnect) this.reconnect(hostId)
    return {ok:true,stdout,stderr,inspection,binary}
  }

  // Copies codeskd from an already-provisioned host of the same os/arch. This
  // keeps first connects working before signed release artifacts exist: the
  // machine that can reach both hosts is this gateway, so the hop goes through
  // a local cache file that later installs reuse.
  async seedFromPeer(inspection) {
    const cached = localArtifactFor(inspection)
    if (cached) return cached
    for (const peer of this.store.state.hosts) {
      if (peer.type !== 'ssh' || peer.status !== 'online') continue
      let peerInfo
      try { peerInfo = await this.inspectRemote(peer.id) } catch { continue }
      if (!peerInfo.daemon || peerInfo.os !== inspection.os || peerInfo.arch !== inspection.arch) continue
      const target = artifactPath(inspection)
      await fs.promises.mkdir(path.dirname(target), { recursive: true })
      await execFileAsync('scp',[...sshOptions,`${peer.sshAlias}:${peerInfo.daemon}`,target],{timeout:120000,maxBuffer:1024*1024})
      await fs.promises.chmod(target, 0o755)
      return target
    }
    return ''
  }

  async installRemote(hostId, artifactUrl, { reconnect = true } = {}) {
    const host=this.host(hostId); if(!host||host.type!=='ssh') throw new Error('SSH host not found')
    if(!artifactUrl) throw new Error('A codeskd artifact URL is required until release artifacts are configured')
    const command=`set -eu; tmp=$(mktemp); trap 'rm -f "$tmp"' EXIT; curl -fL ${shellQuote(artifactUrl)} -o "$tmp"; chmod +x "$tmp"; "$tmp" install ${Number(host.daemonPort||4243)}`
    const {stdout,stderr}=await execFileAsync('ssh',[...sshOptions,host.sshAlias,remoteShell(command)],{timeout:60000,maxBuffer:1024*1024})
    if (reconnect) this.reconnect(hostId)
    return {ok:true,stdout,stderr}
  }

  reconnect(hostId) {
    clearTimeout(this.pollers.get(`connect:${hostId}`)); this.failures.set(hostId, 0)
    const child = this.processes.get(hostId); if (child) child.kill('SIGTERM'); else this.connect(hostId)
  }

  connectEvents(hostId, delay = 0) {
    clearTimeout(this.pollers.get(`events:${hostId}`))
    if (delay > 0) {
      this.pollers.set(`events:${hostId}`, setTimeout(() => this.connectEvents(hostId), delay))
      return
    }
    const host = this.host(hostId)
    if (!host || host.status !== 'online') return
    const existing = this.eventSockets.get(hostId)
    if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) return
    const endpoint = this.endpoint(host).replace(/^http/, 'ws')
    const cursor = this.cursors.get(hostId) || 0
    const socket = new WebSocket(`${endpoint}/v1/events/ws?after=${cursor}`)
    this.eventSockets.set(hostId, socket)
    socket.on('open', () => this.eventFailures.set(hostId, 0))
    socket.on('message', (payload) => {
      try {
        const event = JSON.parse(payload.toString())
        this.cursors.set(hostId, Math.max(this.cursors.get(hostId) || 0, event.global_sequence || 0))
        this.broadcast('daemon.event', { hostId, event })
        this.onDaemonEvent?.(hostId, event)
      } catch {}
    })
    socket.on('error', () => socket.close())
    socket.on('close', async () => {
      if (this.eventSockets.get(hostId) === socket) this.eventSockets.delete(hostId)
      const current = this.host(hostId)
      if (!current || current.status !== 'online') return
      if (!(await this.health(current))) {
        if (current.type === 'local') { this.markOffline(current, 'Local daemon event stream disconnected'); setTimeout(() => this.ensureLocal(), 1200) }
        else { const child = this.processes.get(current.id); if (child) child.kill('SIGTERM') }
        return
      }
      const failures = (this.eventFailures.get(hostId) || 0) + 1
      this.eventFailures.set(hostId, failures)
      this.connectEvents(hostId, Math.min(10_000, 400 * (2 ** Math.min(failures, 5))))
    })
  }

  closeEvents(hostId) {
    clearTimeout(this.pollers.get(`events:${hostId}`))
    const socket = this.eventSockets.get(hostId)
    if (socket) {
      this.eventSockets.delete(hostId)
      socket.close()
    }
  }

  async request(hostId, daemonPath, options = {}) {
    const host = this.host(hostId)
    if (!host) throw new Error('Host not found')
    if (host.status !== 'online') throw new Error(`${host.name} is not connected`)
    const response = await fetch(`${this.endpoint(host)}${daemonPath}`, { ...options, headers: { 'content-type': 'application/json', ...options.headers }, signal: AbortSignal.timeout(options.timeout || 15000) })
    const text = await response.text()
    const body = text ? JSON.parse(text) : null
    if (!response.ok) throw new Error(body?.error || `Daemon request failed (${response.status})`)
    return body
  }
}

// A login shell would source the remote user's rc files, which frequently
// contain bash-only syntax that fails under a POSIX /bin/sh. Run a plain
// shell and extend PATH ourselves so `codeskd` in ~/.local/bin is still found.
function remoteShell(script){return `sh -c ${shellQuote(`PATH="$HOME/.local/bin:$HOME/bin:$PATH"; export PATH; ${script}`)}`}
function shellQuote(value){return `'${String(value).replaceAll("'","'\\''")}'`}
function localPlatform(){return {os: process.platform === 'darwin' ? 'Darwin' : process.platform === 'linux' ? 'Linux' : process.platform, arch: process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x86_64' : process.arch}}
function matchesLocalPlatform(inspection){const local=localPlatform();return inspection.os===local.os&&inspection.arch===local.arch}
function artifactPath(inspection){return path.join(process.env.CODESK_ARTIFACT_DIR || path.join(os.homedir(),'.codesk','artifacts'),`codeskd-${inspection.os}-${inspection.arch}`)}
function localArtifactFor(inspection){
  const candidates=[artifactPath(inspection),path.resolve(process.cwd(),'dist',`codeskd-${inspection.os}-${inspection.arch}`)]
  if(inspection.os==='Linux')candidates.push(path.resolve(process.cwd(),`target/${inspection.arch}-unknown-linux-musl/release/codeskd`),path.resolve(process.cwd(),`target/${inspection.arch}-unknown-linux-gnu/release/codeskd`))
  if(matchesLocalPlatform(inspection))candidates.push(path.resolve(process.cwd(),'target/release/codeskd'),path.resolve(process.cwd(),'target/debug/codeskd'))
  return candidates.find((candidate)=>fs.existsSync(candidate))||''
}
function releaseArtifactUrl(inspection){const base=process.env.CODESK_DAEMON_RELEASE_BASE_URL;if(!base)return '';const arch=inspection.arch==='x86_64'?'x86_64':inspection.arch==='aarch64'||inspection.arch==='arm64'?'aarch64':inspection.arch;return `${base.replace(/\/$/,'')}/codeskd-${inspection.os}-${arch}`}
