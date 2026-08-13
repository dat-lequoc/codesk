import { spawn, execFile } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { promisify } from 'node:util'

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
    host.status = 'online'; host.error = null; host.lastSeen = new Date().toISOString(); this.failures.set(host.id, 0); this.store.save()
    if (changed) this.broadcast('host.updated', host)
    this.poll(host.id, 10)
  }

  markOffline(host, error) {
    const changed = host.status !== 'offline' || host.error !== error
    host.status = 'offline'; host.error = error; this.store.save()
    if (changed) this.broadcast('host.updated', host)
  }

  async connect(hostId) {
    const host = this.host(hostId)
    if (!host || host.type !== 'ssh' || this.processes.has(host.id)) return
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
      const failures = (this.failures.get(host.id) || 0) + 1; this.failures.set(host.id, failures)
      this.markOffline(host, error || 'SSH tunnel disconnected')
      const delay = Math.min(60_000, 1000 * (2 ** Math.min(failures, 6))) * (0.85 + Math.random() * 0.3)
      this.pollers.set(`connect:${host.id}`, setTimeout(() => this.connect(host.id), delay))
    })
    for (let attempt = 0; attempt < 30; attempt++) { await sleep(200); if (await this.health(host)) return this.markOnline(host); if (child.exitCode !== null) return }
    child.kill('SIGTERM')
    host.error = `SSH connected, but codeskd is not responding on VPS port ${host.daemonPort || 4243}. Install/start the daemon, then reconnect.`
    this.store.save(); this.broadcast('host.updated', host)
  }

  async inspectRemote(hostId) {
    const host=this.host(hostId); if(!host||host.type!=='ssh') throw new Error('SSH host not found')
    const script='set -e; printf "os="; uname -s; printf "arch="; uname -m; printf "daemon="; command -v codeskd || true; printf "systemd_user="; command -v systemctl >/dev/null && echo yes || echo no'
    const {stdout}=await execFileAsync('ssh',[...sshOptions,host.sshAlias,'sh','-lc',script],{timeout:12000})
    return Object.fromEntries(stdout.trim().split('\n').map((line)=>line.split(/=(.*)/s).slice(0,2)))
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

  async bootstrapRemote(hostId, { artifactUrl, localBinaryPath } = {}) {
    const host=this.host(hostId); if(!host||host.type!=='ssh') throw new Error('SSH host not found')
    const inspection = await this.inspectRemote(hostId)
    if (inspection.daemon) { this.reconnect(hostId); return { ok:true, alreadyInstalled:true, inspection } }
    artifactUrl ||= releaseArtifactUrl(inspection)
    if (artifactUrl) return this.installRemote(hostId, artifactUrl)
    if (!localBinaryPath) throw new Error(`codeskd is missing on ${host.name}. Provide a ${inspection.os}/${inspection.arch} daemon artifact.`)
    const localOs = process.platform === 'darwin' ? 'Darwin' : process.platform === 'linux' ? 'Linux' : process.platform
    const localArch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x86_64' : process.arch
    if (inspection.os !== localOs || inspection.arch !== localArch) throw new Error(`Local daemon is ${localOs}/${localArch}, but ${host.name} requires ${inspection.os}/${inspection.arch}. Provide a compatible artifact URL.`)
    const remoteTemp = `/tmp/codeskd-${Date.now()}`
    await execFileAsync('scp',[...sshOptions,localBinaryPath,`${host.sshAlias}:${remoteTemp}`],{timeout:60000,maxBuffer:1024*1024})
    const command=`set -eu; chmod +x ${shellQuote(remoteTemp)}; ${shellQuote(remoteTemp)} install ${Number(host.daemonPort||4243)}; rm -f ${shellQuote(remoteTemp)}`
    const {stdout,stderr}=await execFileAsync('ssh',[...sshOptions,host.sshAlias,'sh','-lc',command],{timeout:60000,maxBuffer:1024*1024})
    this.reconnect(hostId)
    return {ok:true,stdout,stderr,inspection}
  }

  async installRemote(hostId, artifactUrl) {
    const host=this.host(hostId); if(!host||host.type!=='ssh') throw new Error('SSH host not found')
    if(!artifactUrl) throw new Error('A codeskd artifact URL is required until release artifacts are configured')
    const command=`set -eu; tmp=$(mktemp); trap 'rm -f "$tmp"' EXIT; curl -fL ${shellQuote(artifactUrl)} -o "$tmp"; chmod +x "$tmp"; "$tmp" install ${Number(host.daemonPort||4243)}`
    const {stdout,stderr}=await execFileAsync('ssh',[...sshOptions,host.sshAlias,'sh','-lc',command],{timeout:60000,maxBuffer:1024*1024})
    this.reconnect(hostId)
    return {ok:true,stdout,stderr}
  }

  reconnect(hostId) {
    clearTimeout(this.pollers.get(`connect:${hostId}`)); this.failures.set(hostId, 0)
    const child = this.processes.get(hostId); if (child) child.kill('SIGTERM'); else this.connect(hostId)
  }

  poll(hostId, delay = 800) {
    clearTimeout(this.pollers.get(`poll:${hostId}`))
    this.pollers.set(`poll:${hostId}`, setTimeout(() => this.readEvents(hostId), delay))
  }

  async readEvents(hostId) {
    const host = this.host(hostId)
    if (!host || host.status !== 'online') return
    try {
      const cursor = this.cursors.get(hostId) || 0
      const response = await fetch(`${this.endpoint(host)}/v1/events?after=${cursor}`, { signal: AbortSignal.timeout(5000) })
      if (!response.ok) throw new Error(`daemon returned ${response.status}`)
      const events = await response.json()
      for (const event of events) { this.cursors.set(hostId, Math.max(this.cursors.get(hostId) || 0, event.global_sequence)); this.broadcast('daemon.event', { hostId, event }) }
      this.poll(hostId, events.length ? 50 : 650)
    } catch (cause) {
      if (host.type === 'local') { this.markOffline(host, cause.message); setTimeout(() => this.ensureLocal(), 1200) }
      else { const child = this.processes.get(host.id); if (child) child.kill('SIGTERM') }
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

function shellQuote(value){return `'${String(value).replaceAll("'","'\\''")}'`}
function releaseArtifactUrl(inspection){const base=process.env.CODESK_DAEMON_RELEASE_BASE_URL;if(!base)return '';const arch=inspection.arch==='x86_64'?'x86_64':inspection.arch==='aarch64'||inspection.arch==='arm64'?'aarch64':inspection.arch;return `${base.replace(/\/$/,'')}/codeskd-${inspection.os}-${arch}`}
