// Verifies that nothing Codesk starts locally outlives its owner.
//
// The rule under test is ARCHITECTURE.md §6.5: the gateway and the local
// `codeskd` are owned by the desktop app, and quitting the app — gracefully or
// by force-quit — must leave no Codesk process running. The negative case
// matters just as much: with no owner declared, the daemon must keep running,
// because `pnpm start`, `pnpm run dev`, the rest of this suite, and remote systemd
// daemons all depend on that.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const root = process.cwd()
const binary = path.join(root, 'target/debug/codeskd')
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'codesk-lifecycle-'))
const exec = promisify(execFile)
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const spawned = []

/// A stand-in for the desktop app: a process that does nothing but stay alive
/// until the test kills it.
function startOwner() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  spawned.push(child)
  return child
}

function startDaemon({ port, dataDir, ownerPid }) {
  const env = { ...process.env, CODESK_DATA_DIR: dataDir, CODESK_PORT: String(port) }
  if (ownerPid === undefined) delete env.CODESK_OWNER_PID
  else env.CODESK_OWNER_PID = String(ownerPid)
  const child = spawn(binary, [], { env, stdio: 'ignore' })
  spawned.push(child)
  return child
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

async function waitFor(description, callback, attempts = 120) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      if (await callback()) return true
    } catch {}
    await wait(100)
  }
  throw new Error(`timed out waiting for ${description}`)
}

async function healthy(port) {
  await waitFor(`daemon on ${port} to become healthy`, async () => (await fetch(`http://127.0.0.1:${port}/v1/health`)).ok)
}

