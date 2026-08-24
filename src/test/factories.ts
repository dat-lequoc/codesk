import type {
  AppState,
  DiscoveredAgent,
  DraftSession,
  Host,
  Project,
  Provider,
  ProviderSession,
  Run,
  RunEvent,
  SessionMessage,
} from '../types'

let sequence = 0
const nextId = (prefix: string) => `${prefix}-${++sequence}`

/** Reset the id counter so ids are stable within a test. */
export const resetIds = () => {
  sequence = 0
}

export const makeEvent = (overrides: Partial<RunEvent> = {}): RunEvent => {
  const seq = overrides.run_sequence ?? ++sequence
  return {
    event_id: overrides.event_id ?? `event-${seq}`,
    run_id: 'run-1',
    global_sequence: seq,
    run_sequence: seq,
    timestamp: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
    channel: null,
    kind: 'assistant.message',
    payload: {},
    ...overrides,
  }
}

/** A streaming chunk: same item_id and kind coalesce into one event. */
export const makeChunk = (itemId: string, text: string, overrides: Partial<RunEvent> = {}) =>
  makeEvent({ kind: 'assistant.message', payload: { item_id: itemId, text }, ...overrides })

export const makeMessage = (overrides: Partial<SessionMessage> = {}): SessionMessage => ({
  timestamp: new Date(1_700_000_000_000).toISOString(),
  role: 'assistant',
  text: '',
  kind: 'message',
  ...overrides,
  id: overrides.id ?? nextId('message'),
})

export const makeProject = (overrides: Partial<Project> = {}): Project => ({
  hostId: 'host-local',
  name: 'codesk',
  path: '/home/dev/codesk',
  createdAt: new Date(1_700_000_000_000).toISOString(),
  ...overrides,
  id: overrides.id ?? nextId('project'),
})

export const makeHost = (overrides: Partial<Host> = {}): Host => ({
  name: 'This Mac',
  type: 'local',
  status: 'online',
  ...overrides,
  id: overrides.id ?? nextId('host'),
})

export const makeSession = (overrides: Partial<ProviderSession> = {}): ProviderSession => ({
  hostId: 'host-local',
  projectId: 'project-1',
  provider: 'codex',
  nativeSessionId: 'native-session',
  title: 'A conversation',
  cwd: '/home/dev/codesk',
  status: 'idle',
  createdAt: new Date(1_700_000_000_000).toISOString(),
  updatedAt: new Date(1_700_000_000_000).toISOString(),
  sortAt: new Date(1_700_000_000_000).toISOString(),
  ...overrides,
  id: overrides.id ?? nextId('session'),
})

export const makeRun = (overrides: Partial<Run> = {}): Run => ({
  hostId: 'host-local',
  projectId: 'project-1',
  provider: 'codex',
  model: 'gpt-5',
  title: 'A run',
  prompt: 'do the thing',
  cwd: '/home/dev/codesk',
  status: 'running',
  createdAt: new Date(1_700_000_000_000).toISOString(),
  startedAt: new Date(1_700_000_000_000).toISOString(),
  ...overrides,
  id: overrides.id ?? nextId('run'),
})

export const makeProvider = (overrides: Partial<Provider> = {}): Provider => ({
  id: 'codex',
  name: 'Codex',
  color: '#8ecf9c',
  available: true,
  executable: '/usr/local/bin/codex',
  structured_output: true,
  live_input: true,
  resume: true,
  fork: true,
  native_interrupt: true,
  ...overrides,
})

export const makeDraft = (overrides: Partial<DraftSession> = {}): DraftSession => ({
  hostId: 'host-local',
  projectId: 'project-1',
  provider: 'codex',
  title: 'New chat',
  workspaceMode: 'current_checkout',
  createdAt: new Date(1_700_000_000_000).toISOString(),
  updatedAt: new Date(1_700_000_000_000).toISOString(),
  ...overrides,
  id: overrides.id ?? nextId('draft'),
})

export const makeAgent = (overrides: Partial<DiscoveredAgent> = {}): DiscoveredAgent => ({
  provider: 'codex',
  pid: 4242,
  process_group_id: 4242,
  command: 'codex',
  cwd: '/home/dev/codesk',
  ...overrides,
  id: overrides.id ?? nextId('agent'),
})

export const makeState = (overrides: Partial<AppState> = {}): AppState => ({
  hosts: [],
  projects: [],
  runs: [],
  sessions: [],
  drafts: [],
  providersByHost: {},
  discoveredAgentsByHost: {},
  settings: {
    theme: 'system',
    notifications: true,
    pinnedSessionKeys: [],
    pinnedSessions: [],
    archivedSessionKeys: [],
    archivedSessions: [],
    archivedRunKeys: [],
    hiddenAgentKeys: [],
  },
  ...overrides,
})
