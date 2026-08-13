import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const exec = promisify(execFile)
const root = process.cwd(); const binary = path.join(root, 'target/debug/codeskd'); const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'codesk-worktree-')); const repo = path.join(temp, 'repo'); const data = path.join(temp, 'data'); const port = 4700 + Math.floor(Math.random() * 200); const base = `http://127.0.0.1:${port}`
await fs.mkdir(repo); await exec('git', ['init', '-b', 'main'], { cwd: repo }); await exec('git', ['config', 'user.email', 'codesk@example.test'], { cwd: repo }); await exec('git', ['config', 'user.name', 'Codesk Test'], { cwd: repo }); await fs.writeFile(path.join(repo, 'README.md'), '# test\n'); await exec('git', ['add', '.'], { cwd: repo }); await exec('git', ['commit', '-m', 'initial'], { cwd: repo })
let daemon = spawn(binary, [], { env: { ...process.env, CODESK_DATA_DIR: data, CODESK_PORT: String(port) }, stdio: 'ignore' })
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)); async function request(route, options) { const response = await fetch(`${base}${route}`, { ...options, headers: { 'content-type': 'application/json', ...options?.headers } }); const body = await response.json(); if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`); return body }
try {
  for (let i=0;i<60;i++){try{await request('/v1/health');break}catch{await wait(100)}}
  const project=await request('/v1/projects',{method:'POST',body:JSON.stringify({name:'worktree-test',path:repo})})
  const run=await request('/v1/runs',{method:'POST',body:JSON.stringify({project_id:project.id,provider:'shell',prompt:'isolated write',workspace_mode:'managed_worktree',base_ref:'main',command:'sh',args:['-c','echo isolated > result.txt']})})
  for(let i=0;i<40;i++){const state=await request(`/v1/runs/${run.id}`);if(state.status==='completed')break;await wait(100)}
  const finished=await request(`/v1/runs/${run.id}`);if(finished.status!=='completed'||!finished.worktree_id)throw new Error(`unexpected run state ${finished.status}`)
  if(await fs.readFile(path.join(repo,'result.txt'),'utf8').catch(()=>null))throw new Error('main checkout was modified')
  if((await fs.readFile(path.join(finished.cwd,'result.txt'),'utf8')).trim()!=='isolated')throw new Error('worktree output missing')
  const trees=await request(`/v1/projects/${project.id}/worktrees`);if(trees.length!==1||trees[0].status!=='ready')throw new Error('managed worktree not registered')
  await request(`/v1/worktrees/${trees[0].id}?force=true`,{method:'DELETE'});if(await fs.stat(finished.cwd).then(()=>true).catch(()=>false))throw new Error('managed worktree was not removed');const retained=await request(`/v1/projects/${project.id}/worktrees`);if(retained[0].status!=='removed')throw new Error('worktree history was not retained')
  console.log(`ok - managed worktree ${trees[0].id} isolated the run and was removed safely`)
} finally { if(daemon.exitCode===null)daemon.kill('SIGINT'); await fs.rm(temp,{recursive:true,force:true}) }