async function jsonRequest(base, route, body) {
  const response = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

async function childPids(parentPid) {
  try {
    const { stdout } = await exec('pgrep', ['-P', String(parentPid)])
    return stdout.split(/\s+/).filter(Boolean).map(Number)
  } catch {
    return []
  }
}

const port = () => 4700 + Math.floor(Math.random() * 200)

try {
  // 1. An owned daemon exits when its owner is force-quit. SIGKILL is the case a
  //    graceful shutdown hook can never cover, so it is the one worth testing.
  {
    const daemonPort = port()
    const owner = startOwner()
    const daemon = startDaemon({ port: daemonPort, dataDir: path.join(temp, 'owned'), ownerPid: owner.pid })
    await healthy(daemonPort)
    owner.kill('SIGKILL')
    await waitFor('the owned daemon to exit after its owner was killed', () => daemon.exitCode !== null || daemon.signalCode !== null, 60)
    assert(!alive(daemon.pid), 'the owned daemon is still running after its owner died')
    console.log('ok - owned codeskd exited when its owner was force-quit')
  }

  // 2. An unowned daemon keeps running. This is the standalone contract the rest
  //    of the suite and remote systemd daemons rely on.
  {
    const daemonPort = port()
    const daemon = startDaemon({ port: daemonPort, dataDir: path.join(temp, 'unowned') })
    await healthy(daemonPort)
    await wait(2500)
    assert.equal(daemon.exitCode, null, 'an unowned daemon must not exit on its own')
    assert((await fetch(`http://127.0.0.1:${daemonPort}/v1/health`)).ok, 'an unowned daemon stopped serving')
    daemon.kill('SIGTERM')
    console.log('ok - unowned codeskd kept running with no CODESK_OWNER_PID')
  }

  // 3. Killing the app takes down the whole local tree: the gateway and the
  //    codeskd it spawned. The gateway also must not resurrect the daemon it just
  //    stopped, which its 1.5s respawn timer would otherwise do.
  {
    const daemonPort = port()
    const gatewayPort = port() + 200
    const clientData = path.join(temp, 'tree-client')
    const daemonData = path.join(temp, 'tree-daemon')
    await fs.mkdir(clientData, { recursive: true })
    await fs.writeFile(path.join(clientData, 'client-state.json'), JSON.stringify({
      hosts: [{ id: 'local', name: 'Lifecycle test', type: 'local', daemonPort, status: 'checking', createdAt: new Date().toISOString() }],
      drafts: [],
      navigationByHost: {},
    }))
    const owner = startOwner()
    const gateway = spawn(process.execPath, ['server/index.mjs'], {
      cwd: root,
      env: {
        ...process.env,
        PORT: String(gatewayPort),
        CODESK_CLIENT_DATA_DIR: clientData,
        CODESK_DATA_DIR: daemonData,
        CODESK_DAEMON_BINARY: binary,
        CODESK_OWNER_PID: String(owner.pid),
      },
      stdio: 'ignore',
    })
    spawned.push(gateway)
    await healthy(daemonPort)
    const daemonPids = await childPids(gateway.pid)
    assert(daemonPids.length > 0, 'the gateway did not spawn a local daemon')

    owner.kill('SIGKILL')
    await waitFor('the gateway to exit after its owner was killed', () => gateway.exitCode !== null || gateway.signalCode !== null, 80)
    await waitFor('the gateway-spawned daemon to exit', () => daemonPids.every((pid) => !alive(pid)), 80)
    // A respawn would come back 1.5s after the daemon exited.
    await wait(2500)
    assert(daemonPids.every((pid) => !alive(pid)), 'a daemon was respawned during shutdown')
    let served = true
    try { await fetch(`http://127.0.0.1:${daemonPort}/v1/health`) } catch { served = false }
    assert(!served, `something is still serving the daemon port ${daemonPort}`)
    console.log('ok - killing the owner tore down the gateway and its daemon, with no respawn')
  }

  // 4. Ownership is a set. One app instance quitting must not take the gateway
  //    away from another that is still running, and the gateway must refuse to be
  //    adopted by an app that did not start it.
  {
    const daemonPort = port()
    const gatewayPort = port() + 200
    const gatewayBase = `http://127.0.0.1:${gatewayPort}`
    const clientData = path.join(temp, 'owners-client')
    await fs.mkdir(clientData, { recursive: true })
    await fs.writeFile(path.join(clientData, 'client-state.json'), JSON.stringify({
      hosts: [{ id: 'local', name: 'Owners test', type: 'local', daemonPort, status: 'checking', createdAt: new Date().toISOString() }],
      drafts: [],
      navigationByHost: {},
    }))
    const first = startOwner()
    const second = startOwner()
    const gateway = spawn(process.execPath, ['server/index.mjs'], {
      cwd: root,
      env: {
        ...process.env,
        PORT: String(gatewayPort),
        CODESK_CLIENT_DATA_DIR: clientData,
        CODESK_DATA_DIR: path.join(temp, 'owners-daemon'),
        CODESK_DAEMON_BINARY: binary,
        CODESK_OWNER_PID: String(first.pid),
      },
      stdio: 'ignore',
    })
    spawned.push(gateway)
    await waitFor('the gateway to answer', async () => (await fetch(`${gatewayBase}/api/health`)).ok)

    const registered = await jsonRequest(gatewayBase, '/api/owners', { pid: second.pid })
    assert.equal(registered.status, 200, `registering a second owner failed: ${JSON.stringify(registered.body)}`)
    assert.deepEqual([...registered.body.owners].sort(), [first.pid, second.pid].sort())

    // A pid that never owned this gateway must not be able to stop it.
    const foreign = await jsonRequest(gatewayBase, '/api/shutdown', { pid: 999999 })
    assert.equal(foreign.body.stopped, false, 'a non-owner pid stopped the gateway')
    assert.deepEqual([...foreign.body.owners].sort(), [first.pid, second.pid].sort(), 'a foreign shutdown changed the owner set')

    const released = await jsonRequest(gatewayBase, '/api/shutdown', { pid: first.pid })
    assert.equal(released.body.stopped, false, 'the gateway stopped while another owner was still running')
    await wait(1500)
    assert.equal(gateway.exitCode, null, 'the gateway exited while a second owner was still alive')

    const last = await jsonRequest(gatewayBase, '/api/shutdown', { pid: second.pid })
    assert.equal(last.body.stopped, true, 'releasing the last owner did not stop the gateway')
    await waitFor('the gateway to exit after its last owner released it', () => gateway.exitCode !== null || gateway.signalCode !== null, 80)
    console.log('ok - gateway survived one owner quitting and stopped when the last released it')
  }

  // 5. A gateway started by hand belongs to the developer's terminal. Adopting it
  //    would mean quitting the desktop app kills `pnpm run dev`.
  {
    const daemonPort = port()
    const gatewayPort = port() + 200
    const gatewayBase = `http://127.0.0.1:${gatewayPort}`
    const clientData = path.join(temp, 'unowned-client')
    await fs.mkdir(clientData, { recursive: true })
    await fs.writeFile(path.join(clientData, 'client-state.json'), JSON.stringify({
      hosts: [{ id: 'local', name: 'Unowned gateway', type: 'local', daemonPort, status: 'checking', createdAt: new Date().toISOString() }],
      drafts: [],
      navigationByHost: {},
    }))
    const env = {
      ...process.env,
      PORT: String(gatewayPort),
      CODESK_CLIENT_DATA_DIR: clientData,
      CODESK_DATA_DIR: path.join(temp, 'unowned-daemon'),
      CODESK_DAEMON_BINARY: binary,
    }
    delete env.CODESK_OWNER_PID
    const gateway = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env, stdio: 'ignore' })
    spawned.push(gateway)
    await waitFor('the unowned gateway to answer', async () => (await fetch(`${gatewayBase}/api/health`)).ok)
    const owner = startOwner()
    const refused = await jsonRequest(gatewayBase, '/api/owners', { pid: owner.pid })
    assert.equal(refused.status, 409, 'an unowned gateway accepted an owner')
    // The decisive case for the developer workflow: a desktop app quitting sends
    // its pid to /api/shutdown. A hand-started gateway must ignore it rather than
    // taking `pnpm run dev` down with the app.
    const quit = await jsonRequest(gatewayBase, '/api/shutdown', { pid: owner.pid })
    assert.equal(quit.body.stopped, false, 'a desktop app quitting stopped an unowned dev gateway')
    await wait(1000)
    assert.equal(gateway.exitCode, null, 'an unowned gateway exited when an app instance quit')
    owner.kill('SIGKILL')
    await wait(1500)
    assert.equal(gateway.exitCode, null, 'an unowned gateway exited when an unrelated process died')
    console.log('ok - unowned gateway refused adoption, survived an app quit, and ignored unrelated exits')
  }

  console.log('ok - local process lifetime is bound to the owning app')
} finally {
  for (const child of spawned.reverse()) {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL') } catch {}
    }
  }
  await wait(300)
  await fs.rm(temp, { recursive: true, force: true })
}
