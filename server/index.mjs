import express from 'express'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { WebSocketServer } from 'ws'
import { Store } from './store.mjs'
import { Gateway } from './gateway.mjs'
import { startDraft } from './drafts.mjs'

const app = express(); const server = http.createServer(app); const wss = new WebSocketServer({ server, path: '/ws' }); const store = new Store()
function broadcast(type, payload) { const body = JSON.stringify({ type, payload }); for (const client of wss.clients) if (client.readyState === 1) client.send(body) }
const gateway = new Gateway(store, broadcast)
const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`
const accessCommandForHost = (hostId, command) => {
  if (!command) return null
  const host = store.state.hosts.find((item) => item.id === hostId)
  return host?.type === 'ssh' ? `ssh -t ${shellQuote(host.sshAlias)} ${shellQuote(command)}` : command
}
const mapRun = (item, hostId) => ({ id:item.id, projectId:item.project_id, worktreeId:item.worktree_id, parentRunId:item.parent_run_id, provider:item.provider, sessionId:item.provider_session_id, title:item.title, prompt:item.prompt, model:item.model || '', cwd:item.cwd, command:item.command, args:item.args, status:item.status, pid:item.pid, processGroupId:item.process_group_id, createdAt:item.created_at, startedAt:item.started_at, finishedAt:item.finished_at, exitCode:item.exit_code, terminatingSignal:item.terminating_signal, displayCommand:[item.command,...(item.args || [])].join(' '), inputTransport:item.input_transport, tmuxName:item.tmux_name, tmuxAccessCommand:accessCommandForHost(hostId,item.tmux_access_command), hostId })
const mapSession = (item, hostId) => ({ id:item.id, provider:item.provider, nativeSessionId:item.native_session_id, projectId:item.project_id, hostId, cwd:item.cwd, title:item.title, createdAt:item.created_at, updatedAt:item.updated_at, sortAt:item.updated_at, status:item.status, pid:item.pid, managedRunId:item.managed_run_id, inputAvailable:item.input_available, inputTransport:item.input_transport, tmuxName:item.tmux_name, tmuxAccessCommand:accessCommandForHost(hostId,item.tmux_access_command), tmuxControlled:item.tmux_controlled, tmuxOwned:item.tmux_owned, model:item.model, effort:item.effort })
const mapAgent = (item, hostId) => ({ ...item, tmux_access_command:accessCommandForHost(hostId,item.tmux_access_command) })
const mapExternalQueued = (item, hostId) => item?.run ? { ...item, run:mapRun(item.run, hostId) } : item
const SESSION_PAGE_SIZE = 8
const previousSessionStatus = new Map()
const stoppedUntil = new Map()
const sessionSortAt = new Map()
const cachedHostState = new Map()
const hostRefreshes = new Map()
const hostRefreshTimers = new Map()
const hostRefreshAgain = new Set()
const STATE_TTL_MS = 60_000
app.use((req,res,next)=>{res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Headers','content-type');res.setHeader('Access-Control-Allow-Methods','GET,POST,PATCH,DELETE,OPTIONS');if(req.method==='OPTIONS')return res.sendStatus(204);next()})
app.use(express.json({ limit: '1mb' }))

const cachedSnapshot = (hostId) => cachedHostState.get(hostId) || store.state.navigationByHost[hostId] || null
const cloneSnapshot = (snapshot) => snapshot ? structuredClone(snapshot) : null

async function loadHostState(host) {
  const [hostProjects, hostRuns, capabilities, discoveredAgents] = await Promise.all([gateway.request(host.id, '/v1/projects'), gateway.request(host.id, '/v1/runs'), gateway.request(host.id, '/v1/capabilities'), gateway.request(host.id, '/v1/agents/discover')])
  const projectIds = new Set(hostProjects.map((project) => project.id))
  const hostSessions = await Promise.all(hostProjects.map(async (project) => {
    try { return await gateway.request(host.id, `/v1/projects/${project.id}/sessions?limit=${SESSION_PAGE_SIZE}`, { timeout: 12000 }) }
    catch { return [] }
  }))
  const result = {
    hostId: host.id,
    projects: hostProjects.map((item) => ({ id: item.id, name: item.name, path: item.path, repoRoot: item.repo_root, createdAt: item.created_at, hostId: host.id })),
    runs: hostRuns.filter((item) => projectIds.has(item.project_id)).map((item) => mapRun(item, host.id)),
    sessions: hostSessions.flat().map((item) => mapSession(item, host.id)),
    providers: capabilities,
    discoveredAgents: discoveredAgents.filter((item) => !item.managed_run_id).map((item) => mapAgent(item,host.id)),
    updatedAt: new Date().toISOString(),
  }
  cachedHostState.set(host.id, result)
  store.updateNavigationHost(host.id, { hostId: host.id, projects: result.projects, runs: result.runs, sessions: result.sessions, providers: result.providers, updatedAt: result.updatedAt })
  return result
}

const snapshotSignature = (snapshot) => JSON.stringify({ projects: snapshot?.projects || [], runs: snapshot?.runs || [], sessions: snapshot?.sessions || [], providers: snapshot?.providers || [], discoveredAgents: snapshot?.discoveredAgents || [] })
const snapshotFresh = (snapshot) => snapshot?.updatedAt && Date.now() - Date.parse(snapshot.updatedAt) < STATE_TTL_MS

async function refreshHost(hostId, force = false) {
  const host = store.state.hosts.find((item) => item.id === hostId)
  if (!host || host.status !== 'online') return cloneSnapshot(cachedSnapshot(hostId))
  const cached = cachedSnapshot(hostId)
  if (!force && snapshotFresh(cached)) return cloneSnapshot(cached)
  if (hostRefreshes.has(hostId)) {
    if (force) hostRefreshAgain.add(hostId)
    return hostRefreshes.get(hostId)
  }
  const refresh = (async () => {
    try {
      const before = snapshotSignature(cachedSnapshot(hostId))
      const result = await loadHostState(host)
      if (snapshotSignature(result) !== before) broadcast('state.updated', { hostId, updatedAt: result.updatedAt })
      return cloneSnapshot(result)
    } catch {
      return cloneSnapshot(cachedSnapshot(hostId))
    } finally {
      hostRefreshes.delete(hostId)
      if (hostRefreshAgain.delete(hostId)) scheduleHostRefresh(hostId, 0)
    }
  })()
  hostRefreshes.set(hostId, refresh)
  return refresh
}

function scheduleHostRefresh(hostId, delay = 120) {
  clearTimeout(hostRefreshTimers.get(hostId))
  hostRefreshTimers.set(hostId, setTimeout(() => {
    hostRefreshTimers.delete(hostId)
    void refreshHost(hostId, true)
  }, delay))
}

function refreshStaleHosts() {
  for (const host of store.state.hosts) if (host.status === 'online' && !snapshotFresh(cachedSnapshot(host.id))) void refreshHost(host.id)
}

function cacheCreatedProject(hostId, project) {
  const prior = cloneSnapshot(cachedSnapshot(hostId)) || { hostId, projects: [], runs: [], sessions: [], providers: [], discoveredAgents: [] }
  const mapped = { id: project.id, name: project.name, path: project.path, repoRoot: project.repo_root, createdAt: project.created_at, hostId }
  prior.projects = [...prior.projects.filter((item) => item.id !== mapped.id), mapped]
  prior.updatedAt = new Date().toISOString()
  cachedHostState.set(hostId, prior)
  store.updateNavigationHost(hostId, { hostId, projects: prior.projects, runs: prior.runs, sessions: prior.sessions, providers: prior.providers, updatedAt: prior.updatedAt })
  broadcast('state.updated', { hostId, updatedAt: prior.updatedAt })
}

function cacheCreatedRun(hostId, run) {
  const prior = cloneSnapshot(cachedSnapshot(hostId)) || { hostId, projects: [], runs: [], sessions: [], providers: [], discoveredAgents: [] }
  const mapped = mapRun(run, hostId)
  prior.runs = [mapped, ...prior.runs.filter((item) => item.id !== mapped.id)].sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  prior.updatedAt = new Date().toISOString()
  cachedHostState.set(hostId, prior)
  store.updateNavigationHost(hostId, { hostId, projects: prior.projects, runs: prior.runs, sessions: prior.sessions, providers: prior.providers, updatedAt: prior.updatedAt })
  broadcast('state.updated', { hostId, updatedAt: prior.updatedAt })
  return mapped
}

function cacheProjectSessions(hostId, projectId, sessions) {
  const prior = cloneSnapshot(cachedSnapshot(hostId)) || { hostId, projects: [], runs: [], sessions: [], providers: [], discoveredAgents: [] }
  prior.sessions = [...prior.sessions.filter((item) => item.projectId !== projectId), ...sessions].sort((left, right) => right.sortAt.localeCompare(left.sortAt))
  prior.updatedAt = new Date().toISOString()
  cachedHostState.set(hostId, prior)
  store.updateNavigationHost(hostId, { hostId, projects: prior.projects, runs: prior.runs, sessions: prior.sessions, providers: prior.providers, updatedAt: prior.updatedAt })
  broadcast('state.updated', { hostId, projectId, updatedAt: prior.updatedAt })
  return sessions
}

function cacheRemovedProject(hostId, projectId) {
  const prior = cloneSnapshot(cachedSnapshot(hostId)) || { hostId, projects: [], runs: [], sessions: [], providers: [], discoveredAgents: [] }
  prior.projects = prior.projects.filter((item) => item.id !== projectId)
  prior.runs = prior.runs.filter((item) => item.projectId !== projectId)
  prior.sessions = prior.sessions.filter((item) => item.projectId !== projectId)
  prior.updatedAt = new Date().toISOString()
  cachedHostState.set(hostId, prior)
  store.removeProjectReferences(hostId, projectId)
  store.updateNavigationHost(hostId, { hostId, projects: prior.projects, runs: prior.runs, sessions: prior.sessions, providers: prior.providers, updatedAt: prior.updatedAt })
  broadcast('state.updated', { hostId, updatedAt: prior.updatedAt })
}

gateway.onDaemonEvent = (hostId, event) => {
  if (/^(run|control|turn|thread|queue)\./.test(event.kind || '')) scheduleHostRefresh(hostId)
}
gateway.onHostOnline = (hostId) => scheduleHostRefresh(hostId, 0)

function navigationState() {
  const projects = []; const runs = []; const sessions = []; const providersByHost = {}
  for (const host of store.state.hosts) {
    const snapshot = cloneSnapshot(cachedSnapshot(host.id))
    if (!snapshot) continue
    projects.push(...(snapshot.projects || [])); runs.push(...(snapshot.runs || [])); sessions.push(...(snapshot.sessions || []))
    if (snapshot.providers) providersByHost[host.id] = snapshot.providers
  }
  runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)); sessions.sort((a, b) => b.sortAt.localeCompare(a.sortAt))
  return { hosts: store.state.hosts, projects, runs, sessions, drafts: store.state.drafts, providersByHost, discoveredAgentsByHost: {}, settings: store.state.settings }
}

function state() {
  const projects = []; const runs = []; const sessions = []; const providersByHost = {}; const discoveredAgentsByHost = {}
  const hostResults = store.state.hosts.map((host) => cloneSnapshot(cachedSnapshot(host.id)))
  // Promise completion timing must never affect sidebar order. Fold results in
  // the persisted host order, then each daemon's stable project order.
  for (const result of hostResults) {
    if (!result) continue
    projects.push(...(result.projects || [])); runs.push(...(result.runs || [])); sessions.push(...(result.sessions || []))
    const hostId = result.hostId || result.projects?.[0]?.hostId || result.runs?.[0]?.hostId || result.sessions?.[0]?.hostId
    if (hostId && result.providers) providersByHost[hostId] = result.providers
    if (hostId && result.discoveredAgents) discoveredAgentsByHost[hostId] = result.discoveredAgents
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

app.get('/api/state', (_req, res) => { res.json(state()); refreshStaleHosts() })
app.get('/api/navigation', (_req, res) => res.json(navigationState()))
app.patch('/api/settings', (req, res) => { const settings = store.updateSettings(req.body || {}); broadcast('settings.updated', settings); res.json(settings) })
app.get('/api/health', (_req, res) => res.json({ ok: true, version: '0.2.0' }))
app.get('/api/ssh-aliases', async (_req,res)=>res.json(await gateway.sshAliases()))
app.post('/api/hosts', async (req, res) => { const { name, sshAlias, daemonPort = 4243 } = req.body; if (!name?.trim() || !sshAlias?.trim()) return res.status(400).json({ error: 'Name and SSH alias are required' }); const host = { id: randomUUID(), name: name.trim(), type: 'ssh', sshAlias: sshAlias.trim(), daemonPort, status: 'offline', createdAt: new Date().toISOString() }; store.state.hosts.push(host); store.save(); broadcast('host.created', host); gateway.connect(host.id); res.status(201).json(host) })
app.post('/api/hosts/:id/reconnect', (req, res) => { gateway.reconnect(req.params.id); res.json({ ok: true }) })
app.get('/api/hosts/:id/inspect', async (req,res)=>{try{res.json(await gateway.inspectRemote(req.params.id))}catch(error){res.status(400).json({error:error.message})}})
app.post('/api/hosts/:id/install', async (req,res)=>{try{res.json(await gateway.installRemote(req.params.id,req.body.artifactUrl))}catch(error){res.status(400).json({error:error.message})}})
app.post('/api/hosts/:id/bootstrap', async (req,res)=>{try{res.json(await gateway.bootstrapRemote(req.params.id,{artifactUrl:req.body.artifactUrl,localBinaryPath:process.env.CODESK_DAEMON_BINARY}))}catch(error){res.status(400).json({error:error.message})}})
app.delete('/api/hosts/:id', (req, res) => { if (req.params.id === 'local') return res.status(400).json({ error: 'Local host cannot be removed' }); gateway.closeEvents(req.params.id); clearTimeout(hostRefreshTimers.get(req.params.id)); const child = gateway.processes.get(req.params.id); if (child) child.kill('SIGTERM'); cachedHostState.delete(req.params.id); store.state.hosts = store.state.hosts.filter((host) => host.id !== req.params.id); store.removeNavigationHost(req.params.id); broadcast('host.removed', { id: req.params.id }); res.json({ ok: true }) })

app.post('/api/projects', async (req, res) => { try { const project = await gateway.request(req.body.hostId, '/v1/projects', { method: 'POST', body: JSON.stringify({ name: req.body.name, path: req.body.path }) }); cacheCreatedProject(req.body.hostId, project); scheduleHostRefresh(req.body.hostId, 0); res.status(201).json({ ...project, hostId: req.body.hostId }) } catch (error) { res.status(400).json({ error: error.message }) } })
app.delete('/api/projects/:hostId/:projectId', async (req, res) => { try { const result = await gateway.request(req.params.hostId, `/v1/projects/${encodeURIComponent(req.params.projectId)}`, { method: 'DELETE' }); cacheRemovedProject(req.params.hostId, req.params.projectId); scheduleHostRefresh(req.params.hostId, 0); res.json(result) } catch (error) { res.status(400).json({ error: error.message }) } })
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
    const mapped = cacheCreatedRun(draft.hostId, run)
    scheduleHostRefresh(draft.hostId, 0)
    broadcast('draft.removed', { id: draft.id }); res.status(201).json(mapped)
  } catch (error) { res.status(error.statusCode || 400).json({ error: error.message }) }
})
app.get('/api/hosts/:hostId/files', async (req,res)=>{try{res.json(await gateway.request(req.params.hostId,`/v1/files?path=${encodeURIComponent(req.query.path||'')}`))}catch(error){res.status(400).json({error:error.message})}})
app.get('/api/hosts/:hostId/file', async (req,res)=>{try{res.json(await gateway.request(req.params.hostId,`/v1/file?path=${encodeURIComponent(req.query.path||'')}`,{timeout:30000}))}catch(error){res.status(400).json({error:error.message})}})
app.post('/api/hosts/:hostId/projects/discover', async (req,res)=>{try{res.json(await gateway.request(req.params.hostId,'/v1/projects/discover',{method:'POST',body:JSON.stringify(req.body),timeout:30000}))}catch(error){res.status(400).json({error:error.message})}})
app.get('/api/hosts/:hostId/agents', async (req,res)=>{try{res.json((await gateway.request(req.params.hostId,'/v1/agents/discover')).map((item)=>mapAgent(item,req.params.hostId)))}catch(error){res.status(400).json({error:error.message})}})
app.get('/api/projects/:hostId/:projectId/sessions/:provider/:sessionId/messages', async (req,res)=>{try{const after=typeof req.query.after==='string'&&req.query.after?`?after=${encodeURIComponent(req.query.after)}`:'';res.json(await gateway.request(req.params.hostId,`/v1/projects/${req.params.projectId}/sessions/${encodeURIComponent(req.params.provider)}/${encodeURIComponent(req.params.sessionId)}/messages${after}`,{timeout:30000}))}catch(error){res.status(400).json({error:error.message})}})
app.get('/api/projects/:hostId/:projectId/sessions', async (req,res)=>{try{const limit=Math.min(150,Math.max(1,Number(req.query.limit)||SESSION_PAGE_SIZE));const items=await gateway.request(req.params.hostId,`/v1/projects/${req.params.projectId}/sessions?limit=${limit}`,{timeout:20000});res.json(items.map((item)=>mapSession(item,req.params.hostId)))}catch(error){res.status(400).json({error:error.message})}})
app.post('/api/projects/:hostId/:projectId/sessions/refresh', async (req,res)=>{try{const limit=Math.min(150,Math.max(1,Number(req.query.limit)||50));const items=await gateway.request(req.params.hostId,`/v1/projects/${encodeURIComponent(req.params.projectId)}/sessions?limit=${limit}&refresh=true`,{timeout:30000});res.json(cacheProjectSessions(req.params.hostId,req.params.projectId,items.map((item)=>mapSession(item,req.params.hostId))))}catch(error){res.status(400).json({error:error.message})}})
app.get('/api/projects/:hostId/:projectId/git-context', async (req,res)=>{try{res.json(await gateway.request(req.params.hostId,`/v1/projects/${req.params.projectId}/git-context`))}catch(error){res.status(400).json({error:error.message})}})
for (const action of ['interrupt','terminate','kill']) app.post(`/api/agents/:hostId/:pid/${action}`,async(req,res)=>{try{res.json(await gateway.request(req.params.hostId,`/v1/agents/${req.params.pid}/${action}`,{method:'POST',body:'{}'}))}catch(error){res.status(400).json({error:error.message})}})
app.post('/api/external-sessions/:hostId/:pid/input',async(req,res)=>{try{const result=await gateway.request(req.params.hostId,`/v1/external-sessions/${req.params.pid}/input`,{method:'POST',body:JSON.stringify(req.body)});if(result.run)result.run=cacheCreatedRun(req.params.hostId,result.run);if(result.queued)result.queued=mapExternalQueued(result.queued,req.params.hostId);res.json(result)}catch(error){res.status(400).json({error:error.message})}})
app.get('/api/external-sessions/:hostId/:pid/queue',async(req,res)=>{try{const items=await gateway.request(req.params.hostId,`/v1/external-sessions/${req.params.pid}/queue`);for(const item of items)if(item.run)cacheCreatedRun(req.params.hostId,item.run);res.json(items.map((item)=>mapExternalQueued(item,req.params.hostId)))}catch(error){res.status(400).json({error:error.message})}})
app.delete('/api/external-sessions/:hostId/:pid/queue/:queueId',async(req,res)=>{try{res.json(await gateway.request(req.params.hostId,`/v1/external-sessions/${req.params.pid}/queue/${encodeURIComponent(req.params.queueId)}`,{method:'DELETE'}))}catch(error){res.status(400).json({error:error.message})}})
for (const action of ['adopt','move']) app.post(`/api/external-sessions/:hostId/:pid/tmux/${action}`,async(req,res)=>{try{const result=await gateway.request(req.params.hostId,`/v1/external-sessions/${req.params.pid}/tmux/${action}`,{method:'POST',body:JSON.stringify(req.body)});scheduleHostRefresh(req.params.hostId,0);res.json(result)}catch(error){res.status(400).json({error:error.message})}})
app.post('/api/external-sessions/:hostId/:pid/tmux/disable',async(req,res)=>{try{const result=await gateway.request(req.params.hostId,`/v1/external-sessions/${req.params.pid}/tmux/disable`,{method:'POST',body:'{}'});scheduleHostRefresh(req.params.hostId,0);res.json(result)}catch(error){res.status(400).json({error:error.message})}})
app.get('/api/projects/:hostId/:projectId/worktrees', async (req, res) => { try { res.json(await gateway.request(req.params.hostId, `/v1/projects/${req.params.projectId}/worktrees`)) } catch (error) { res.status(400).json({ error: error.message }) } })
app.get('/api/worktrees/:hostId/:id/status', async (req,res)=>{try{res.json(await gateway.request(req.params.hostId,`/v1/worktrees/${req.params.id}/status`))}catch(error){res.status(400).json({error:error.message})}})
app.post('/api/worktrees/:hostId/:id/merge', async (req,res)=>{try{res.json(await gateway.request(req.params.hostId,`/v1/worktrees/${req.params.id}/merge`,{method:'POST',body:JSON.stringify(req.body||{})}))}catch(error){res.status(400).json({error:error.message})}})
app.delete('/api/worktrees/:hostId/:id', async (req, res) => { try { res.json(await gateway.request(req.params.hostId, `/v1/worktrees/${req.params.id}?force=${req.query.force === 'true'}`, { method: 'DELETE' })) } catch (error) { res.status(400).json({ error: error.message }) } })

app.post('/api/runs', async (req, res) => { try { const run = await gateway.request(req.body.hostId, '/v1/runs', { method: 'POST', body: JSON.stringify(req.body) , timeout: 30000}); const mapped = cacheCreatedRun(req.body.hostId, run); scheduleHostRefresh(req.body.hostId, 0); res.status(201).json(mapped) } catch (error) { res.status(400).json({ error: error.message }) } })
for (const action of ['interrupt','terminate','kill']) app.post(`/api/runs/:hostId/:id/${action}`, async (req, res) => { try { res.json(await gateway.request(req.params.hostId, `/v1/runs/${req.params.id}/${action}`, { method: 'POST', body: '{}' })) } catch (error) { res.status(400).json({ error: error.message }) } })
app.post('/api/runs/:hostId/:id/input', async (req, res) => { try { res.json(await gateway.request(req.params.hostId, `/v1/runs/${req.params.id}/input`, { method: 'POST', body: JSON.stringify(req.body) })) } catch (error) { res.status(400).json({ error: error.message }) } })
app.post('/api/runs/:hostId/:id/response', async (req, res) => { try { res.json(await gateway.request(req.params.hostId, `/v1/runs/${req.params.id}/response`, { method: 'POST', body: JSON.stringify(req.body) })) } catch (error) { res.status(400).json({ error: error.message }) } })
app.post('/api/runs/:hostId/:id/models', async (req, res) => { try { res.json(await gateway.request(req.params.hostId, `/v1/runs/${req.params.id}/models`, { method: 'POST', body: '{}' })) } catch (error) { res.status(400).json({ error: error.message }) } })
app.post('/api/runs/:hostId/:id/queue/start', async (req, res) => { try { res.json(await gateway.request(req.params.hostId, `/v1/runs/${req.params.id}/queue/start`, { method: 'POST', body: '{}' })) } catch (error) { res.status(400).json({ error: error.message }) } })
app.delete('/api/runs/:hostId/:id/queue/:queueId', async (req, res) => { try { res.json(await gateway.request(req.params.hostId, `/v1/runs/${req.params.id}/queue/${encodeURIComponent(req.params.queueId)}`, { method: 'DELETE' })) } catch (error) { res.status(400).json({ error: error.message }) } })
app.get('/api/runs/:hostId/:id/events', async (req, res) => { try { res.json(await gateway.request(req.params.hostId, `/v1/runs/${req.params.id}/events?after=${req.query.after || 0}`)) } catch (error) { res.status(400).json({ error: error.message }) } })
app.post('/api/open-path', async (req,res)=>{try{const host=store.state.hosts.find((item)=>item.id===req.body.hostId);if(!host)throw new Error('Host not found');if(host.type!=='local')throw new Error('Opening remote folders requires an SSH-aware editor integration; the path remains available in Environment.');spawn('open',[req.body.path],{detached:true,stdio:'ignore'}).unref();res.json({ok:true})}catch(error){res.status(400).json({error:error.message})}})

wss.on('connection', (socket) => socket.send(JSON.stringify({ type: 'ready', payload: { now: new Date().toISOString() } })))
async function main() {
  await gateway.start()
  refreshStaleHosts()
  server.listen(Number(process.env.PORT || 4242), '127.0.0.1', () => console.log(`Codesk client gateway listening on http://127.0.0.1:${process.env.PORT || 4242}`))
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
