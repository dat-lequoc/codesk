import { spawn, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import net from 'node:net'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { promisify } from 'node:util'
import WebSocket from 'ws'

const sshOptions = ['-o','BatchMode=yes','-o','ExitOnForwardFailure=yes','-o','ConnectTimeout=7','-o','ServerAliveInterval=10','-o','ServerAliveCountMax=3','-o','ControlMaster=auto','-o','ControlPersist=10m','-o','ControlPath=~/.ssh/codesk-%C']
// The oldest codeskd this gateway knows how to drive. A remote host can keep
// running a daemon installed by an older Codesk indefinitely; without this
// check it stays "online" while requests fail in confusing ways.
const MIN_DAEMON_VERSION = '0.2.2'
// How often an online host is re-checked for a stale daemon. The check is a
// health request down an SSH tunnel that is already open, plus a hash of a
// local file that is cached until it changes, so it is close to free.
const DAEMON_UPGRADE_INTERVAL_MS = 60_000
// Two installs that both fail to change the remote's fingerprint mean the
// artifact and the running daemon disagree for a reason reinstalling cannot
// fix. Stop rather than reinstall on a loop.
const MAX_DAEMON_UPGRADE_ATTEMPTS = 2
function versionLt(left, right) {
  const parse = (value) => String(value).split('.').map((part) => Number.parseInt(part, 10) || 0)
  const a = parse(left); const b = parse(right)
  for (let index = 0; index < 3; index++) {
    const x = a[index] || 0; const y = b[index] || 0
    if (x !== y) return x < y
  }
  return false
}
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
    // How many times an automatic daemon upgrade has been attempted for a host
    // since it last came online. An upgrade that does not change the remote's
    // fingerprint would otherwise reinstall on every check forever.
    this.upgradeAttempts = new Map()
    // Daemon tokens are read from each host at connect time and kept here
    // rather than on the host record, which is persisted to disk.
    this.tokens = new Map()
    this.shuttingDown = false
    this.onDaemonEvent = null
    this.onHostOnline = null
  }

  async start() {
    await this.ensureLocal()
    for (const host of this.store.state.hosts.filter((item) => item.type === 'ssh')) this.connect(host.id)
  }

  endpoint(host) { return `http://127.0.0.1:${host.localPort || host.daemonPort}` }

  // Everything but /v1/health needs the daemon's token. A daemon predating
  // token auth ignores the header, so an unread token still lets an older
  // remote work until it is upgraded.
  authHeaders(hostId) {
    const token = this.tokens.get(hostId)
    return token ? { authorization: `Bearer ${token}` } : {}
  }

  async loadRemoteToken(host) {
    try {
      const { stdout } = await execFileAsync('ssh', [...sshOptions, host.sshAlias, remoteShell(`cat "$HOME/.local/share/codesk/token" 2>/dev/null || cat "$HOME/Library/Application Support/Codesk/token" 2>/dev/null || true`)], { timeout: 15000, maxBuffer: 64 * 1024 })
      this.tokens.set(host.id, stdout.trim())
    } catch { this.tokens.delete(host.id) }
  }

  async ensureLocal() {
    const host = this.host('local')
    // A previous ensureLocal may still be mid-spawn or have a retry timer
    // armed. Entering again would race it and leave two codeskd children
    // fighting over the port, so this method is single-flight.
    clearTimeout(this.pollers.get('ensure:local'))
    this.pollers.delete('ensure:local')
    if (this.processes.has(host.id)) return
    const configuredBinary = process.env.CODESK_DAEMON_BINARY
    const binary = configuredBinary && fs.existsSync(configuredBinary) ? configuredBinary : path.resolve(process.cwd(), 'target/debug/codeskd')
    if (await this.health(host)) { this.tokens.set(host.id, readLocalToken()); return this.markOnline(host) }
    if (this.shuttingDown || this.processes.has(host.id)) return
    // codeskd is ours, so it must not outlive this gateway. The watchdog it
    // starts from CODESK_OWNER_PID covers the case where we are SIGKILLed and
    // never get to run shutdown(). See ARCHITECTURE.md §6.5.
    const child = spawn(binary, [], { cwd: process.cwd(), env: { ...process.env, CODESK_PORT: String(host.daemonPort), CODESK_OWNER_PID: String(process.pid) }, stdio: ['ignore', 'pipe', 'pipe'] })
    this.processes.set(host.id, child)
    child.stderr.on('data', (data) => { host.error = data.toString().trim().split('\n').at(-1) })
    // Restarting a daemon we are deliberately stopping would undo shutdown, so
    // the respawn is conditional on still being alive.
    child.on('exit', () => { this.processes.delete(host.id); if (this.shuttingDown) return; this.markOffline(host, 'Local daemon stopped'); clearTimeout(this.pollers.get('ensure:local')); this.pollers.set('ensure:local', setTimeout(() => this.ensureLocal(), 1500)) })
    for (let attempt = 0; attempt < 30; attempt++) { await sleep(200); if (this.shuttingDown) return; if (await this.health(host)) { this.tokens.set(host.id, readLocalToken()); this.markOnline(host); return } }
    this.markOffline(host, host.error || 'Local daemon did not start')
  }

  /// Stop every process this gateway owns and stay stopped.
  ///
  /// Ordering matters: the flag goes up first so no exit handler or retry timer
  /// can spawn a replacement while we are tearing down.
  async shutdown() {
    if (this.shuttingDown) return
    this.shuttingDown = true
    for (const timer of this.pollers.values()) clearTimeout(timer)
    this.pollers.clear()
    for (const socket of this.eventSockets.values()) socket.close()
    this.eventSockets.clear()
    // Covers the local codeskd and every `ssh -N` tunnel, so no forwarded port
    // is left held open by an orphan.
    const children = [...this.processes.values()]
    for (const child of children) { try { child.kill('SIGTERM') } catch {} }
    const deadline = Date.now() + 3000
    while (Date.now() < deadline && children.some((child) => child.exitCode === null && child.signalCode === null)) await sleep(50)
    for (const child of children) { if (child.exitCode === null && child.signalCode === null) { try { child.kill('SIGKILL') } catch {} } }
    this.processes.clear()
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

  daemonOutdated(host) {
    const version = host.health?.version
    return Boolean(version) && versionLt(version, MIN_DAEMON_VERSION)
  }

  /// The daemon binary this gateway would install on `hostId`, or '' when it
  /// has none for that platform.
  async artifactForHost(hostId) {
    return localArtifactFor(await this.inspectRemote(hostId))
  }

  scheduleDaemonUpgradeCheck(hostId, delay = DAEMON_UPGRADE_INTERVAL_MS) {
    if (this.shuttingDown) return
    clearTimeout(this.pollers.get(`upgrade:${hostId}`))
    this.pollers.set(`upgrade:${hostId}`, setTimeout(() => this.checkDaemonUpgrade(hostId), delay))
  }

  /// Keep a remote host off a daemon this gateway has already replaced.
  ///
  /// A host that answers `/v1/health` is online and stays online, so nothing
  /// used to look at what it was running: an installed daemon was upgraded only
  /// when it stopped answering, or by hand. The crate version cannot decide it
  /// either — it is unchanged between releases, so every build during a day's
  /// work reports the same one. The daemon reports a hash of its own executable
  /// instead, and that is compared against the artifact this gateway would
  /// install.
  ///
  /// An upgrade restarts codeskd, so it waits for the host to be idle. A busy
  /// host is simply rechecked later; being one build behind for another minute
  /// is cheaper than interrupting a turn.
  async checkDaemonUpgrade(hostId) {
    const host = this.host(hostId)
    if (!host || host.type !== 'ssh') return
    if (this.shuttingDown || this.bootstrapping.has(hostId)) return
    // A daemon below the floor is held offline until an upgrade lands, so it is
    // the one host state worth acting on that is not `online`.
    const outdated = this.daemonOutdated(host)
    if (!outdated && host.status !== 'online') return
    let upgraded = false
    try {
      const remoteBuild = host.health?.build
      // No fingerprint means a daemon too old to report one — which the version
      // floor catches instead. No artifact means there is nothing to install.
      const artifact = (outdated || remoteBuild) && (await this.artifactForHost(hostId))
      if (artifact && (outdated || (await fileFingerprint(artifact)) !== remoteBuild)) {
        if ((this.upgradeAttempts.get(hostId) || 0) >= MAX_DAEMON_UPGRADE_ATTEMPTS) return
        // Restarting the daemon under a live turn costs more than the delay.
        // An outdated one is not being driven at all, so nothing is interrupted.
        if (!outdated && (!(await this.health(host)) || host.health?.active_runs > 0)) return
        this.upgradeAttempts.set(hostId, (this.upgradeAttempts.get(hostId) || 0) + 1)
        this.bootstrapping.add(hostId)
        try {
          await this.bootstrapRemote(hostId, { localBinaryPath: artifact, reconnect: false })
        } finally {
          this.bootstrapping.delete(hostId)
        }
        upgraded = true
        this.reconnect(hostId)
      }
    } catch (error) {
      // A host that cannot be upgraded is still a host that works. Say so once
      // and keep driving it rather than taking it offline over a stale binary.
      host.bootstrapError = `Automatic daemon upgrade failed: ${error.message}`
      this.store.save()
    } finally {
      // A reconnect calls markOnline, which schedules the next check itself.
      if (!upgraded) this.scheduleDaemonUpgradeCheck(hostId)
    }
  }

  markOnline(host) {
    // A reachable but outdated daemon is worse than an offline one: requests
    // would fail with protocol errors instead of one actionable message.
    if (this.daemonOutdated(host)) {
      this.markOffline(host, `codeskd ${host.health.version} on ${host.name} is older than the required ${MIN_DAEMON_VERSION}. Codesk is installing a newer one; it reconnects when that lands.`)
      // Being too old to drive is the clearest case for an automatic upgrade,
      // and markOffline just cleared the timer that would have run one.
      this.scheduleDaemonUpgradeCheck(host.id, 0)
      return
    }
    const changed = host.status !== 'online'
    host.status = 'online'; host.error = null; host.bootstrapError = null; host.lastSeen = new Date().toISOString(); this.failures.set(host.id, 0); this.bootstrapAttempts.delete(host.id); this.store.save()
    if (changed) this.broadcast('host.updated', host)
    this.connectEvents(host.id)
    this.onHostOnline?.(host.id)
    if (changed) this.upgradeAttempts.delete(host.id)
    this.scheduleDaemonUpgradeCheck(host.id, changed ? 0 : DAEMON_UPGRADE_INTERVAL_MS)
  }

  markOffline(host, error) {
    const changed = host.status !== 'offline' || host.error !== error
    clearTimeout(this.pollers.get(`upgrade:${host.id}`))
    this.pollers.delete(`upgrade:${host.id}`)
    host.status = 'offline'; host.error = error; this.store.save()
    const socket = this.eventSockets.get(host.id)
    if (socket) { this.eventSockets.delete(host.id); socket.close() }
    if (changed) this.broadcast('host.updated', host)
  }

  async connect(hostId) {
    const host = this.host(hostId)
    if (!host || host.type !== 'ssh' || this.processes.has(host.id)) return
    if (this.shuttingDown) return
    // An install is already in flight for this host; it reconnects when done.
    if (this.bootstrapping.has(host.id)) return
    host.status = 'connecting'; host.error = null; this.broadcast('host.updated', host)
    // Always allocate a fresh listener. A prior SSH control socket or a tunnel
    // lost during a network transition can leave the persisted port occupied;
    // reusing it makes the replacement tunnel fail even though the host is
    // reachable. Requests are already gated while the host is `connecting`.
    host.localPort = await freePort()
    // Re-check after the await: shutdown() may have run while a port was being
    // allocated, and spawning now would leave an ssh tunnel holding a forwarded
    // port with nobody left to kill it.
    if (this.shuttingDown) return
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
      // A host that is no longer in the store was deleted; reviving its tunnel
      // (or persisting offline state for it) would resurrect a removed host.
      if (!this.host(host.id)) return
      this.markOffline(host, error || 'SSH tunnel disconnected')
      this.scheduleReconnect(host.id)
    })
    // The token has to be in hand before markOnline, which immediately opens
    // the event WebSocket and would otherwise be rejected.
    for (let attempt = 0; attempt < 30; attempt++) { await sleep(200); if (await this.health(host)) { await this.loadRemoteToken(host); return this.markOnline(host) } if (child.exitCode !== null) return }
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
    if (this.shuttingDown) return
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
    const aliases = new Set()
    const visited = new Set()
    const home = os.homedir()
    // OpenSSH resolves a bare Include path relative to ~/.ssh, expands ~, and
    // accepts globs. Configs split across ~/.ssh/config.d were invisible to
    // the picker before this walked Include directives.
    const expand = async (pattern) => {
      const resolved = pattern.startsWith('~')
        ? path.join(home, pattern.slice(1))
        : path.isAbsolute(pattern)
          ? pattern
          : path.join(home, '.ssh', pattern)
      if (!/[*?[\]]/.test(resolved)) return [resolved]
      try {
        const matches = []
        for await (const match of fs.promises.glob(resolved)) matches.push(match)
        return matches
      } catch { return [] }
    }
    const readConfig = async (file) => {
      if (visited.has(file) || visited.size > 64) return
      visited.add(file)
      let text = ''
      try { text = await fs.promises.readFile(file, 'utf8') } catch { return }
      for (const raw of text.split(/\r?\n/)) {
        const include = raw.match(/^\s*Include\s+(.+)$/i)
        if (include) {
          for (const pattern of include[1].trim().split(/\s+/))
            for (const match of await expand(pattern)) await readConfig(match)
          continue
        }
        const match = raw.match(/^\s*Host\s+(.+)$/i)
        if (!match) continue
        for (const value of match[1].trim().split(/\s+/)) if (!/[*?!]/.test(value)) aliases.add(value)
      }
    }
    await readConfig(path.join(home, '.ssh', 'config'))
    return [...aliases].sort((a,b)=>a.localeCompare(b))
  }

  async bootstrapRemote(hostId, { artifactUrl, localBinaryPath, reconnect = true } = {}) {
    const host=this.host(hostId); if(!host||host.type!=='ssh') throw new Error('SSH host not found')
    const inspection = await this.inspectRemote(hostId)
    artifactUrl ||= releaseArtifactUrl(inspection)
    if (artifactUrl) return this.installRemote(hostId, artifactUrl, { reconnect })
    const binary = localBinaryPath && fs.existsSync(localBinaryPath) && matchesLocalPlatform(inspection)
      ? localBinaryPath
      : localArtifactFor(inspection) || await this.seedFromPeer(inspection)
    if (binary) {
      // Copy even when a daemon is already installed: otherwise an outdated
      // remote stays on its old binary forever (`codeskd install` only
      // restarts whatever is already in ~/.local/bin).
      const remoteTemp = `/tmp/codeskd-${Date.now()}`
      await execFileAsync('scp',[...sshOptions,binary,`${host.sshAlias}:${remoteTemp}`],{timeout:120000,maxBuffer:1024*1024})
      const command=`set -eu; chmod +x ${shellQuote(remoteTemp)}; ${shellQuote(remoteTemp)} install ${Number(host.daemonPort||4243)}; rm -f ${shellQuote(remoteTemp)}`
      const {stdout,stderr}=await execFileAsync('ssh',[...sshOptions,host.sshAlias,remoteShell(command)],{timeout:60000,maxBuffer:1024*1024})
      if (reconnect) this.reconnect(hostId)
      return {ok:true,stdout,stderr,inspection,binary,upgraded:Boolean(inspection.daemon)}
    }
    if (inspection.daemon) {
      await execFileAsync('ssh',[...sshOptions,host.sshAlias,remoteShell(`set -eu; ${shellQuote(inspection.daemon)} install ${Number(host.daemonPort||4243)}`)],{timeout:60000,maxBuffer:1024*1024})
      if (reconnect) this.reconnect(hostId)
      return { ok:true, alreadyInstalled:true, inspection }
    }
    throw new Error(`codeskd is missing on ${host.name} and no ${inspection.os}/${inspection.arch} daemon artifact is available. Set CODESK_DAEMON_RELEASE_BASE_URL, drop a binary at dist/codeskd-${inspection.os}-${inspection.arch}, or connect another ${inspection.os}/${inspection.arch} host that already runs codeskd.`)
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
    assertReleaseArtifactUrl(artifactUrl)
    const command=`set -eu; tmp=$(mktemp); trap 'rm -f "$tmp"' EXIT; curl -fL ${shellQuote(artifactUrl)} -o "$tmp"; chmod +x "$tmp"; "$tmp" install ${Number(host.daemonPort||4243)}`
    const {stdout,stderr}=await execFileAsync('ssh',[...sshOptions,host.sshAlias,remoteShell(command)],{timeout:60000,maxBuffer:1024*1024})
    if (reconnect) this.reconnect(hostId)
    return {ok:true,stdout,stderr}
  }

  /// Forget every per-host resource: timers, sockets, cursors, backoff state,
  /// and the tunnel process. Callers must remove the host from the store first
  /// so the tunnel exit handler knows not to reconnect.
  removeHost(hostId) {
    clearTimeout(this.pollers.get(`connect:${hostId}`))
    this.pollers.delete(`connect:${hostId}`)
    clearTimeout(this.pollers.get(`upgrade:${hostId}`))
    this.pollers.delete(`upgrade:${hostId}`)
    this.upgradeAttempts.delete(hostId)
    this.closeEvents(hostId)
    this.pollers.delete(`events:${hostId}`)
    this.failures.delete(hostId)
    this.cursors.delete(hostId)
    this.eventFailures.delete(hostId)
    this.bootstrapAttempts.delete(hostId)
    this.bootstrapping.delete(hostId)
    const child = this.processes.get(hostId)
    if (child) { try { child.kill('SIGTERM') } catch {} }
  }

  reconnect(hostId) {
    clearTimeout(this.pollers.get(`connect:${hostId}`)); this.failures.set(hostId, 0)
    const child = this.processes.get(hostId); if (child) child.kill('SIGTERM'); else this.connect(hostId)
  }

  connectEvents(hostId, delay = 0) {
    clearTimeout(this.pollers.get(`events:${hostId}`))
    if (this.shuttingDown) return
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
    const socket = new WebSocket(`${endpoint}/v1/events/ws?after=${cursor}`, { headers: this.authHeaders(hostId) })
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
      // A socket that is no longer the registered one for this host was closed
      // deliberately — by closeEvents(), by shutdown(), or because a newer
      // socket replaced it. Reconnecting here would resurrect a stream the
      // caller just tore down, and since the reconnect re-arms itself the host
      // would never actually go quiet.
      if (this.eventSockets.get(hostId) !== socket) return
      this.eventSockets.delete(hostId)
      if (this.shuttingDown) return
      const current = this.host(hostId)
      if (!current || current.status !== 'online') return
      const healthy = await this.health(current)
      // shutdown() can land while the health probe is in flight; restarting the
      // daemon here would undo the teardown that just happened.
      if (this.shuttingDown) return
      if (!healthy) {
        if (current.type === 'local') { this.markOffline(current, 'Local daemon event stream disconnected'); this.pollers.set('ensure:local', setTimeout(() => this.ensureLocal(), 1200)) }
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
    const response = await fetch(`${this.endpoint(host)}${daemonPath}`, { ...options, headers: { 'content-type': 'application/json', ...this.authHeaders(hostId), ...options.headers }, signal: AbortSignal.timeout(options.timeout || 15000) })
    const text = await response.text()
    const body = text ? JSON.parse(text) : null
    if (!response.ok) throw new Error(body?.error || `Daemon request failed (${response.status})`)
    return body
  }
}

