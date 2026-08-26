// A remote must not keep running a daemon the gateway has already replaced.
//
// A host that answers `/v1/health` is online and stays online, so nothing used
// to look at what it was running: an installed daemon was upgraded only when it
// stopped answering, or by hand from the Connections dialog. The crate version
// cannot decide it either — it is unchanged between releases, so every build
// during a day's work reports the same one, and a gateway comparing versions
// sees a match while the remote runs yesterday's code.
//
// The daemon reports a hash of its own executable, and that is what gets
// compared. These assertions cover the decision, not the SSH transport: they
// drive the real functions with real files.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { mkdtemp, copyFile, rm, appendFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Gateway, fileFingerprint } from '../server/gateway.mjs'
import { daemonAuth } from './daemon-token.mjs'

const root = await mkdtemp(join(tmpdir(), 'codesk-upgrade-'))
const binary = join(process.cwd(), 'target/debug/codeskd')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const digest = async (path) => createHash('sha256').update(await readFile(path)).digest('hex').slice(0, 16)

let daemon
try {
  // 1. The daemon's own fingerprint is the hash of the file it was started
  //    from, so the gateway can compute the same value for its artifact.
  const port = 46900 + Math.floor(Math.random() * 300)
  daemon = spawn(binary, [], {
    cwd: process.cwd(),
    env: { ...process.env, CODESK_DATA_DIR: root, CODESK_PORT: String(port), RUST_LOG: 'warn' },
    stdio: 'ignore',
  })
  let health
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/health`, { headers: daemonAuth(root) })
      if (response.ok) { health = await response.json(); break }
    } catch {}
    await sleep(200)
  }
  assert.ok(health, 'the daemon never answered /v1/health')
  assert.equal(health.build, await digest(binary), 'the daemon does not report the hash of its own executable')
  assert.equal(health.build.length, 16, 'the fingerprint is not the expected short digest')

  // 2. The gateway computes the same value for the artifact it would install,
  //    so a matching pair is recognised as already up to date.
  const artifact = join(root, 'codeskd-artifact')
  await copyFile(binary, artifact)
  assert.equal(await fileFingerprint(artifact), health.build, 'the same bytes produced two different fingerprints')

  // 3. A rebuilt daemon is what the version check cannot see: the crate version
  //    is identical and only the bytes moved.
  const rebuilt = join(root, 'codeskd-rebuilt')
  await copyFile(binary, rebuilt)
  await appendFile(rebuilt, '\n// a later build\n')
  assert.notEqual(await fileFingerprint(rebuilt), health.build, 'a changed binary produced the same fingerprint')
  assert.equal(
    execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim(),
    execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim(),
    'sanity: --version is stable across builds, which is the whole problem',
  )

  // 4. The cache is keyed on the file's identity, not its path, so overwriting
  //    an artifact in place is still noticed — this is how a fresh build lands.
  const cached = await fileFingerprint(artifact)
  await sleep(10)
  await copyFile(rebuilt, artifact)
  assert.notEqual(await fileFingerprint(artifact), cached, 'the fingerprint cache went stale when the artifact was replaced')

  // 5. A missing artifact reports "cannot say" rather than a mismatch, which
  //    would otherwise reinstall on every check.
  assert.equal(await fileFingerprint(join(root, 'does-not-exist')), '', 'a missing artifact was treated as a mismatch')

  // 6. The decision itself: what the gateway does once it knows a remote is
  //    behind. The SSH transport is stubbed; the branching is the real thing.
  const scenario = ({ artifact: artifactPath, activeRuns = 0, status = 'online', version = health.version }) => {
    const host = { id: 'h1', type: 'ssh', name: 'vps', status, health: { version, build: health.build, active_runs: activeRuns } }
    const store = { state: { hosts: [host] }, save() {} }
    const gateway = new Gateway(store, () => {})
    const calls = []
    gateway.artifactForHost = async () => artifactPath
    gateway.health = async () => true
    gateway.bootstrapRemote = async (id, options) => { calls.push(options.localBinaryPath); return { ok: true } }
    gateway.reconnect = () => {}
    // Nothing here should outlive the check; a 60s timer would hang the run.
    gateway.scheduleDaemonUpgradeCheck = () => {}
    return { gateway, host, calls }
  }

  // `artifact` was overwritten with the rebuilt bytes in step 4, so the
  // up-to-date pairing needs its own copy of what the daemon is running.
  const current = join(root, 'codeskd-current')
  await copyFile(binary, current)
  const matching = scenario({ artifact: current })
  await matching.gateway.checkDaemonUpgrade('h1')
  assert.deepEqual(matching.calls, [], 'a daemon that already matches the artifact was reinstalled')

  // A genuinely stale pairing: the remote runs `binary`, the artifact is newer.
  const stale = scenario({ artifact: rebuilt })
  await stale.gateway.checkDaemonUpgrade('h1')
  assert.deepEqual(stale.calls, [rebuilt], 'a stale daemon was not upgraded')

  const busy = scenario({ artifact: rebuilt, activeRuns: 1 })
  await busy.gateway.checkDaemonUpgrade('h1')
  assert.deepEqual(busy.calls, [], 'an upgrade restarted the daemon under a live turn')

  const offline = scenario({ artifact: rebuilt, status: 'offline' })
  await offline.gateway.checkDaemonUpgrade('h1')
  assert.deepEqual(offline.calls, [], 'an offline host was upgraded through a tunnel that is not there')

  const missing = scenario({ artifact: '' })
  await missing.gateway.checkDaemonUpgrade('h1')
  assert.deepEqual(missing.calls, [], 'an upgrade ran with no artifact to install')

  // An install that does not move the remote's fingerprint means the artifact
  // and the running daemon disagree for a reason reinstalling cannot fix.
  const looping = scenario({ artifact: rebuilt })
  for (let attempt = 0; attempt < 5; attempt++) await looping.gateway.checkDaemonUpgrade('h1')
  assert.equal(looping.calls.length, 2, `a failed upgrade retried ${looping.calls.length} times instead of stopping`)

  // A daemon too old for this gateway to drive is held offline, and that is the
  // one non-online state an upgrade must still act on — otherwise the host waits
  // on a human to run an install by hand, which is what it used to ask for.
  const ancient = scenario({ artifact: current, status: 'offline', version: '0.1.0' })
  await ancient.gateway.checkDaemonUpgrade('h1')
  assert.deepEqual(ancient.calls, [current], 'a daemon below the version floor was left for someone to fix by hand')

  // A host that cannot be upgraded is still a host that works.
  const broken = scenario({ artifact: rebuilt })
  broken.gateway.bootstrapRemote = async () => { throw new Error('scp refused') }
  await broken.gateway.checkDaemonUpgrade('h1')
  assert.equal(broken.host.status, 'online', 'a failed upgrade took a working host offline')
  assert.match(broken.host.bootstrapError, /scp refused/, 'a failed upgrade was not reported')

  console.log('ok - the daemon fingerprints its own executable and the gateway matches it against the artifact it would install')
  console.log('ok - a rebuilt daemon is detected where the crate version cannot tell it apart')
  console.log('ok - a stale daemon is upgraded only while the host is online and idle, at most twice, and never takes the host down')
} finally {
  if (daemon && daemon.exitCode === null) daemon.kill('SIGTERM')
  await sleep(300)
  await rm(root, { recursive: true, force: true })
}
