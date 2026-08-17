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
  const context=await request(`/v1/projects/${project.id}/git-context`);if(!context.available||context.branch!=='main'||context.detached||context.dirty)throw new Error(`unexpected Git context ${JSON.stringify(context)}`)
  const run=await request('/v1/runs',{method:'POST',body:JSON.stringify({project_id:project.id,provider:'shell',prompt:'isolated write',workspace_mode:'managed_worktree',base_ref:'main',command:'sh',args:['-c','echo isolated > result.txt']})})
  for(let i=0;i<40;i++){const state=await request(`/v1/runs/${run.id}`);if(state.status==='completed')break;await wait(100)}
  const finished=await request(`/v1/runs/${run.id}`);if(finished.status!=='completed'||!finished.worktree_id)throw new Error(`unexpected run state ${finished.status}`)
  if(await fs.readFile(path.join(repo,'result.txt'),'utf8').catch(()=>null))throw new Error('main checkout was modified')
  if((await fs.readFile(path.join(finished.cwd,'result.txt'),'utf8')).trim()!=='isolated')throw new Error('worktree output missing')
  const trees=await request(`/v1/projects/${project.id}/worktrees`);if(trees.length!==1||trees[0].status!=='ready')throw new Error('managed worktree not registered')
  await request(`/v1/worktrees/${trees[0].id}?force=true`,{method:'DELETE'});if(await fs.stat(finished.cwd).then(()=>true).catch(()=>false))throw new Error('managed worktree was not removed');const retained=await request(`/v1/projects/${project.id}/worktrees`);if(retained[0].status!=='removed')throw new Error('worktree history was not retained')

  const mergeRun=await request('/v1/runs',{method:'POST',body:JSON.stringify({project_id:project.id,provider:'shell',prompt:'commit an isolated change',workspace_mode:'managed_worktree',command:'sh',args:['-c','set -eu; printf "%s\n%s\n%s\n" "$CODESK_PROJECT_PATH" "$CODESK_WORKTREE_BRANCH" "$CODESK_MERGE_TARGET" > workspace-context.txt; printf merged > merged.txt; git add workspace-context.txt merged.txt; git commit -m "managed worktree change"']})})
  for(let i=0;i<40;i++){const state=await request(`/v1/runs/${mergeRun.id}`);if(state.status==='completed')break;await wait(100)}
  const mergeFinished=await request(`/v1/runs/${mergeRun.id}`);if(mergeFinished.status!=='completed'||!mergeFinished.worktree_id){const stderr=await fs.readFile(path.join(data,'runs',mergeRun.id,'stderr.log'),'utf8').catch(()=>'(no stderr)');throw new Error(`merge fixture run failed: ${JSON.stringify(mergeFinished)}\n${stderr}`)}
  const mergeTree=(await request(`/v1/projects/${project.id}/worktrees`)).find((item)=>item.id===mergeFinished.worktree_id);if(!mergeTree||mergeTree.base_ref!=='main')throw new Error(`worktree did not retain normalized merge target: ${JSON.stringify(mergeTree)}`)
  const runnerSpec=JSON.parse(await fs.readFile(path.join(data,'runs',mergeRun.id,'runner.json'),'utf8'));if(!runnerSpec.prompt.includes('<environment_context>')||!runnerSpec.prompt.includes('CODESK_WORKTREE_BRANCH')||runnerSpec.env.CODESK_PROJECT_PATH!==project.path||runnerSpec.env.CODESK_WORKTREE_ID!==mergeTree.id)throw new Error('managed run did not receive workspace merge context')
  const workspaceContext=(await fs.readFile(path.join(mergeFinished.cwd,'workspace-context.txt'),'utf8')).trim().split('\n');if(workspaceContext[0]!==project.path||workspaceContext[1]!==mergeTree.branch||workspaceContext[2]!=='main')throw new Error(`unexpected workspace environment ${JSON.stringify(workspaceContext)}`)
  if(await fs.readFile(path.join(repo,'merged.txt'),'utf8').catch(()=>null))throw new Error('committed worktree change reached main before merge')
  await fs.writeFile(path.join(repo,'local-only.txt'),'dirty checkout guard');let dirtyRejected=false;try{await request(`/v1/worktrees/${mergeTree.id}/merge`,{method:'POST',body:'{}'})}catch(error){dirtyRejected=/project checkout has uncommitted changes/.test(error.message)}await fs.rm(path.join(repo,'local-only.txt'));if(!dirtyRejected)throw new Error('merge did not reject a dirty project checkout')
  const merged=await request(`/v1/worktrees/${mergeTree.id}/merge`,{method:'POST',body:'{}'});if(!merged.changed||merged.source_branch!==mergeTree.branch||merged.target_branch!=='main')throw new Error(`unexpected merge result ${JSON.stringify(merged)}`)
  if((await fs.readFile(path.join(repo,'merged.txt'),'utf8')).trim()!=='merged')throw new Error('managed worktree commit was not merged into the project checkout')
  const alreadyMerged=await request(`/v1/worktrees/${mergeTree.id}/merge`,{method:'POST',body:'{}'});if(alreadyMerged.changed)throw new Error('repeated merge should be idempotent')
  await request(`/v1/worktrees/${mergeTree.id}`,{method:'DELETE'})

  const lateRepo=path.join(temp,'late-repo');await fs.mkdir(lateRepo)
  const lateProject=await request('/v1/projects',{method:'POST',body:JSON.stringify({name:'late-repo',path:lateRepo})});if(lateProject.repo_root!==null)throw new Error('late repo should be registered without Git metadata')
  await exec('git',['init','-b','main'],{cwd:lateRepo});await exec('git',['config','user.email','codesk@example.test'],{cwd:lateRepo});await exec('git',['config','user.name','Codesk Test'],{cwd:lateRepo});await fs.writeFile(path.join(lateRepo,'README.md'),'# late repo\n');await exec('git',['add','.'],{cwd:lateRepo});await exec('git',['commit','-m','initial'],{cwd:lateRepo})
  const lateRun=await request('/v1/runs',{method:'POST',body:JSON.stringify({project_id:lateProject.id,provider:'shell',prompt:'repair stale repo metadata',workspace_mode:'managed_worktree',command:'sh',args:['-c','printf repaired > repaired.txt']})})
  for(let i=0;i<40;i++){const state=await request(`/v1/runs/${lateRun.id}`);if(state.status==='completed')break;await wait(100)}
  const repairedProject=(await request('/v1/projects')).find((item)=>item.id===lateProject.id);if(repairedProject?.repo_root!==lateProject.path)throw new Error(`stale repo metadata was not repaired: ${JSON.stringify(repairedProject)}`)
  const lateFinished=await request(`/v1/runs/${lateRun.id}`);if(lateFinished.status!=='completed'||!lateFinished.worktree_id)throw new Error(`late repo run failed: ${JSON.stringify(lateFinished)}`)
  const lateTrees=await request(`/v1/projects/${lateProject.id}/worktrees`);await request(`/v1/worktrees/${lateTrees[0].id}?force=true`,{method:'DELETE'})
  console.log(`ok - managed worktrees isolate runs, expose merge context, guard dirty checkouts, merge, and clean up safely`)
} finally { if(daemon.exitCode===null)daemon.kill('SIGINT'); await fs.rm(temp,{recursive:true,force:true}) }
