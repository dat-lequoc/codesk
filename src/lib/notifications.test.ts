import { beforeEach, describe, expect, it } from 'vitest'

import { makeRun, makeSession, makeState, resetIds } from '../test/factories'
import { sessionKey, sessionNotificationKey } from './keys'
import { reconcileUnreadKeys } from './notifications'

beforeEach(resetIds)

describe('reconcileUnreadKeys', () => {
  it('keeps an unread key whose session still exists', () => {
    const session = makeSession({ hostId: 'host-a', provider: 'codex', nativeSessionId: 'n1' })
    const key = sessionNotificationKey(session)
    const result = reconcileUnreadKeys(new Set([key]), makeState({ sessions: [session] }))
    expect(result).toEqual(new Set([key]))
  })

  it('drops an unread key whose session and run are both gone', () => {
    const result = reconcileUnreadKeys(new Set(['session:host-a:codex:vanished']), makeState())
    expect(result).toEqual(new Set())
  })

  // A run-scoped unread must follow the conversation once the run reports the
  // session it belongs to, or the badge would be stranded on a finished run.
  it('promotes a run key to its session key once the run has a session', () => {
    const run = makeRun({ id: 'run-1', hostId: 'host-a', provider: 'codex', sessionId: 'n1' })
    const result = reconcileUnreadKeys(new Set(['run:run-1']), makeState({ runs: [run] }))
    expect(result).toEqual(new Set(['session:host-a:codex:n1']))
  })

  it('keeps a run key as-is when the run has no session yet', () => {
    const run = makeRun({ id: 'run-1', sessionId: undefined })
    const result = reconcileUnreadKeys(new Set(['run:run-1']), makeState({ runs: [run] }))
    expect(result).toEqual(new Set(['run:run-1']))
  })

  it('treats a run session id as valid even without a matching session record', () => {
    const run = makeRun({ hostId: 'host-a', provider: 'codex', sessionId: 'n1' })
    const key = 'session:host-a:codex:n1'
    expect(reconcileUnreadKeys(new Set([key]), makeState({ runs: [run] }))).toEqual(new Set([key]))
  })

  it('keeps unread badges on pinned conversations', () => {
    const pinned = makeSession({ hostId: 'host-a', provider: 'codex', nativeSessionId: 'pin' })
    const base = makeState()
    const state = makeState({
      settings: { ...base.settings, pinnedSessions: [pinned] },
    })
    const keys = new Set([sessionNotificationKey(pinned)])
    expect(reconcileUnreadKeys(keys, state)).toEqual(keys)
  })

  // Archiving is the user saying they are done with the conversation, so the
  // bell must not keep counting it — nothing visible would explain the badge.
  it('drops unread badges on archived conversations', () => {
    const archived = makeSession({ hostId: 'host-a', provider: 'codex', nativeSessionId: 'arc' })
    const base = makeState()
    const state = makeState({
      settings: {
        ...base.settings,
        archivedSessionKeys: [sessionKey(archived)],
        archivedSessions: [archived],
      },
    })
    expect(reconcileUnreadKeys(new Set([sessionNotificationKey(archived)]), state)).toEqual(
      new Set(),
    )
  })

  it('drops the unread badge of an archived run instead of promoting it', () => {
    const run = makeRun({ id: 'run-1', hostId: 'host-a', provider: 'codex', sessionId: 'n1' })
    const base = makeState()
    const state = makeState({
      runs: [run],
      settings: { ...base.settings, archivedRunKeys: [`${run.hostId}:${run.id}`] },
    })
    expect(reconcileUnreadKeys(new Set(['run:run-1']), state)).toEqual(new Set())
  })

  it('collapses two run keys that resolve to the same session', () => {
    const state = makeState({
      runs: [
        makeRun({ id: 'run-1', hostId: 'host-a', provider: 'codex', sessionId: 'n1' }),
        makeRun({ id: 'run-2', hostId: 'host-a', provider: 'codex', sessionId: 'n1' }),
      ],
    })
    const result = reconcileUnreadKeys(new Set(['run:run-1', 'run:run-2']), state)
    expect(result).toEqual(new Set(['session:host-a:codex:n1']))
  })

  it('returns an empty set for empty input', () => {
    expect(reconcileUnreadKeys(new Set(), makeState())).toEqual(new Set())
  })

  it('does not mutate the set it was given', () => {
    const current = new Set(['session:host-a:codex:gone'])
    reconcileUnreadKeys(current, makeState())
    expect(current).toEqual(new Set(['session:host-a:codex:gone']))
  })

  it('is idempotent — reconciling twice changes nothing further', () => {
    const run = makeRun({ id: 'run-1', hostId: 'host-a', provider: 'codex', sessionId: 'n1' })
    const state = makeState({ runs: [run] })
    const once = reconcileUnreadKeys(new Set(['run:run-1']), state)
    expect(reconcileUnreadKeys(once, state)).toEqual(once)
  })
})
