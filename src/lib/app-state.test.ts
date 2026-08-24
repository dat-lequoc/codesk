import { beforeEach, describe, expect, it } from 'vitest'

import { makeAgent, makeProject, makeSession, makeState, resetIds } from '../test/factories'
import type { FileEntry } from '../types'
import {
  empty,
  folderMatchScore,
  normalizeState,
  observedAgents,
  projectForAgent,
} from './app-state'

beforeEach(resetIds)

const file = (name: string, path = `/home/dev/${name}`): FileEntry =>
  ({ name, path, is_git: false }) as FileEntry

describe('empty', () => {
  it('is a fully populated shape, so consumers never hit an undefined list', () => {
    expect(empty.hosts).toEqual([])
    expect(empty.projects).toEqual([])
    expect(empty.settings.notifications).toBe(true)
    expect(empty.settings.pinnedSessionKeys).toEqual([])
  })
})

describe('projectForAgent', () => {
  const project = makeProject({ hostId: 'host-a', path: '/home/dev/codesk' })

  it('matches an agent whose cwd is the project path', () => {
    const agent = makeAgent({ cwd: '/home/dev/codesk' })
    expect(projectForAgent([project], 'host-a', agent)).toBe(project)
  })

  it('ignores a trailing slash on either side', () => {
    const agent = makeAgent({ cwd: '/home/dev/codesk/' })
    expect(projectForAgent([project], 'host-a', agent)).toBe(project)
  })

  it('does not match a project on another host', () => {
    const agent = makeAgent({ cwd: '/home/dev/codesk' })
    expect(projectForAgent([project], 'host-b', agent)).toBeUndefined()
  })

  it('does not match a nested folder', () => {
    const agent = makeAgent({ cwd: '/home/dev/codesk/src' })
    expect(projectForAgent([project], 'host-a', agent)).toBeUndefined()
  })

  it('returns undefined for an agent with no cwd', () => {
    expect(projectForAgent([project], 'host-a', makeAgent({ cwd: null }))).toBeUndefined()
  })
})

describe('observedAgents', () => {
  const withAgents = (agents = [makeAgent()], overrides = {}) =>
    makeState({ discoveredAgentsByHost: { 'host-a': agents }, ...overrides })

  it('surfaces a discovered agent', () => {
    const result = observedAgents(withAgents())
    expect(result).toHaveLength(1)
    expect(result[0].hostId).toBe('host-a')
  })

  it('skips an agent Codesk already manages', () => {
    expect(observedAgents(withAgents([makeAgent({ managed_run_id: 'run-1' })]))).toEqual([])
  })

  it('skips Codex internal helper processes', () => {
    expect(observedAgents(withAgents([makeAgent({ command: 'codex-code-mode-host' })]))).toEqual([])
    expect(observedAgents(withAgents([makeAgent({ command: 'codex app-server' })]))).toEqual([])
  })

  it('skips an agent whose session is already indexed', () => {
    const state = withAgents([makeAgent({ provider: 'codex', native_session_id: 'native-1' })], {
      sessions: [makeSession({ hostId: 'host-a', provider: 'codex', nativeSessionId: 'native-1' })],
    })
    expect(observedAgents(state)).toEqual([])
  })

  it('still surfaces an agent whose session id belongs to a different host', () => {
    const state = withAgents([makeAgent({ provider: 'codex', native_session_id: 'native-1' })], {
      sessions: [makeSession({ hostId: 'host-b', provider: 'codex', nativeSessionId: 'native-1' })],
    })
    expect(observedAgents(state)).toHaveLength(1)
  })

  it('deduplicates agents that share a process group', () => {
    const state = withAgents([
      makeAgent({ pid: 1, process_group_id: 100 }),
      makeAgent({ pid: 2, process_group_id: 100 }),
    ])
    expect(observedAgents(state)).toHaveLength(1)
  })

  it('keeps agents in separate process groups apart', () => {
    const state = withAgents([
      makeAgent({ pid: 1, process_group_id: 100 }),
      makeAgent({ pid: 2, process_group_id: 200 }),
    ])
    expect(observedAgents(state)).toHaveLength(2)
  })

  it('attaches the owning project when the cwd matches one', () => {
    const project = makeProject({ hostId: 'host-a', path: '/home/dev/codesk' })
    const state = withAgents([makeAgent({ cwd: '/home/dev/codesk' })], { projects: [project] })
    expect(observedAgents(state)[0].project).toBe(project)
  })

  it('leaves the project undefined for a folder outside every project', () => {
    const state = withAgents([makeAgent({ cwd: '/tmp/elsewhere' })])
    expect(observedAgents(state)[0].project).toBeUndefined()
  })

  it('also matches against pinned and archived sessions, not just live ones', () => {
    const session = makeSession({
      hostId: 'host-a',
      provider: 'codex',
      nativeSessionId: 'native-1',
    })
    const archived = makeState({
      discoveredAgentsByHost: {
        'host-a': [makeAgent({ provider: 'codex', native_session_id: 'native-1' })],
      },
      settings: { ...makeState().settings, archivedSessions: [session] },
    })
    expect(observedAgents(archived)).toEqual([])
  })

  it('returns nothing when no agents were discovered', () => {
    expect(observedAgents(makeState())).toEqual([])
  })
})

