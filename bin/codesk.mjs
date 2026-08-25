#!/usr/bin/env node
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

if (args[0] === 'web') {
  console.log('Starting Codesk web mode on port 4000...')
  const p = spawn('npm', ['run', 'start:web'], {
    cwd: root,
    stdio: 'inherit',
  })
  p.on('exit', (code) => process.exit(code || 0))
} else {
  console.error('Usage: codesk web')
  process.exit(1)
}
