import express from 'express'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { WebSocketServer } from 'ws'
import { Store } from './store.mjs'
import { Gateway } from './gateway.mjs'
import { startDraft } from './drafts.mjs'

const app = express(); const server = http.createServer(app); const wss = new WebSocketServer({ server, path: '/ws' }); const store = new Store()
function broadcast(type, payload) { const body = JSON.stringify({ type, payload }); for (const client of wss.clients) if (client.readyState === 1) client.send(body) }
const gateway = new Gateway(store, broadcast)
const mapRun = (item, hostId) => ({ id:item.id, projectId:item.project_id, worktreeId:item.worktree_id, parentRunId:item.parent_run_id, provider:item.provider, sessionId:item.provider_session_id, title:item.title, prompt:item.prompt, model:item.model || '', cwd:item.cwd, command:item.command, args:item.args, status:item.status, pid:item.pid, processGroupId:item.process_group_id, createdAt:item.created_at, startedAt:item.started_at, finishedAt:item.finished_at, exitCode:item.exit_code, terminatingSignal:item.terminating_signal, displayCommand:[item.command,...(item.args || [])].join(' '), hostId })
const mapSession = (item, hostId) => ({ id:item.id, provider:item.provider, nativeSessionId:item.native_session_id, projectId:item.project_id, hostId, cwd:item.cwd, title:item.title, createdAt:item.created_at, updatedAt:item.updated_at, sortAt:item.updated_at, status:item.status, pid:item.pid })
const SESSION_PAGE_SIZE = 8
const previousSessionStatus = new Map()
const stoppedUntil = new Map()
const sessionSortAt = new Map()
const cachedHostState = new Map()
app.use((req,res,next)=>{res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Headers','content-type');res.setHeader('Access-Control-Allow-Methods','GET,POST,PATCH,DELETE,OPTIONS');if(req.method==='OPTIONS')return res.sendStatus(204);next()})
app.use(express.json({ limit: '1mb' }))

async function state() {
  const projects = []; const runs = []; const sessions = []; const providersByHost = {}; const discoveredAgentsByHost = {}
  const hostResults = await Promise.all(store.state.hosts.map(async (host) => {
    if (host.status !== 'online') return
    try {
      const [hostProjects, hostRuns, capabilities, discoveredAgents] = await Promise.all([gateway.request(host.id, '/v1/projects'), gateway.request(host.id, '/v1/runs'), gateway.request(host.id, '/v1/capabilities'), gateway.request(host.id, '/v1/agents/discover')])
      const hostSessions = await Promise.all(hostProjects.map(async (project) => {
        try { return await gateway.request(host.id, `/v1/projects/${project.id}/sessions?limit=${SESSION_PAGE_SIZE}`, { timeout: 12000 }) }
        catch { return [] }
      }))
      const result = { host, hostProjects, hostRuns, capabilities, discoveredAgents, hostSessions }
      cachedHostState.set(host.id, result)
      return result
    } catch { return cachedHostState.get(host.id) || null }
  }))
  // Promise completion timing must never affect sidebar order. Fold results in
  // the persisted host order, then each daemon's stable project order.
  for (const result of hostResults) {
    if (!result) continue
    const { host, hostProjects, hostRuns, capabilities, discoveredAgents, hostSessions } = result
    projects.push(...hostProjects.map((item) => ({ id: item.id, name: item.name, path: item.path, repoRoot: item.repo_root, createdAt: item.created_at, hostId: host.id })))
    runs.push(...hostRuns.map((item) => mapRun(item, host.id)))
    providersByHost[host.id] = capabilities
    discoveredAgentsByHost[host.id] = discoveredAgents.filter((item) => !item.managed_run_id)
    sessions.push(...hostSessions.flat().map((item) => mapSession(item, host.id)))
  }
  runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const now = Date.now()
  for (const session of sessions) {
    const key = `${session.hostId}:${session.id}`; const prior = previousSessionStatus.get(key)
    if (!sessionSortAt.has(key)) sessionSortAt.set(key, session.updatedAt)
    if (prior === 'running' && session.status !== 'running') {
      stoppedUntil.set(key, now + 45_000)
      sessionSortAt.set(key, session.updatedAt)
    } else if (session.status !== 'running' && prior !== session.status) {
      sessionSortAt.set(key, session.updatedAt)
    }
    previousSessionStatus.set(key, session.status)
    session.sortAt = sessionSortAt.get(key)
    if (session.status !== 'running' && (stoppedUntil.get(key) || 0) > now) session.status = 'stopped'
    else if ((stoppedUntil.get(key) || 0) <= now) stoppedUntil.delete(key)
  }
  sessions.sort((a, b) => b.sortAt.localeCompare(a.sortAt))
  return { hosts: store.state.hosts, projects, runs, sessions, drafts: store.state.drafts, providersByHost, discoveredAgentsByHost, settings: store.state.settings }
}

app.get('/api/state', async (_req, res) => res.json(await state()))
app.get('/api/health', (_req, res) => res.json({ ok: true, version: '0.2.0' }))
app.get('/api/ssh-aliases', async (_req,res)=>res.json(await gateway.sshAliases()))
app.post('/api/hosts', async (req, res) => { const { name, sshAlias, daemonPort = 4243 } = req.body; if (!name?.trim() || !sshAlias?.trim()) return res.status(400).json({ error: 'Name and SSH alias are required' }); const host = { id: randomUUID(), name: name.trim(), type: 'ssh', sshAlias: sshAlias.trim(), daemonPort, status: 'offline', createdAt: new Date().toISOString() }; store.state.hosts.push(host); store.save(); broadcast('host.created', host); gateway.connect(host.id); res.status(201).json(host) })
app.post('/api/hosts/:id/reconnect', (req, res) => { gateway.reconnect(req.params.id); res.json({ ok: true }) })
app.get('/api/hosts/:id/inspect', async (req,res)=>{try{res.json(await gateway.inspectRemote(req.params.id))}catch(error){res.status(400).json({error:error.message})}})
app.post('/api/hosts/:id/install', async (req,res)=>{try{res.json(await gateway.installRemote(req.params.id,req.body.artifactUrl))}catch(error){res.status(400).json({error:error.message})}})
app.post('/api/hosts/:id/bootstrap', async (req,res)=>{try{res.json(await gateway.bootstrapRemote(req.params.id,{artifactUrl:req.body.artifactUrl,localBinaryPath:process.env.CODESK_DAEMON_BINARY}))}catch(error){res.status(400).json({error:error.message})}})
app.delete('/api/hosts/:id', (req, res) => { if (req.params.id === 'local') return res.status(400).json({ error: 'Local host cannot be removed' }); const child = gateway.processes.get(req.params.id); if (child) child.kill('SIGTERM'); store.state.hosts = store.state.hosts.filter((host) => host.id !== req.params.id); store.save(); broadcast('host.removed', { id: req.params.id }); res.json({ ok: true }) })

app.post('/api/projects', async (req, res) => { try { const project = await gateway.request(req.body.hostId, '/v1/projects', { method: 'POST', body: JSON.stringify({ name: req.body.name, path: req.body.path }) }); res.status(201).json({ ...project, hostId: req.body.hostId }) } catch (error) { res.status(400).json({ error: error.message }) } })
app.post('/api/drafts', (req, res) => {
  const { hostId, projectId, provider, workspaceMode } = req.body
  if (!hostId || !projectId) return res.status(400).json({ error: 'hostId and projectId are required' })
  const draft = store.createDraft({ id: randomUUID(), hostId, projectId, provider, workspaceMode })
  broadcast('draft.created', draft); res.status(201).json(draft)
})
app.delete('/api/drafts/:id', (req, res) => {
  if (!store.deleteDraft(req.params.id)) return res.status(404).json({ error: 'Draft not found' })
  broadcast('draft.removed', { id: req.params.id }); res.json({ ok: true })
})
app.patch('/api/drafts/:id', (req, res) => {
  const draft = store.updateDraft(req.params.id, req.body)
  if (!draft) return res.status(404).json({ error: 'Draft not found' })
  broadcast('draft.updated', draft); res.json(draft)
})
app.post('/api/drafts/:id/start', async (req, res) => {
  try {
    const { draft, run } = await startDraft(store, gateway, req.params.id, req.body)
    broadcast('draft.removed', { id: draft.id }); res.status(201).json(mapRun(run, draft.hostId))
  } catch (error) { res.status(error.statusCode || 400).json({ error: error.message }) }
})
app.get('/api/hosts/:hostId/files', async (req,res)=>{try{res.json(await gateway.request(req.params.hostId,`/v1/files?path=${encodeURIComponent(req.query.path||'')}`))}catch(error){res.status(400).json({error:error.message})}})
app.post('/api/hosts/:hostId/projects/discover', async (req,res)=>{try{res.json(await gateway.request(req.params.hostId,'/v1/projects/discover',{method:'POST',body:JSON.stringify(req.body),timeout:30000}))}catch(error){res.status(400).json({error:error.message})}})
app.get('/api/hosts/:hostId/agents', async (req,res)=>{try{res.json(await gateway.request(req.params.hostId,'/v1/agents/discover'))}catch(error){res.status(400).json({error:error.message})}})
app.get('/api/projects/:hostId/:projectId/sessions/:provider/:sessionId/messages', async (req,res)=>{try{const after=typeof req.query.after==='string'&&req.query.after?`?after=${encodeURIComponent(req.query.after)}`:'';res.json(await gateway.request(req.params.hostId,`/v1/projects/${req.params.projectId}/sessions/${encodeURIComponent(req.params.provider)}/${encodeURIComponent(req.params.sessionId)}/messages${after}`,{timeout:30000}))}catch(error){res.status(400).json({error:error.message})}})
app.get('/api/projects/:hostId/:projectId/sessions', async (req,res)=>{try{const limit=Math.min(150,Math.max(1,Number(req.query.limit)||SESSION_PAGE_SIZE));const items=await gateway.request(req.params.hostId,`/v1/projects/${req.params.projectId}/sessions?limit=${limit}`,{timeout:20000});res.json(items.map((item)=>mapSession(item,req.params.hostId)))}catch(error){res.status(400).json({error:error.message})}})
for (const action of ['interrupt','terminate','kill']) app.post(`/api/agents/:hostId/:pid/${action}`,async(req,res)=>{try{res.json(await gateway.request(req.params.hostId,`/v1/agents/${req.params.pid}/${action}`,{method:'POST',body:'{}'}))}catch(error){res.status(400).json({error:error.message})}})
app.get('/api/projects/:hostId/:projectId/worktrees', async (req, res) => { try { res.json(await gateway.request(req.params.hostId, `/v1/projects/${req.params.projectId}/worktrees`)) } catch (error) { res.status(400).json({ error: error.message }) } })
app.get('/api/worktrees/:hostId/:id/status', async (req,res)=>{try{res.json(await gateway.request(req.params.hostId,`/v1/worktrees/${req.params.id}/status`))}catch(error){res.status(400).json({error:error.message})}})
app.delete('/api/worktrees/:hostId/:id', async (req, res) => { try { res.json(await gateway.request(req.params.hostId, `/v1/worktrees/${req.params.id}?force=${req.query.force === 'true'}`, { method: 'DELETE' })) } catch (error) { res.status(400).json({ error: error.message }) } })

app.post('/api/runs', async (req, res) => { try { const run = await gateway.request(req.body.hostId, '/v1/runs', { method: 'POST', body: JSON.stringify(req.body) , timeout: 30000}); res.status(201).json(mapRun(run, req.body.hostId)) } catch (error) { res.status(400).json({ error: error.message }) } })
for (const action of ['interrupt','terminate','kill']) app.post(`/api/runs/:hostId/:id/${action}`, async (req, res) => { try { res.json(await gateway.request(req.params.hostId, `/v1/runs/${req.params.id}/${action}`, { method: 'POST', body: '{}' })) } catch (error) { res.status(400).json({ error: error.message }) } })
app.post('/api/runs/:hostId/:id/input', async (req, res) => { try { res.json(await gateway.request(req.params.hostId, `/v1/runs/${req.params.id}/input`, { method: 'POST', body: JSON.stringify(req.body) })) } catch (error) { res.status(400).json({ error: error.message }) } })
app.post('/api/runs/:hostId/:id/response', async (req, res) => { try { res.json(await gateway.request(req.params.hostId, `/v1/runs/${req.params.id}/response`, { method: 'POST', body: JSON.stringify(req.body) })) } catch (error) { res.status(400).json({ error: error.message }) } })
app.post('/api/runs/:hostId/:id/queue/start', async (req, res) => { try { res.json(await gateway.request(req.params.hostId, `/v1/runs/${req.params.id}/queue/start`, { method: 'POST', body: '{}' })) } catch (error) { res.status(400).json({ error: error.message }) } })
app.delete('/api/runs/:hostId/:id/queue/:queueId', async (req, res) => { try { res.json(await gateway.request(req.params.hostId, `/v1/runs/${req.params.id}/queue/${encodeURIComponent(req.params.queueId)}`, { method: 'DELETE' })) } catch (error) { res.status(400).json({ error: error.message }) } })
app.get('/api/runs/:hostId/:id/events', async (req, res) => { try { res.json(await gateway.request(req.params.hostId, `/v1/runs/${req.params.id}/events?after=${req.query.after || 0}`)) } catch (error) { res.status(400).json({ error: error.message }) } })
app.post('/api/open-path', async (req,res)=>{try{const host=store.state.hosts.find((item)=>item.id===req.body.hostId);if(!host)throw new Error('Host not found');if(host.type!=='local')throw new Error('Opening remote folders requires an SSH-aware editor integration; the path remains available in Environment.');spawn('open',[req.body.path],{detached:true,stdio:'ignore'}).unref();res.json({ok:true})}catch(error){res.status(400).json({error:error.message})}})

wss.on('connection', (socket) => socket.send(JSON.stringify({ type: 'ready', payload: { now: new Date().toISOString() } })))
async function main() {
  await gateway.start()
  server.listen(Number(process.env.PORT || 4242), '127.0.0.1', () => console.log(`Codesk client gateway listening on http://127.0.0.1:${process.env.PORT || 4242}`))
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
