import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = process.cwd(); const binary = path.join(root, 'target/debug/codeskd'); const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'codesk-discovery-')); const data = path.join(temp, 'data'); const repos = path.join(temp, 'repos'); const port = 4900 + Math.floor(Math.random() * 80); const base = `http://127.0.0.1:${port}`
await fs.mkdir(path.join(repos, 'alpha', '.git'), { recursive: true }); await fs.mkdir(path.join(repos, 'nested', 'beta', '.git'), { recursive: true }); await fs.mkdir(path.join(repos, 'plain'), { recursive: true })
let daemon = spawn(binary, [], { env: { ...process.env, CODESK_DATA_DIR: data, CODESK_PORT: String(port) }, stdio: 'ignore' })
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)); async function request(route, options) { const response = await fetch(`${base}${route}`, { ...options, headers: { 'content-type': 'application/json', ...options?.headers } }); const body = await response.json(); if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`); return body }
try {
  for (let i=0;i<60;i++){try{await request('/v1/health');break}catch{await wait(100)}}
  const files = await request(`/v1/files?path=${encodeURIComponent(repos)}`); if (!files.some((entry) => entry.name === 'alpha' && entry.is_git)) throw new Error('folder browser did not identify Git project')
  const discovered = await request('/v1/projects/discover', { method: 'POST', body: JSON.stringify({ path: repos, max_depth: 2, register: true }) }); if (discovered.length !== 2 || discovered.some((item) => !item.registered_project_id)) throw new Error(`unexpected discovery result ${JSON.stringify(discovered)}`)
  const projects = await request('/v1/projects'); if (projects.length !== 2) throw new Error('discovered projects were not registered')
  const agents = await request('/v1/agents/discover'); if (!Array.isArray(agents)) throw new Error('agent discovery response is invalid')
  console.log(`ok - browsed host folders, discovered and registered ${projects.length} projects, and inspected external agents read-only`)
} finally { if (daemon.exitCode === null) daemon.kill('SIGINT'); await fs.rm(temp, { recursive: true, force: true }) }
