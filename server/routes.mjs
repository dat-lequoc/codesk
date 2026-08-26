import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { startDraft } from './drafts.mjs'
// Single version source, inlined by esbuild when the gateway is packaged. The
// desktop shell also probes this response (with its `service` marker) to
// distinguish a Codesk gateway from a stranger on 4242.
import packageJson from '../package.json' with { type: 'json' }

export function registerRoutes(app, { store, gateway, broadcast, stateCache, mappers, ownership }) {
  const { mapSession, mapAgent, mapExternalQueued } = mappers
  const { SESSION_PAGE_SIZE, state, navigationState, refreshStaleHosts, scheduleHostRefresh, cacheCreatedProject, cacheCreatedRun, cacheProjectSessions, cacheRemovedProject, forgetHost } = stateCache
  const { owners, ownerAlive, stop } = ownership

  app.get('/api/state', (_req, res) => { res.json(state()); refreshStaleHosts() })
  app.get('/api/navigation', (_req, res) => res.json(navigationState()))
  app.patch('/api/settings', (req, res) => { const settings = store.updateSettings(req.body || {}); broadcast('settings.updated', settings); res.json(settings) })
  app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'codesk-gateway', version: packageJson.version }))
  app.get('/api/ssh-aliases', async (_req,res)=>res.json(await gateway.sshAliases()))
  app.post('/api/hosts', async (req, res) => { const { name, sshAlias, daemonPort = 4243 } = req.body; if (!name?.trim() || !sshAlias?.trim()) return res.status(400).json({ error: 'Name and SSH alias are required' }); const host = { id: randomUUID(), name: name.trim(), type: 'ssh', sshAlias: sshAlias.trim(), daemonPort, status: 'offline', createdAt: new Date().toISOString() }; store.state.hosts.push(host); store.save(); broadcast('host.created', host); gateway.connect(host.id); res.status(201).json(host) })
  app.post('/api/hosts/:id/reconnect', (req, res) => { gateway.reconnect(req.params.id); res.json({ ok: true }) })
  app.get('/api/hosts/:id/inspect', async (req,res)=>{try{res.json(await gateway.inspectRemote(req.params.id))}catch(error){res.status(400).json({error:error.message})}})
  app.post('/api/hosts/:id/install', async (req,res)=>{try{res.json(await gateway.installRemote(req.params.id,req.body.artifactUrl))}catch(error){res.status(400).json({error:error.message})}})
  app.post('/api/hosts/:id/bootstrap', async (req,res)=>{try{res.json(await gateway.bootstrapRemote(req.params.id,{artifactUrl:req.body.artifactUrl,localBinaryPath:process.env.CODESK_DAEMON_BINARY}))}catch(error){res.status(400).json({error:error.message})}})
  app.delete('/api/hosts/:id', (req, res) => {
    const hostId = req.params.id
    if (hostId === 'local') return res.status(400).json({ error: 'Local host cannot be removed' })
    forgetHost(hostId)
    // The store must forget the host before the tunnel dies, so the exit handler
    // sees it gone and does not schedule a reconnect for a removed host.
    store.state.hosts = store.state.hosts.filter((host) => host.id !== hostId)
    store.save()
    store.removeNavigationHost(hostId)
    gateway.removeHost(hostId)
    broadcast('host.removed', { id: hostId })
    res.json({ ok: true })
  })

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
  app.get('/api/projects/:hostId/:projectId/sessions/:provider/:sessionId/messages', async (req,res)=>{try{const params=new URLSearchParams();if(req.query.after)params.set('after',req.query.after);if(req.query.before)params.set('before',req.query.before);if(req.query.limit)params.set('limit',req.query.limit);const qs=params.toString()?`?${params.toString()}`:'';res.json(await gateway.request(req.params.hostId,`/v1/projects/${req.params.projectId}/sessions/${encodeURIComponent(req.params.provider)}/${encodeURIComponent(req.params.sessionId)}/messages${qs}`,{timeout:30000}))}catch(error){res.status(400).json({error:error.message})}})
  app.get('/api/projects/:hostId/:projectId/sessions', async (req,res)=>{try{const limit=Math.min(150,Math.max(1,Number(req.query.limit)||SESSION_PAGE_SIZE));const items=await gateway.request(req.params.hostId,`/v1/projects/${req.params.projectId}/sessions?limit=${limit}`,{timeout:20000});res.json(items.map((item)=>mapSession(item,req.params.hostId)))}catch(error){res.status(400).json({error:error.message})}})
  app.post('/api/projects/:hostId/:projectId/sessions/refresh', async (req,res)=>{try{const limit=Math.min(150,Math.max(1,Number(req.query.limit)||50));const items=await gateway.request(req.params.hostId,`/v1/projects/${encodeURIComponent(req.params.projectId)}/sessions?limit=${limit}&refresh=true`,{timeout:30000});res.json(cacheProjectSessions(req.params.hostId,req.params.projectId,items.map((item)=>mapSession(item,req.params.hostId))))}catch(error){res.status(400).json({error:error.message})}})
  app.get('/api/projects/:hostId/:projectId/git-context', async (req,res)=>{try{res.json(await gateway.request(req.params.hostId,`/v1/projects/${req.params.projectId}/git-context`))}catch(error){res.status(400).json({error:error.message})}})
  for (const action of ['interrupt','terminate','kill']) app.post(`/api/agents/:hostId/:pid/${action}`,async(req,res)=>{try{res.json(await gateway.request(req.params.hostId,`/v1/agents/${req.params.pid}/${action}`,{method:'POST',body:'{}'}))}catch(error){res.status(400).json({error:error.message})}})
  app.post('/api/external-sessions/:hostId/:pid/input',async(req,res)=>{try{const result=await gateway.request(req.params.hostId,`/v1/external-sessions/${req.params.pid}/input`,{method:'POST',body:JSON.stringify(req.body)});if(result.run)result.run=cacheCreatedRun(req.params.hostId,result.run);if(result.queued)result.queued=mapExternalQueued(result.queued,req.params.hostId);res.json(result)}catch(error){res.status(400).json({error:error.message})}})
  app.get('/api/external-sessions/:hostId/:pid/queue',async(req,res)=>{try{const items=await gateway.request(req.params.hostId,`/v1/external-sessions/${req.params.pid}/queue`);for(const item of items)if(item.run)cacheCreatedRun(req.params.hostId,item.run);res.json(items.map((item)=>mapExternalQueued(item,req.params.hostId)))}catch(error){res.status(400).json({error:error.message})}})
  app.delete('/api/external-sessions/:hostId/:pid/queue/:queueId',async(req,res)=>{try{res.json(await gateway.request(req.params.hostId,`/v1/external-sessions/${req.params.pid}/queue/${encodeURIComponent(req.params.queueId)}`,{method:'DELETE'}))}catch(error){res.status(400).json({error:error.message})}})
  for (const action of ['adopt','move']) app.post(`/api/external-sessions/:hostId/:pid/tmux/${action}`,async(req,res)=>{try{const result=await gateway.request(req.params.hostId,`/v1/external-sessions/${req.params.pid}/tmux/${action}`,{method:'POST',body:JSON.stringify(req.body)});scheduleHostRefresh(req.params.hostId,0);res.json(result)}catch(error){res.status(400).json({error:error.message})}})
  app.post('/api/external-sessions/:hostId/:pid/tmux/disable',async(req,res)=>{try{const result=await gateway.request(req.params.hostId,`/v1/external-sessions/${req.params.pid}/tmux/disable`,{method:'POST',body:'{}'});scheduleHostRefresh(req.params.hostId,0);res.json(result)}catch(error){res.status(400).json({error:error.message})}})
  app.get('/api/external-sessions/:hostId/:pid/tmux/log',async(req,res)=>{try{const lines=Math.min(2000,Math.max(10,Number(req.query.lines)||200));res.json(await gateway.request(req.params.hostId,`/v1/external-sessions/${req.params.pid}/tmux/log?lines=${lines}`,{timeout:15000}))}catch(error){res.status(400).json({error:error.message})}})
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
  app.post('/api/open-path', async (req,res)=>{try{const host=store.state.hosts.find((item)=>item.id===req.body.hostId);if(!host)throw new Error('Host not found');if(host.type!=='local')throw new Error('Opening remote folders requires an SSH-aware editor integration; the path remains available in Environment.');const opener=process.platform==='darwin'?'open':process.platform==='win32'?'explorer':'xdg-open';const child=spawn(opener,[req.body.path],{detached:true,stdio:'ignore'});child.on('error',(cause)=>console.error(`open-path failed: ${opener}: ${cause.message}`));child.unref();res.json({ok:true})}catch(error){res.status(400).json({error:error.message})}})

  app.post('/api/owners', (req, res) => {
    const pid = Number(req.body?.pid)
    if (!Number.isInteger(pid) || pid <= 0) return res.status(400).json({ error: 'A positive integer pid is required' })
    if (!ownerAlive(pid)) return res.status(400).json({ error: `Process ${pid} is not running` })
    // Refuse to be adopted by an app instance that did not start us. A gateway
    // launched by hand (`npm start`, `npm run dev`) belongs to the developer's
    // terminal, and quitting a desktop app must not take it down.
    if (owners.size === 0) return res.status(409).json({ error: 'This gateway is unowned and will not adopt an owner' })
    owners.add(pid)
    res.json({ ok: true, owners: [...owners] })
  })

  app.post('/api/shutdown', (req, res) => {
    const pid = Number(req.body?.pid)
    // An owner pid is mandatory. The pid-less form used to fall through to a
    // full stop, which let any local page or process kill the gateway with a
    // blind cross-origin POST. Legitimate callers (the desktop shell) always
    // know their own pid; hand-started gateways stop with Ctrl+C.
    if (!Number.isInteger(pid) || pid <= 0)
      return res.status(400).json({ error: 'An owner pid is required to shut this gateway down' })
    // A pid identifies the caller as one of our owners. If it is not one, the
    // request came from an app instance that never owned this gateway — a
    // desktop app quitting next to a hand-started `npm run dev` — and taking the
    // developer's server down with it would be wrong.
    if (!owners.has(pid)) return res.json({ ok: true, stopped: false, owners: [...owners] })
    // Releasing one owner is not a shutdown: a second app instance may still be
    // using this gateway, and stopping here would kill its daemon too.
    owners.delete(pid)
    if (owners.size > 0) return res.json({ ok: true, stopped: false, owners: [...owners] })
    res.json({ ok: true, stopped: true })
    // Answer first so the caller's quit path is never blocked on our teardown.
    void stop(`owner ${pid} exited`)
  })
}
