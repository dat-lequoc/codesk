import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

// Stage a release codeskd where tauri.conf.json bundle resources expect it.
// Bundling straight from target/ made every desktop build ship whatever
// profile happened to be there last — including debug binaries.
const exec = promisify(execFile)
const root = process.cwd()
const output = path.join(root, 'src-tauri', 'binaries', 'codeskd')
await exec('cargo', ['build', '--release', '-p', 'codeskd'], { cwd: root, maxBuffer: 10 * 1024 * 1024 })
await fs.mkdir(path.dirname(output), { recursive: true })
await fs.copyFile(path.join(root, 'target', 'release', 'codeskd'), output)
await fs.chmod(output, 0o755)
console.log(output)
