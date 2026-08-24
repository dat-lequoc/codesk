// Live test: connecting an SSH host that has no codeskd must install and start
// the daemon automatically, with no manual install step.
//
//   CODESK_BOOTSTRAP_TARGET=vps-2 CODESK_BOOTSTRAP_PEER=vps-1 \
//     node scripts/test-remote-bootstrap-live.mjs
//
// The target must be reachable by `ssh <alias>`; the test repeatedly removes
// codeskd there, so point it at a host you are willing to reprovision. The
// optional peer must be an already-provisioned host of the same os/arch.
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { Store } from '../server/store.mjs'
import { Gateway } from '../server/gateway.mjs'

const execFileAsync = promisify(execFile)
const target = process.env.CODESK_BOOTSTRAP_TARGET
const peer = process.env.CODESK_BOOTSTRAP_PEER
if (!target) { console.log('skip - set CODESK_BOOTSTRAP_TARGET to an ssh alias to run this live test'); process.exit(0) }

const repoRoot = process.cwd()
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'codesk-bootstrap-'))
process.env.CODESK_ARTIFACT_DIR = path.join(temp, 'artifacts')
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const ssh = (alias, script) => execFileAsync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', alias, `sh -c '${script.replaceAll("'", "'\\''")}'`], { timeout: 60000 })

async function uninstall(alias) {
  // Order matters: removing the unit file first makes `disable --now` fail
  // before it ever stops the running daemon, which would leave a live process
  // (and a listening port) behind and silently pass the test.
  await ssh(alias, 'systemctl --user stop codeskd.service >/dev/null 2>&1 || true; systemctl --user disable codeskd.service >/dev/null 2>&1 || true; rm -f "$HOME/.config/systemd/user/codeskd.service" "$HOME/.local/bin/codeskd"; systemctl --user daemon-reload >/dev/null 2>&1 || true; systemctl --user reset-failed >/dev/null 2>&1 || true; pkill -x codeskd >/dev/null 2>&1 || true; sleep 1')
  const { stdout } = await ssh(alias, 'PATH="$HOME/.local/bin:$PATH"; command -v codeskd || echo no-binary; pgrep -x codeskd || echo no-process; (ss -lnt 2>/dev/null || netstat -lnt) | grep -c ":4243 " || true')
  const [binary, daemon, listeners] = stdout.trim().split('\n')
  if (binary !== 'no-binary' || daemon !== 'no-process' || listeners.trim() !== '0') throw new Error(`${alias} is not a clean slate: binary=${binary} process=${daemon} listeners=${listeners}`)
}

async function online(host, seconds = 180) {
  for (let attempt = 0; attempt < seconds * 2; attempt++) {
    if (host.status === 'online') return
    if (host.bootstrapError) throw new Error(host.bootstrapError)
    await wait(500)
  }
  throw new Error(`${host.name} did not come online: status=${host.status} error=${host.error}`)
}

const store = new Store(path.join(temp, 'data'))
const gateway = new Gateway(store, () => {})

// Drops the tunnel and any pending reconnect so the next connect() is a fresh
// first contact, the way a newly added host behaves.
async function reset(host) {
  const child = gateway.processes.get(host.id)
  if (child) { child.kill('SIGTERM'); await wait(400) }
  gateway.closeEvents(host.id)
  for (const [key, timer] of gateway.pollers) if (key.endsWith(host.id)) clearTimeout(timer)
  gateway.processes.delete(host.id)
  gateway.bootstrapAttempts.delete(host.id)
  gateway.lastBootstrap = null
  host.status = 'offline'; host.error = null; host.bootstrapError = null
}

async function firstConnect(host, label) {
  await uninstall(host.sshAlias)
  await reset(host)
  await gateway.connect(host.id)
  await online(host)
  const result = gateway.lastBootstrap
  if (!result?.ok) throw new Error(`${label}: expected an automatic install, got ${JSON.stringify(result)}`)
  if (!host.health?.ok) throw new Error(`${label}: host is online without a daemon health payload`)
  return result
}

try {
  const host = { id: randomUUID(), name: target, type: 'ssh', sshAlias: target, daemonPort: 4243, status: 'offline', createdAt: new Date().toISOString() }
  store.state.hosts.push(host)

  const local = await firstConnect(host, 'local artifact')
  const localStat = await fs.stat(local.binary)
  if (!localStat.size) throw new Error('installed artifact is empty')
  console.log(`ok - first connect to an unprovisioned host installed codeskd ${host.health.version} automatically from ${path.relative(repoRoot, local.binary)}`)

  if (peer) {
    const record = { id: randomUUID(), name: peer, type: 'ssh', sshAlias: peer, daemonPort: 4243, status: 'offline', createdAt: new Date().toISOString() }
    store.state.hosts.push(record)
    await gateway.connect(record.id)
    await online(record, 90)

    // Move off the repo so no locally built artifact is discoverable: the only
    // remaining source is the peer that already runs codeskd.
    process.chdir(temp)
    const seeded = await firstConnect(host, 'peer seeding')
    const cache = path.join(process.env.CODESK_ARTIFACT_DIR, `codeskd-${seeded.inspection.os}-${seeded.inspection.arch}`)
    if (seeded.binary !== cache) throw new Error(`expected the peer-seeded cache at ${cache}, used ${seeded.binary}`)
    const cached = await fs.stat(cache)
    console.log(`ok - with no local artifact, the install pulled codeskd from provisioned peer ${peer} and cached ${cached.size} bytes`)

    // Same situation minus the peer: the cache alone must be enough.
    store.state.hosts = store.state.hosts.filter((item) => item.id !== record.id)
    const child = gateway.processes.get(record.id)
    if (child) child.kill('SIGTERM')
    gateway.closeEvents(record.id)
    const reused = await firstConnect(host, 'cached artifact')
    if (reused.binary !== cache) throw new Error(`expected the cached artifact to be reused, used ${reused.binary}`)
    console.log('ok - a later host installs from the cached artifact with no peer and no repo build present')
  }
} finally {
  process.chdir(repoRoot)
  for (const child of gateway.processes.values()) child.kill('SIGTERM')
  for (const timer of gateway.pollers.values()) clearTimeout(timer)
  for (const host of store.state.hosts) gateway.closeEvents(host.id)
  // Tunnel exit handlers may still be queued; stop them from writing state into
  // the temp directory we are about to delete.
  store.save = () => {}
  await wait(500)
  for (const timer of gateway.pollers.values()) clearTimeout(timer)
  await fs.rm(temp, { recursive: true, force: true })
}