// Mirrors the daemon's own default_data_root, which is where it writes the
// 0600 token file.
function localDataRoot() {
  if (process.env.CODESK_DATA_DIR) return process.env.CODESK_DATA_DIR
  const home = os.homedir()
  return process.platform === 'darwin' ? path.join(home, 'Library/Application Support/Codesk') : path.join(home, '.local/share/codesk')
}
function readLocalToken() {
  try { return fs.readFileSync(path.join(localDataRoot(), 'token'), 'utf8').trim() } catch { return '' }
}

// A login shell would source the remote user's rc files, which frequently
// contain bash-only syntax that fails under a POSIX /bin/sh. Run a plain
// shell and extend PATH ourselves so `codeskd` in ~/.local/bin is still found.
function remoteShell(script){return `sh -c ${shellQuote(`PATH="$HOME/.local/bin:$HOME/bin:$PATH"; export PATH; ${script}`)}`}
function shellQuote(value){return `'${String(value).replaceAll("'","'\\''")}'`}
function localPlatform(){return {os: process.platform === 'darwin' ? 'Darwin' : process.platform === 'linux' ? 'Linux' : process.platform, arch: process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x86_64' : process.arch}}
function matchesLocalPlatform(inspection){const local=localPlatform();return inspection.os===local.os&&inspection.arch===local.arch}
// Hashing a daemon artifact costs tens of milliseconds, and the check runs on
// a timer per host, so the answer is kept until the file itself changes.
const fingerprints = new Map()
export async function fileFingerprint(filePath){
  let stats
  try{stats=await fs.promises.stat(filePath)}catch{return ''}
  const key=`${stats.size}:${stats.mtimeMs}`
  const cached=fingerprints.get(filePath)
  if(cached?.key===key)return cached.value
  const hash=createHash('sha256')
  try{
    for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk)
  }catch{return ''}
  const value=hash.digest('hex').slice(0,16)
  fingerprints.set(filePath,{key,value})
  return value
}
function artifactPath(inspection){return path.join(process.env.CODESK_ARTIFACT_DIR || path.join(os.homedir(),'.codesk','artifacts'),`codeskd-${inspection.os}-${inspection.arch}`)}
function localArtifactFor(inspection){
  const candidates=[artifactPath(inspection),path.resolve(process.cwd(),'dist',`codeskd-${inspection.os}-${inspection.arch}`)]
  if(inspection.os==='Linux')candidates.push(path.resolve(process.cwd(),`target/${inspection.arch}-unknown-linux-musl/release/codeskd`),path.resolve(process.cwd(),`target/${inspection.arch}-unknown-linux-gnu/release/codeskd`))
  if(matchesLocalPlatform(inspection))candidates.push(path.resolve(process.cwd(),'target/release/codeskd'),path.resolve(process.cwd(),'target/debug/codeskd'))
  // Newest wins: the artifacts cache would otherwise shadow a freshly built
  // target/ binary forever and keep re-installing an outdated daemon.
  return candidates
    .filter((candidate)=>fs.existsSync(candidate))
    .map((candidate)=>({candidate,mtime:fs.statSync(candidate).mtimeMs}))
    .sort((left,right)=>right.mtime-left.mtime)[0]?.candidate||''
}
// Release assets are named after each platform's native `uname -m`:
// codeskd-Darwin-arm64 and codeskd-Linux-aarch64. Normalizing both spellings
// to aarch64 made every Darwin arm64 download 404.
// The install command curls this URL and executes what comes back, as the
// remote user, on every configured host. The release channel the operator
// configured is the only thing that earns that, so an artifact URL supplied
// by an API caller has to live under it.
export function assertReleaseArtifactUrl(artifactUrl){
  const base=process.env.CODESK_DAEMON_RELEASE_BASE_URL
  if(!base)throw new Error('Installing codeskd from a URL requires CODESK_DAEMON_RELEASE_BASE_URL. Codesk copies a local or peer binary over SSH instead.')
  let parsed
  try{parsed=new URL(artifactUrl)}catch{throw new Error('The codeskd artifact must be an absolute URL')}
  if(parsed.protocol!=='https:'&&parsed.protocol!=='http:')throw new Error('The codeskd artifact must be served over HTTP(S)')
  const prefix=`${base.replace(/\/$/,'')}/`
  if(!parsed.href.startsWith(prefix))throw new Error(`The codeskd artifact must come from ${prefix}`)
}
function releaseArtifactUrl(inspection){
  const base=process.env.CODESK_DAEMON_RELEASE_BASE_URL
  if(!base)return ''
  const arch=inspection.os==='Darwin'
    ?(inspection.arch==='aarch64'?'arm64':inspection.arch)
    :(inspection.arch==='arm64'?'aarch64':inspection.arch)
  return `${base.replace(/\/$/,'')}/codeskd-${inspection.os}-${arch}`
}
