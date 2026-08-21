import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const root = process.cwd()
const output = path.join(root, 'src-tauri', 'binaries', 'codesk-gateway')
const bundle = path.join(root, 'target', 'codesk-gateway.cjs')
// Package for the machine we are building on (or an explicit override), not a
// hardcoded arm64: an Intel Mac cannot run an arm64 gateway, and Rosetta does
// not translate in that direction.
const arch = process.env.CODESK_GATEWAY_ARCH || (process.arch === 'arm64' ? 'arm64' : 'x64')
const platform = process.platform === 'darwin' ? 'macos' : process.platform
const target = `node22-${platform}-${arch}`
await fs.mkdir(path.dirname(output), { recursive: true })
await fs.mkdir(path.dirname(bundle), { recursive: true })
await exec('npx', ['--yes', 'esbuild', path.join(root, 'server', 'index.mjs'), '--bundle', '--platform=node', '--format=cjs', `--outfile=${bundle}`], { cwd: root, maxBuffer: 10 * 1024 * 1024 })
await exec('npx', ['--yes', '@yao-pkg/pkg', bundle, '--targets', target, '--output', output], { cwd: root, maxBuffer: 10 * 1024 * 1024 })
await fs.chmod(output, 0o755)
console.log(`${output} (${target})`)
