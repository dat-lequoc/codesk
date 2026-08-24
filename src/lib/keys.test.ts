import { beforeEach, describe, expect, it } from 'vitest'

import { makeProject, makeRun, makeSession, resetIds } from '../test/factories'
import {
  normalizedFolder,
  projectKey,
  recentFirst,
  runEventNotificationKey,
  runNotificationKeys,
  runRowKey,
  sessionKey,
  sessionNotificationKey,
  terminalNotificationTag,
  threadScrollKeyForRun,
  threadScrollKeyForSession,
} from './keys'

beforeEach(resetIds)

describe('identity keys', () => {
  it('scopes a project key by host so two hosts never collide', () => {
    const a = makeProject({ id: 'p1', hostId: 'host-a' })
    const b = makeProject({ id: 'p1', hostId: 'host-b' })
    expect(projectKey(a)).not.toBe(projectKey(b))
  })

  it('scopes session and run keys by host too', () => {
    expect(sessionKey(makeSession({ id: 's1', hostId: 'host-a' }))).toBe('host-a:s1')
    expect(runRowKey(makeRun({ id: 'r1', hostId: 'host-a' }))).toBe('host-a:r1')
  })

  it('is stable across calls for the same record', () => {
    const project = makeProject()
    expect(projectKey(project)).toBe(projectKey(project))
  })
})

describe('normalizedFolder', () => {
  it('strips trailing slashes', () => {
    expect(normalizedFolder('/home/dev/')).toBe('/home/dev')
    expect(normalizedFolder('/home/dev///')).toBe('/home/dev')
  })

  it('leaves a path without a trailing slash alone', () => {
    expect(normalizedFolder('/home/dev')).toBe('/home/dev')
  })

  it('preserves root, which is only a slash', () => {
    expect(normalizedFolder('/')).toBe('/')
  })

  it('leaves the empty string alone', () => {
    expect(normalizedFolder('')).toBe('')
  })
})

describe('recentFirst', () => {
  const at = (sortAt: string, status: 'running' | 'idle' = 'idle') =>
    makeSession({ sortAt, status })

  it('sorts newer sessions first', () => {
    const older = at('2026-01-01T00:00:00.000Z')
    const newer = at('2026-01-02T00:00:00.000Z')
    expect([older, newer].sort(recentFirst)[0]).toBe(newer)
  })

  it('breaks a timestamp tie in favour of a running session', () => {
    const idle = at('2026-01-01T00:00:00.000Z', 'idle')
    const running = at('2026-01-01T00:00:00.000Z', 'running')
    expect([idle, running].sort(recentFirst)[0]).toBe(running)
  })

  it('is a consistent comparator — reversing the input reverses the sign', () => {
    const a = at('2026-01-01T00:00:00.000Z')
    const b = at('2026-01-02T00:00:00.000Z')
    expect(Math.sign(recentFirst(a, b))).toBe(-Math.sign(recentFirst(b, a)))
  })
})

describe('notification keys', () => {
  it('derives a run key from the run id alone', () => {
    expect(runEventNotificationKey('host-a', 'run-1')).toBe('run:run-1')
  })

  it('identifies a session by host, provider and native id', () => {
    const session = makeSession({
      hostId: 'host-a',
      provider: 'codex',
      nativeSessionId: 'native-1',
    })
    expect(sessionNotificationKey(session)).toBe('session:host-a:codex:native-1')
  })

  it('gives a run without a session exactly one key', () => {
    const keys = runNotificationKeys(makeRun({ id: 'run-1', sessionId: undefined }))
    expect(keys).toEqual(['run:run-1'])
  })

  it('adds the session key when a run is attached to one', () => {
    const keys = runNotificationKeys(
      makeRun({ id: 'run-1', hostId: 'host-a', provider: 'codex', sessionId: 'native-1' }),
    )
    expect(keys).toEqual(['run:run-1', 'session:host-a:codex:native-1'])
  })

  it('produces a run key that matches the session key format used elsewhere', () => {
    const run = makeRun({ hostId: 'host-a', provider: 'codex', sessionId: 'native-1' })
    const session = makeSession({
      hostId: 'host-a',
      provider: 'codex',
      nativeSessionId: 'native-1',
    })
    expect(runNotificationKeys(run)).toContain(sessionNotificationKey(session))
  })

  it('reuses the session scroll key for a run that belongs to one', () => {
    const session = makeSession({
      hostId: 'host-a',
      provider: 'codex',
      nativeSessionId: 'native-1',
    })
    const run = makeRun({
      hostId: 'host-a',
      provider: 'codex',
      sessionId: 'native-1',
    })
    expect(threadScrollKeyForSession(session)).toBe(sessionNotificationKey(session))
    expect(threadScrollKeyForRun(run)).toBe(threadScrollKeyForSession(session))
  })

  it('keeps an unattached run on its own scroll key', () => {
    expect(threadScrollKeyForRun(makeRun({ id: 'run-1', sessionId: undefined }))).toBe('run:run-1')
  })

  it('tags a terminal notification per run and status, so each fires once', () => {
    expect(terminalNotificationTag('run-1', 'completed')).toBe('run-status:run-1:completed')
    expect(terminalNotificationTag('run-1', 'failed')).not.toBe(
      terminalNotificationTag('run-1', 'completed'),
    )
  })
})
