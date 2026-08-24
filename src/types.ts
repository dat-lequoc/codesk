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

export type GitContext = {
  branch?: string | null
  available: boolean
  detached: boolean
  dirty: boolean
}

export type Worktree = {
  id: string
  project_id: string
  path: string
  branch?: string | null
  base_ref?: string | null
  ownership: 'managed' | 'discovered' | string
  status: string
  created_at: string
}

export type WorktreeStatus = {
  worktree: Worktree
  dirty: boolean
  summary: string
  diff_stat: string
}

export type MergeWorktreeResult = {
  worktree_id: string
  source_branch: string
  target_branch: string
  commit: string
  changed: boolean
  summary: string
}

export type Provider = {
  id: string
  name: string
  color: string
  available: boolean
  executable: string | null
  structured_output: boolean
  live_input: boolean
  resume: boolean
  fork: boolean
  native_interrupt: boolean
  queued_input?: boolean
  turn_rewind?: boolean
  provider_responses?: boolean
  runner?: 'stdio' | 'acp' | 'codex_app_server' | 'dsh_web'
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
  status:
    | 'queued'
    | 'starting'
    | 'running'
    | 'waiting_for_input'
    | 'interrupting'
    | 'completed'
    | 'failed'
    | 'interrupted'
    | 'killed'
    | 'orphaned'
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
  inputTransport?: 'tmux' | null
  tmuxName?: string | null
  tmuxAccessCommand?: string | null
  tmuxHostAccessCommand?: string | null
}

export type AppState = {
  hosts: Host[]
  projects: Project[]
  runs: Run[]
  sessions: ProviderSession[]
  drafts: DraftSession[]
  providersByHost: Record<string, Provider[]>
  settings: {
    notifications: boolean
    /// Palette preference; `system` follows the OS appearance.
    theme: 'system' | 'light' | 'dark'
    pinnedSessionKeys: string[]
    pinnedSessions: ProviderSession[]
    archivedSessionKeys: string[]
    archivedSessions: ProviderSession[]
    /// Managed runs the user has archived, keyed `hostId:runId`. Runs need no
    /// snapshot because the daemon keeps reporting them, unlike historical
    /// provider sessions which can drop out of the index.
    archivedRunKeys: string[]
    /// Discovered external processes the user hid from the sidebar, keyed
    /// `hostId:pid:command-hash`. Same persistence pattern as archived runs.
    hiddenAgentKeys: string[]
  }
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
  sortAt: string
  status: 'running' | 'stopped' | 'idle'
  pid?: number | null
  managedRunId?: string | null
  inputAvailable?: boolean
  inputTransport?: 'resume' | 'acp' | 'api' | 'tmux' | null
  tmuxName?: string | null
  tmuxAccessCommand?: string | null
  tmuxHostAccessCommand?: string | null
  tmuxControlled?: boolean
  tmuxOwned?: boolean
  model?: string | null
  effort?: string | null
}

export type ExternalQueuedInput = {
  id: string
  pid: number
  project_id: string
  session_id?: string | null
  message: string
  title?: string | null
  created_at: string
  status: 'queued' | 'sending' | 'started' | 'failed'
  error?: string
  run?: Run
}

export type SessionMessage = {
  id: string
  timestamp: string
  role: 'user' | 'assistant'
  text: string
  kind?: 'message' | 'reasoning' | 'tool' | 'tool_output' | 'file_change' | 'turn_completed'
  meta?: {
    call_id?: string
    command?: unknown
    input?: unknown
    output?: unknown
    raw?: unknown
    status?: string
    tool?: string
    server?: string
    display?: string
    changes?: Array<{ path?: string; kind?: string; diff?: string }>
  }
  duration_ms?: number
}

export type FileEntry = { name: string; path: string; is_dir: boolean; is_git: boolean }
export type FileListing = {
  current_path: string
  parent_path?: string | null
  home_path: string
  entries: FileEntry[]
}
export type FileContent = {
  path: string
  name: string
  content: string
  mime_type?: string
  data_url?: string
  size: number
  truncated: boolean
}
export type DiscoveredProject = {
  name: string
  path: string
  repo_root?: string | null
  registered_project_id?: string | null
}
export type DiscoveredAgent = {
  id: string
  provider: Provider['id']
  pid: number
  process_group_id: number
  cwd?: string | null
  command: string
  managed_run_id?: string | null
  native_session_id?: string | null
  transcript_path?: string | null
  tty?: string | null
  tmux_pane_id?: string | null
  tmux_session_name?: string | null
  tmux_access_command?: string | null
  tmux_host_access_command?: string | null
  tmux_controlled?: boolean
  tmux_owned?: boolean
}
