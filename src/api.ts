import type {
  AppState,
  DiscoveredAgent,
  DiscoveredProject,
  DraftSession,
  ExternalQueuedInput,
  FileContent,
  FileListing,
  GitContext,
  Host,
  MergeWorktreeResult,
  Project,
  ProviderSession,
  Run,
  RunEvent,
  SessionMessage,
  WorktreeStatus,
} from './types'

export const gatewayOrigin =
  location.protocol === 'http:' || location.protocol === 'https:' ? '' : 'http://127.0.0.1:4242'

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${gatewayOrigin}${path}`, {
    // A hung gateway must not leave the UI waiting forever; callers with
    // longer operations pass their own signal.
    signal: AbortSignal.timeout(30_000),
    ...options,
    headers: { 'content-type': 'application/json', ...options?.headers },
  })
  const body = await response.json()
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`)
  return body
}

export const api = {
  state: () => request<AppState>('/api/state'),
  navigation: () => request<AppState>('/api/navigation'),
  updateSettings: (input: Partial<AppState['settings']>) =>
    request<AppState['settings']>('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  sshAliases: () => request<string[]>('/api/ssh-aliases'),
  createHost: (input: { name: string; sshAlias: string; daemonPort?: number }) =>
    request<Host>('/api/hosts', { method: 'POST', body: JSON.stringify(input) }),
  removeHost: (id: string) => request(`/api/hosts/${id}`, { method: 'DELETE' }),
  reconnectHost: (id: string) => request(`/api/hosts/${id}/reconnect`, { method: 'POST' }),
  inspectHost: (id: string) => request<Record<string, string>>(`/api/hosts/${id}/inspect`),
  installHost: (id: string, artifactUrl: string) =>
    request(`/api/hosts/${id}/install`, { method: 'POST', body: JSON.stringify({ artifactUrl }) }),
  bootstrapHost: (id: string, artifactUrl?: string) =>
    request(`/api/hosts/${id}/bootstrap`, {
      method: 'POST',
      body: JSON.stringify({ artifactUrl }),
    }),
  files: (hostId: string, path = '') =>
    request<FileListing>(`/api/hosts/${hostId}/files?path=${encodeURIComponent(path)}`),
  file: (hostId: string, path: string) =>
    request<FileContent>(`/api/hosts/${hostId}/file?path=${encodeURIComponent(path)}`),
  discoverProjects: (hostId: string, path: string, register = true, maxDepth = 2) =>
    request<DiscoveredProject[]>(`/api/hosts/${hostId}/projects/discover`, {
      method: 'POST',
      body: JSON.stringify({ path, register, max_depth: maxDepth }),
    }),
  discoveredAgents: (hostId: string) => request<DiscoveredAgent[]>(`/api/hosts/${hostId}/agents`),
  sessionMessages: (
    hostId: string,
    projectId: string,
    provider: string,
    sessionId: string,
    after?: string,
    before?: string,
    limit = 100,
  ) => {
    const params = new URLSearchParams()
    if (after) params.set('after', after)
    if (before) params.set('before', before)
    if (limit) params.set('limit', String(limit))
    const qs = params.toString() ? `?${params.toString()}` : ''
    return request<SessionMessage[]>(
      `/api/projects/${hostId}/${projectId}/sessions/${encodeURIComponent(provider)}/${encodeURIComponent(sessionId)}/messages${qs}`,
    )
  },
  projectSessions: (hostId: string, projectId: string, limit: number) =>
    request<ProviderSession[]>(`/api/projects/${hostId}/${projectId}/sessions?limit=${limit}`),
  refreshProjectSessions: (hostId: string, projectId: string, limit = 50) =>
    request<ProviderSession[]>(
      `/api/projects/${hostId}/${projectId}/sessions/refresh?limit=${limit}`,
      { method: 'POST', body: '{}' },
    ),
  projectContext: (hostId: string, projectId: string) =>
    request<GitContext>(`/api/projects/${hostId}/${projectId}/git-context`),
  controlDiscoveredAgent: (
    hostId: string,
    pid: number,
    action: 'interrupt' | 'terminate' | 'kill',
  ) => request(`/api/agents/${hostId}/${pid}/${action}`, { method: 'POST' }),
  externalSessionInput: (session: ProviderSession, message: string, delivery: 'steer' | 'queue') =>
    request<{ ok: boolean; delivery: string; queued?: ExternalQueuedInput; run?: Run }>(
      `/api/external-sessions/${session.hostId}/${session.pid}/input`,
      {
        method: 'POST',
        body: JSON.stringify({
          message,
          delivery,
          session_id: session.nativeSessionId,
          project_id: session.projectId,
          title: session.title,
        }),
      },
    ),
  externalAgentInput: (
    hostId: string,
    projectId: string | null | undefined,
    pid: number,
    sessionId: string | null | undefined,
    message: string,
    delivery: 'steer' | 'queue',
  ) =>
    request<{ ok: boolean; delivery: string; queued?: ExternalQueuedInput; run?: Run }>(
      `/api/external-sessions/${hostId}/${pid}/input`,
      {
        method: 'POST',
        body: JSON.stringify({ message, delivery, session_id: sessionId, project_id: projectId }),
      },
    ),
  externalAgentTmuxLog: (hostId: string, pid: number, lines = 200) =>
    request<{
      ok: boolean
      pid: number
      pane_id: string
      session_name: string
      lines: number
      text: string
      captured_at: string
    }>(`/api/external-sessions/${hostId}/${pid}/tmux/log?lines=${lines}`),
  externalSessionQueue: (hostId: string, pid: number) =>
    request<ExternalQueuedInput[]>(`/api/external-sessions/${hostId}/${pid}/queue`),
  removeExternalQueued: (hostId: string, pid: number, queueId: string) =>
    request(`/api/external-sessions/${hostId}/${pid}/queue/${encodeURIComponent(queueId)}`, {
      method: 'DELETE',
    }),
  adoptExternalTmux: (session: ProviderSession) =>
    request<{ ok: boolean; tmux_name: string; tmux_access_command: string }>(
      `/api/external-sessions/${session.hostId}/${session.pid}/tmux/adopt`,
      {
        method: 'POST',
        body: JSON.stringify({
          project_id: session.projectId,
          session_id: session.nativeSessionId,
        }),
      },
    ),
  moveExternalToTmux: (session: ProviderSession) =>
    request<{ ok: boolean; status: string }>(
      `/api/external-sessions/${session.hostId}/${session.pid}/tmux/move`,
      {
        method: 'POST',
        body: JSON.stringify({
          project_id: session.projectId,
          session_id: session.nativeSessionId,
        }),
      },
    ),
  disableExternalTmux: (session: ProviderSession) =>
    request(`/api/external-sessions/${session.hostId}/${session.pid}/tmux/disable`, {
      method: 'POST',
      body: '{}',
    }),
  adoptExternalAgentTmux: (
    hostId: string,
    projectId: string | null | undefined,
    pid: number,
    sessionId?: string | null,
  ) =>
    request(`/api/external-sessions/${hostId}/${pid}/tmux/adopt`, {
      method: 'POST',
      body: JSON.stringify({ project_id: projectId, session_id: sessionId }),
    }),
  moveExternalAgentToTmux: (
    hostId: string,
    projectId: string | null | undefined,
    pid: number,
    sessionId?: string | null,
  ) =>
    request(`/api/external-sessions/${hostId}/${pid}/tmux/move`, {
      method: 'POST',
      body: JSON.stringify({ project_id: projectId, session_id: sessionId }),
    }),
  worktreeStatus: (hostId: string, id: string) =>
    request<WorktreeStatus>(`/api/worktrees/${hostId}/${id}/status`),
  mergeWorktree: (hostId: string, id: string, targetRef?: string) =>
    request<MergeWorktreeResult>(`/api/worktrees/${hostId}/${id}/merge`, {
      method: 'POST',
      body: JSON.stringify({ target_ref: targetRef }),
    }),
  removeWorktree: (hostId: string, id: string, force = false) =>
    request(`/api/worktrees/${hostId}/${id}?force=${force}`, { method: 'DELETE' }),
  openPath: (hostId: string, path: string) =>
    request('/api/open-path', { method: 'POST', body: JSON.stringify({ hostId, path }) }),
  createProject: (input: { hostId: string; name: string; path: string }) =>
    request<Project>('/api/projects', { method: 'POST', body: JSON.stringify(input) }),
  removeProject: (hostId: string, projectId: string) =>
    request(`/api/projects/${hostId}/${projectId}`, { method: 'DELETE' }),
  createDraft: (input: {
    hostId: string
    projectId: string
    provider?: string
    workspaceMode?: string
  }) => request<DraftSession>('/api/drafts', { method: 'POST', body: JSON.stringify(input) }),
  updateDraft: (
    id: string,
    input: { prompt?: string; provider?: string; workspaceMode?: string },
  ) => request<DraftSession>(`/api/drafts/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
  deleteDraft: (id: string) => request(`/api/drafts/${id}`, { method: 'DELETE' }),
  startDraft: (id: string, input: Record<string, unknown>) =>
    request<Run>(`/api/drafts/${id}/start`, { method: 'POST', body: JSON.stringify(input) }),
  createRun: (input: Record<string, unknown>) =>
    request<Run>('/api/runs', { method: 'POST', body: JSON.stringify(input) }),
  resumeRun: (run: Run, prompt: string, fork = false) =>
    request<Run>('/api/runs', {
      method: 'POST',
      body: JSON.stringify({
        hostId: run.hostId,
        project_id: run.projectId,
        provider: run.provider,
        model: run.model,
        prompt,
        workspace_mode: fork
          ? 'managed_worktree'
          : run.worktreeId
            ? 'existing_worktree'
            : 'current_checkout',
        worktree_id: fork ? undefined : run.worktreeId,
        parent_run_id: run.id,
        operation: fork ? 'fork' : 'resume',
        resume_session_id: run.sessionId,
      }),
    }),
  resumeSession: (session: ProviderSession, prompt: string) =>
    request<Run>('/api/runs', {
      method: 'POST',
      body: JSON.stringify({
        hostId: session.hostId,
        project_id: session.projectId,
        provider: session.provider,
        title: session.title,
        prompt,
        workspace_mode: 'current_checkout',
        operation: 'resume',
        resume_session_id: session.nativeSessionId,
      }),
    }),
  events: (hostId: string, id: string, after = 0) =>
    request<RunEvent[]>(`/api/runs/${hostId}/${id}/events?after=${after}`),
  controlRun: (hostId: string, id: string, action: 'interrupt' | 'terminate' | 'kill') =>
    request(`/api/runs/${hostId}/${id}/${action}`, { method: 'POST' }),
  input: (
    hostId: string,
    id: string,
    message: string,
    delivery: 'auto' | 'steer' | 'queue' | 'fork' = 'auto',
    lastTurnId?: string | null,
  ) =>
    request(`/api/runs/${hostId}/${id}/input`, {
      method: 'POST',
      body: JSON.stringify({
        message,
        delivery,
        last_turn_id: lastTurnId,
        request_id: crypto.randomUUID(),
      }),
    }),
  providerResponse: (hostId: string, id: string, rpcId: unknown, result: unknown) =>
    request(`/api/runs/${hostId}/${id}/response`, {
      method: 'POST',
      body: JSON.stringify({ rpc_id: rpcId, result }),
    }),
  providerModels: (hostId: string, runId: string) =>
    request<{
      models: Array<{
        id: string
        description: string
        credit_multiplier?: number | null
        active?: boolean
      }>
      efforts?: Array<{ id: string; label: string }>
      model?: string | null
      effort?: string | null
    }>(`/api/runs/${hostId}/${runId}/models`, { method: 'POST', body: '{}' }),
  setProviderModel: (hostId: string, runId: string, change: { model?: string; effort?: string }) =>
    request<{ model?: string | null; effort?: string | null }>(
      `/api/runs/${hostId}/${runId}/model`,
      { method: 'POST', body: JSON.stringify(change) },
    ),
  startQueued: (hostId: string, id: string) =>
    request(`/api/runs/${hostId}/${id}/queue/start`, { method: 'POST', body: '{}' }),
  removeQueued: (hostId: string, id: string, queueId: string) =>
    request(`/api/runs/${hostId}/${id}/queue/${encodeURIComponent(queueId)}`, { method: 'DELETE' }),
}
