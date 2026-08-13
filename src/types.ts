export type Host = {
  id: string
  name: string
  type: 'local' | 'ssh'
  sshAlias?: string
  daemonPort?: number
  localPort?: number
  status: 'online' | 'offline' | 'checking' | 'connecting'
  error?: string | null
  lastSeen?: string
  health?: { version: string; uptime_seconds: number; active_runs: number; host_name: string }
}

export type Project = {
  id: string
  hostId: string
  name: string
  path: string
  repoRoot?: string | null
  createdAt: string
}

export type Provider = {
  id: 'codex' | 'pi' | 'claude' | 'shell'
  name: string
  color: string
  available: boolean
  executable: string | null
  structured_output: boolean
  live_input: boolean
  resume: boolean
  fork: boolean
  native_interrupt: boolean
  limitations?: string[]
}

export type RunEvent = {
  event_id: string
  run_id: string
  global_sequence: number
  run_sequence: number
  timestamp: string
  channel?: string | null
  kind: string
  provider_event_type?: string | null
  payload: { text?: string; [key: string]: unknown }
  raw_payload?: unknown
}

export type Run = {
  id: string
  projectId: string
  worktreeId?: string | null
  title: string
  prompt: string
  provider: Provider['id']
  model: string
  command?: string
  hostId: string
  cwd: string
  status: 'queued' | 'starting' | 'running' | 'waiting_for_input' | 'interrupting' | 'completed' | 'failed' | 'interrupted' | 'killed' | 'orphaned'
  createdAt: string
  startedAt: string
  finishedAt?: string | null
  exitCode?: number | null
  sessionId?: string
  displayCommand?: string
  parentRunId?: string | null
  connectionError?: string
  events?: RunEvent[]
  processGroupId?: number | null
  terminatingSignal?: string | null
}

export type AppState = {
  hosts: Host[]
  projects: Project[]
  runs: Run[]
  sessions: ProviderSession[]
  drafts: DraftSession[]
  providersByHost: Record<string, Provider[]>
  settings: { notifications: boolean }
  discoveredAgentsByHost?: Record<string, DiscoveredAgent[]>
}

export type DraftSession = {
  id: string
  hostId: string
  projectId: string
  title: 'New chat'
  prompt?: string
  provider: Provider['id']
  workspaceMode: 'current_checkout' | 'managed_worktree'
  createdAt: string
  updatedAt: string
}

export type ProviderSession = {
  id: string
  provider: Provider['id']
  nativeSessionId: string
  projectId: string
  hostId: string
  cwd: string
  title: string
  createdAt: string
  updatedAt: string
  status: 'running' | 'idle'
  pid?: number | null
}

export type SessionMessage = {
  id: string
  timestamp: string
  role: 'user' | 'assistant'
  text: string
}

export type FileEntry = { name: string; path: string; is_dir: boolean; is_git: boolean }
export type DiscoveredProject = { name: string; path: string; repo_root?: string | null; registered_project_id?: string | null }
export type DiscoveredAgent = { id: string; provider: Provider['id']; pid: number; process_group_id: number; cwd?: string | null; command: string; managed_run_id?: string | null }
