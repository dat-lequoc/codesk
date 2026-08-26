export const SESSION_PAGE_SIZE = 8
export const STATE_TTL_MS = 60_000

export function createStateCache({ store, gateway, broadcast, mappers }) {
  const { mapRun, mapSession, mapAgent } = mappers
  const previousSessionStatus = new Map()
  const stoppedUntil = new Map()
  const sessionSortAt = new Map()
  const cachedHostState = new Map()
  const hostRefreshes = new Map()
  const hostRefreshTimers = new Map()
  const hostRefreshAgain = new Set()

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
      } catch (error) {
        console.error(`state refresh failed for host ${hostId}: ${error.message}`)
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

  // run.* lifecycle events only move the runs list, so they take a one-request
  // refresh instead of the full projects+runs+capabilities+discovery+sessions
  // fan-out. Turn/queue/control/thread events change session status too and
  // keep the full snapshot path.
  async function refreshHostRuns(hostId) {
    const host = store.state.hosts.find((item) => item.id === hostId)
    if (!host || host.status !== 'online') return
    const prior = cloneSnapshot(cachedSnapshot(hostId))
    if (!prior) return void refreshHost(hostId, true)
    try {
      const hostRuns = await gateway.request(hostId, '/v1/runs')
      const projectIds = new Set(prior.projects.map((project) => project.id))
      const runs = hostRuns.filter((item) => projectIds.has(item.project_id)).map((item) => mapRun(item, hostId))
      if (JSON.stringify(runs) === JSON.stringify(prior.runs)) return
      prior.runs = runs
      prior.updatedAt = new Date().toISOString()
      cachedHostState.set(hostId, prior)
      store.updateNavigationHost(hostId, { hostId, projects: prior.projects, runs: prior.runs, sessions: prior.sessions, providers: prior.providers, updatedAt: prior.updatedAt })
      broadcast('state.updated', { hostId, updatedAt: prior.updatedAt })
    } catch (error) {
      console.error(`runs refresh failed for host ${hostId}: ${error.message}`)
    }
  }

  const hostRunsRefreshTimers = new Map()
  function scheduleHostRunsRefresh(hostId, delay = 120) {
    // A pending full refresh supersedes a runs-only one.
    if (hostRefreshTimers.has(hostId)) return
    clearTimeout(hostRunsRefreshTimers.get(hostId))
    hostRunsRefreshTimers.set(hostId, setTimeout(() => {
      hostRunsRefreshTimers.delete(hostId)
      void refreshHostRuns(hostId)
    }, delay))
  }

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
      // Hold `stopped` for 45s so a just-finished row stays visible (red
      // circle + sort). The desktop hides the circle once the user has
      // viewed the bottom of the thread; this hold is for chats they have
      // not opened yet.
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

  function forgetHost(hostId) {
    clearTimeout(hostRefreshTimers.get(hostId)); hostRefreshTimers.delete(hostId)
    cachedHostState.delete(hostId)
    const prefix = `${hostId}:`
    for (const map of [previousSessionStatus, sessionSortAt, stoppedUntil]) for (const key of map.keys()) if (key.startsWith(prefix)) map.delete(key)
  }

  function clearTimers() {
    for (const timer of hostRefreshTimers.values()) clearTimeout(timer)
    hostRefreshTimers.clear()
    for (const timer of hostRunsRefreshTimers.values()) clearTimeout(timer)
    hostRunsRefreshTimers.clear()
  }

  return {
    SESSION_PAGE_SIZE,
    cachedSnapshot,
    cloneSnapshot,
    loadHostState,
    refreshHost,
    refreshHostRuns,
    scheduleHostRefresh,
    scheduleHostRunsRefresh,
    refreshStaleHosts,
    cacheCreatedProject,
    cacheCreatedRun,
    cacheProjectSessions,
    cacheRemovedProject,
    state,
    navigationState,
    forgetHost,
    clearTimers,
  }
}
