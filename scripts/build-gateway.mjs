import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const root = process.cwd()
const output = path.join(root, 'src-tauri', 'binaries', 'codesk-gateway')
const bundle = path.join(root, 'target', 'codesk-gateway.cjs')
await fs.mkdir(path.dirname(output), { recursive: true })
await fs.mkdir(path.dirname(bundle), { recursive: true })
await exec('npx', ['--yes', 'esbuild', path.join(root, 'server', 'index.mjs'), '--bundle', '--platform=node', '--format=cjs', `--outfile=${bundle}`], { cwd: root, maxBuffer: 10 * 1024 * 1024 })
await exec('npx', ['--yes', '@yao-pkg/pkg', bundle, '--targets', 'node22-macos-arm64', '--output', output], { cwd: root, maxBuffer: 10 * 1024 * 1024 })
await fs.chmod(output, 0o755)
console.log(output)
