import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const bundleId = 'app.codesk.desktop'
const installedApp = '/Applications/Codesk.app'
const release = process.argv.includes('--release')
const profile = release ? 'release' : 'debug'
const builtApp = path.join(root, 'target', profile, 'bundle', 'macos', 'Codesk.app')

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function command(commandName, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { capture = false, allowFailure = false, ...spawnOptions } = options
    const child = spawn(commandName, args, {
      cwd: root,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      ...spawnOptions,
    })
    let stdout = ''
    let stderr = ''
    if (capture) {
      child.stdout.on('data', (chunk) => { stdout += chunk })
      child.stderr.on('data', (chunk) => { stderr += chunk })
    }
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0 || allowFailure) resolve({ code, stdout, stderr })
      else reject(new Error(`${commandName} ${args.join(' ')} failed with exit code ${code}\n${stderr}`))
    })
  })
}

async function cua(tool, input, options = {}) {
  const result = await command('cua-driver', [tool, JSON.stringify(input)], {
    capture: true,
    allowFailure: options.allowFailure,
  })
  if (result.code !== 0) return result
  return options.parseJson === false ? result : { ...result, value: JSON.parse(result.stdout) }
}

async function ensureCuaDriver() {
  const status = await command('cua-driver', ['status'], { capture: true, allowFailure: true })
  if (status.code !== 0 || !status.stdout.includes('daemon is running')) {
    await command('cua-driver', ['serve'], { capture: true })
  }
  const permissions = await command(
    'cua-driver',
    ['check_permissions', JSON.stringify({ prompt: false })],
    { capture: true },
  )
  if (!permissions.stdout.includes('Accessibility: granted') || !permissions.stdout.includes('Screen Recording: granted')) {
    throw new Error('CuaDriver needs Accessibility and Screen Recording permissions before Codesk can be restarted safely.')
  }
}

function mainWindow(app) {
  return [...(app.windows || [])]
    .filter((window) => window.title === 'Codesk' || window.is_on_screen)
    .sort((left, right) => right.bounds.width * right.bounds.height - left.bounds.width * left.bounds.height)[0]
}

async function stopInstalledApp() {
  const app = (await cua('launch_app', { bundle_id: bundleId })).value
  const window = mainWindow(app)
  if (!window) throw new Error('Codesk launched without an inspectable window; refusing to replace a possibly running app.')
  await cua('get_window_state', { pid: app.pid, window_id: window.window_id })
  await cua('hotkey', { pid: app.pid, keys: ['cmd', 'q'] }, { parseJson: false })
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const snapshot = await cua(
      'get_window_state',
      { pid: app.pid, window_id: window.window_id },
      { allowFailure: true },
    )
    if (snapshot.code !== 0) {
      await wait(500)
      return
    }
    await wait(100)
  }
  throw new Error('Codesk did not quit within five seconds; the installed app was not replaced.')
}

async function listenerPids(port) {
  const result = await command(
    'lsof',
    ['-nP', `-tiTCP:${port}`, '-sTCP:LISTEN'],
    { capture: true, allowFailure: true },
  )
  if (result.code !== 0) return []
  return result.stdout
    .split(/\s+/)
    .filter(Boolean)
    .map(Number)
    .filter(Number.isInteger)
}

async function stopListener(port, expectedCommand) {
  const pids = await listenerPids(port)
  for (const pid of pids) {
    const inspected = await command(
      'ps',
      ['-p', String(pid), '-o', 'command='],
      { capture: true },
    )
    if (!inspected.stdout.includes(expectedCommand)) {
      throw new Error(`Port ${port} belongs to unexpected process ${inspected.stdout.trim()}; refusing to stop it.`)
    }
  }
  for (const pid of pids) process.kill(pid, 'SIGTERM')
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ((await listenerPids(port)).length === 0) return
    await wait(100)
  }
  throw new Error(`${expectedCommand} did not release port ${port} within five seconds.`)
}

async function stopLocalServices() {
  await stopListener(4242, 'codesk-gateway')
  await stopListener(4243, 'codeskd')
}

async function installBundle() {
  const stamp = new Date().toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/, 'Z')
  const backupRoot = path.join(os.homedir(), 'Library', 'Caches', 'Codesk', 'deploy-backups', stamp)
  const backupApp = path.join(backupRoot, 'Codesk.app')
  let backedUp = false
  await fs.mkdir(backupRoot, { recursive: true })
  try {
    await fs.access(installedApp)
    await fs.rename(installedApp, backupApp)
    backedUp = true
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  try {
    await fs.cp(builtApp, installedApp, { recursive: true, preserveTimestamps: true })
  } catch (error) {
    if (backedUp) await fs.rename(backupApp, installedApp).catch(() => {})
    throw error
  }
  return backedUp ? backupApp : null
}

async function waitForGateway(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  let lastError = 'gateway did not become ready'
  while (Date.now() < deadline) {
    try {
      const response = await fetch('http://127.0.0.1:4242/api/state')
      if (response.ok) {
        const state = await response.json()
        if (state.hosts?.some((host) => host.id === 'local' && host.status === 'online')) return state
        lastError = 'local execution host is not online yet'
      } else lastError = `gateway returned HTTP ${response.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await wait(400)
  }
  throw new Error(`Gateway readiness check timed out: ${lastError}`)
}

async function launchAndVerify() {
  const app = (await cua('launch_app', { bundle_id: bundleId })).value
  const window = mainWindow(app)
  if (!window) throw new Error('The rebuilt Codesk app launched without a window.')
  await waitForGateway()
  const screenshot = path.join(os.tmpdir(), `codesk-redeploy-${Date.now()}.png`)
  let lastTree = ''
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const snapshot = (await cua('get_window_state', {
      pid: app.pid,
      window_id: window.window_id,
      screenshot_out_file: screenshot,
    })).value
    lastTree = snapshot.tree_markdown || ''
    if (lastTree.includes('Project actions for') && !lastTree.includes('Load failed')) {
      return { pid: app.pid, screenshot }
    }
    await wait(250)
  }
  throw new Error(`Codesk launched, but its project navigation did not finish loading. Last UI snapshot:\n${lastTree.slice(0, 4000)}`)
}

if (process.platform !== 'darwin') throw new Error('desktop:redeploy currently supports macOS only.')

await command('npm', [
  'run',
  'desktop:build',
  '--',
  ...(release ? ['--release'] : ['--debug']),
  '--bundles',
  'app',
])
await ensureCuaDriver()
await stopInstalledApp()
await stopLocalServices()
const backup = await installBundle()
const launched = await launchAndVerify()

console.log(`Codesk ${profile} build installed and running as PID ${launched.pid}.`)
if (backup) console.log(`Rollback bundle: ${backup}`)
console.log(`Launch verification screenshot: ${launched.screenshot}`)
