#!/usr/bin/env node
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

if (args[0] !== 'web') {
  console.error('Usage: codesk web')
  process.exit(1)
}

const port = process.env.PORT || '4000'
const url = `http://127.0.0.1:${port}`
try {
  const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(600) })
  if (response.ok && (await response.json()).service === 'codesk-gateway') {
    console.log(`Codesk web mode is already running at ${url}`)
    process.exit(0)
  }
} catch {
  // Nothing answering yet, or something that is not Codesk. Starting up will
  // report EADDRINUSE if the port belongs to someone else.
}

console.log(`Starting Codesk web mode on port ${port}...`)
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const child = spawn(pnpm, ['run', 'start:web'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, PORT: String(port) },
})
child.on('error', (cause) => {
  console.error(`Could not start ${pnpm}: ${cause.message}`)
  process.exit(1)
})
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)))
