#!/usr/bin/env node
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

if (args[0] === 'web') {
  const port = process.env.PORT || '4000'
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(600) })
    if (res.ok) {
      const data = await res.json()
      if (data.service === 'codesk-gateway') {
        console.log(`Codesk web mode is already running at http://127.0.0.1:${port}`)
        process.exit(0)
      }
    }
  } catch {}

  console.log(`Starting Codesk web mode on port ${port}...`)
  const p = spawn('npm', ['run', 'start:web'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, PORT: String(port) },
  })
  p.on('exit', (code) => process.exit(code || 0))
} else {
  console.error('Usage: codesk web')
  process.exit(1)
}