describe('folderMatchScore', () => {
  it('ranks exact name, prefix, substring, then path match', () => {
    expect(folderMatchScore(file('codesk'), 'codesk')).toBe(0)
    expect(folderMatchScore(file('codesk-app'), 'codesk')).toBe(1)
    expect(folderMatchScore(file('my-codesk'), 'codesk')).toBe(2)
    expect(folderMatchScore(file('other', '/home/codesk/other'), 'codesk')).toBe(3)
  })

  it('falls back to a subsequence match', () => {
    expect(folderMatchScore(file('c-o-d-e-s-k', '/x/c-o-d-e-s-k'), 'codesk')).toBe(4)
  })

  it('rejects a folder that does not match at all', () => {
    expect(folderMatchScore(file('unrelated', '/x/unrelated'), 'codesk')).toBe(
      Number.POSITIVE_INFINITY,
    )
  })

  it('treats an empty query as a tie so ordering is left alone', () => {
    expect(folderMatchScore(file('anything'), '')).toBe(0)
    expect(folderMatchScore(file('anything'), '   ')).toBe(0)
  })

  it('is case-insensitive', () => {
    expect(folderMatchScore(file('CodeSk'), 'codesk')).toBe(0)
    expect(folderMatchScore(file('codesk'), 'CODESK')).toBe(0)
  })

  it('sorts a realistic candidate list best-first', () => {
    const entries = [
      file('unrelated', '/x/unrelated'),
      file('my-codesk'),
      file('codesk'),
      file('codesk-app'),
    ]
    const sorted = [...entries].sort(
      (a, b) => folderMatchScore(a, 'codesk') - folderMatchScore(b, 'codesk'),
    )
    expect(sorted.map((entry) => entry.name)).toEqual([
      'codesk',
      'codesk-app',
      'my-codesk',
      'unrelated',
    ])
  })
})

describe('normalizeState', () => {
  it('fills in a missing drafts list', () => {
    const value = { ...makeState(), drafts: undefined } as unknown as Parameters<
      typeof normalizeState
    >[0]
    expect(normalizeState(value).drafts).toEqual([])
  })

  it('fills in every missing settings list', () => {
    const value = { ...makeState(), settings: undefined } as unknown as Parameters<
      typeof normalizeState
    >[0]
    const settings = normalizeState(value).settings
    expect(settings.pinnedSessionKeys).toEqual([])
    expect(settings.archivedRunKeys).toEqual([])
    expect(settings.hiddenAgentKeys).toEqual([])
    expect(settings.notifications).toBe(true)
    expect(settings.theme).toBe('system')
  })

  it('preserves notifications when explicitly disabled', () => {
    const state = makeState()
    state.settings.notifications = false
    expect(normalizeState(state).settings.notifications).toBe(false)
  })

  it('keeps values that are already present', () => {
    const state = makeState()
    state.settings.pinnedSessionKeys = ['host:s1']
    expect(normalizeState(state).settings.pinnedSessionKeys).toEqual(['host:s1'])
  })
})
