import { beforeEach, describe, expect, it } from 'vitest'

import { makeChunk, makeEvent, makeMessage, resetIds } from '../test/factories'
import {
  active,
  coalesceStreamEvents,
  currentBranchEvents,
  mergeEvents,
  mergeSessionMessages,
  pendingQueue,
  terminalRunStatuses,
  terminalStatusByEventKind,
  transcriptTurnOpen,
} from './events'

beforeEach(resetIds)

describe('active / terminal status sets', () => {
  it('treats in-flight statuses as active and finished ones as terminal', () => {
    for (const status of ['queued', 'starting', 'running', 'waiting_for_input', 'interrupting'])
      expect(active.has(status)).toBe(true)
    for (const status of ['completed', 'failed', 'interrupted', 'killed', 'orphaned'] as const)
      expect(terminalRunStatuses.has(status)).toBe(true)
  })

  it('never classifies a status as both active and terminal', () => {
    for (const status of terminalRunStatuses) expect(active.has(status)).toBe(false)
  })

  it('maps terminal event kinds to statuses that are themselves terminal', () => {
    expect(terminalStatusByEventKind.size).toBeGreaterThan(0)
    for (const status of terminalStatusByEventKind.values())
      expect(terminalRunStatuses.has(status)).toBe(true)
  })
})

describe('mergeEvents', () => {
  it('orders by run_sequence rather than arrival order', () => {
    const merged = mergeEvents(
      [makeEvent({ event_id: 'c', run_sequence: 3 })],
      [
        makeEvent({ event_id: 'a', run_sequence: 1 }),
        makeEvent({ event_id: 'b', run_sequence: 2 }),
      ],
    )
    expect(merged.map((event) => event.event_id)).toEqual(['a', 'b', 'c'])
  })

  it('lets an incoming event replace a prior one with the same id', () => {
    const merged = mergeEvents(
      [makeEvent({ event_id: 'a', run_sequence: 1, payload: { text: 'old' } })],
      [makeEvent({ event_id: 'a', run_sequence: 1, payload: { text: 'new' } })],
    )
    expect(merged).toHaveLength(1)
    expect(merged[0].payload.text).toBe('new')
  })

  it('is idempotent when the same batch arrives twice', () => {
    const batch = [makeEvent({ event_id: 'a', run_sequence: 1 })]
    expect(mergeEvents(mergeEvents([], batch), batch)).toHaveLength(1)
  })

  it('returns prior events unchanged when nothing arrives', () => {
    const prior = [makeEvent({ event_id: 'a', run_sequence: 1 })]
    expect(mergeEvents(prior, [])).toEqual(prior)
  })
})

describe('coalesceStreamEvents', () => {
  it('concatenates consecutive chunks that share an item id', () => {
    const result = coalesceStreamEvents([
      makeChunk('item-1', 'Hello '),
      makeChunk('item-1', 'world'),
    ])
    expect(result).toHaveLength(1)
    expect(result[0].payload.text).toBe('Hello world')
  })

  it('keeps separate items separate', () => {
    const result = coalesceStreamEvents([makeChunk('item-1', 'a'), makeChunk('item-2', 'b')])
    expect(result.map((event) => event.payload.text)).toEqual(['a', 'b'])
  })

  it('does not merge across an interleaved event of another kind', () => {
    const result = coalesceStreamEvents([
      makeChunk('item-1', 'a'),
      makeEvent({ kind: 'tool.call', payload: { item_id: 'item-1' } }),
      makeChunk('item-1', 'b'),
    ])
    expect(result).toHaveLength(3)
  })

  it('does not merge chunks from different channels', () => {
    const result = coalesceStreamEvents([
      makeChunk('item-1', 'a', { channel: 'stdout' }),
      makeChunk('item-1', 'b', { channel: 'stderr' }),
    ])
    expect(result).toHaveLength(2)
  })

  it('leaves events without an item id untouched', () => {
    const result = coalesceStreamEvents([
      makeEvent({ kind: 'assistant.message', payload: { text: 'a' } }),
      makeEvent({ kind: 'assistant.message', payload: { text: 'b' } }),
    ])
    expect(result).toHaveLength(2)
  })

  it('replaces rather than appends for tool.output, which resends whole content', () => {
    const result = coalesceStreamEvents([
      makeEvent({ kind: 'tool.output', payload: { item_id: 'tool-1', text: 'partial' } }),
      makeEvent({ kind: 'tool.output', payload: { item_id: 'tool-1', text: 'complete output' } }),
    ])
    expect(result).toHaveLength(1)
    expect(result[0].payload.text).toBe('complete output')
  })

  it('lets a completed item replace the accumulated stream instead of doubling it', () => {
    const result = coalesceStreamEvents([
      makeChunk('item-1', 'Hel'),
      makeChunk('item-1', 'lo'),
      makeChunk('item-1', 'Hello', { provider_event_type: 'codex.item/completed' }),
    ])
    expect(result).toHaveLength(1)
    expect(result[0].payload.text).toBe('Hello')
  })

  it('coalesces reasoning the same way as assistant text', () => {
    const result = coalesceStreamEvents([
      makeEvent({ kind: 'reasoning.message', payload: { item_id: 'r1', text: 'think' } }),
      makeEvent({ kind: 'reasoning.message', payload: { item_id: 'r1', text: 'ing' } }),
    ])
    expect(result).toHaveLength(1)
    expect(result[0].payload.text).toBe('thinking')
  })

  it('carries the newest metadata onto the coalesced event', () => {
    const result = coalesceStreamEvents([
      makeChunk('item-1', 'a', { event_id: 'first', run_sequence: 1 }),
      makeChunk('item-1', 'b', { event_id: 'second', run_sequence: 2 }),
    ])
    expect(result[0].event_id).toBe('second')
    expect(result[0].run_sequence).toBe(2)
  })

  it('treats a missing text field as empty rather than "undefined"', () => {
    const result = coalesceStreamEvents([
      makeEvent({ kind: 'assistant.message', payload: { item_id: 'i' } }),
      makeChunk('i', 'tail'),
    ])
    expect(result[0].payload.text).toBe('tail')
  })

  it('returns an empty list unchanged', () => {
    expect(coalesceStreamEvents([])).toEqual([])
  })
})

describe('currentBranchEvents', () => {
  const rewind = (lastTurnId: string | null, overrides = {}) =>
    makeEvent({
      kind: 'thread.session',
      raw_payload: { action: 'rewind' },
      payload: lastTurnId ? { last_turn_id: lastTurnId } : {},
      ...overrides,
    })

  it('returns every event when no rewind happened', () => {
    const events = [makeEvent(), makeEvent()]
    expect(currentBranchEvents(events)).toEqual(events)
  })

  it('keeps history up to the rewind point and drops the abandoned branch', () => {
    const kept = makeEvent({ event_id: 'kept', payload: { turn_id: 'turn-1' } })
    const abandoned = makeEvent({ event_id: 'abandoned', payload: { turn_id: 'turn-2' } })
    const marker = rewind('turn-1', { event_id: 'rewind' })
    const after = makeEvent({ event_id: 'after' })

    const result = currentBranchEvents([kept, abandoned, marker, after])
    expect(result.map((event) => event.event_id)).toEqual(['kept', 'rewind', 'after'])
  })

  it('drops all prior history when the rewind names no turn', () => {
    const result = currentBranchEvents([
      makeEvent({ event_id: 'old' }),
      rewind(null, { event_id: 'rewind' }),
      makeEvent({ event_id: 'after' }),
    ])
    expect(result.map((event) => event.event_id)).toEqual(['rewind', 'after'])
  })

  it('anchors on the most recent rewind, keeping all history up to its turn', () => {
    const result = currentBranchEvents([
      makeEvent({ event_id: 'a', payload: { turn_id: 'turn-1' } }),
      rewind('turn-1', { event_id: 'rewind-1' }),
      makeEvent({ event_id: 'b', payload: { turn_id: 'turn-2' } }),
      rewind('turn-2', { event_id: 'rewind-2' }),
    ])
    // turn-2 is the anchor, so everything through it survives — including the
    // earlier rewind marker, which is part of that history.
    expect(result.map((event) => event.event_id)).toEqual(['a', 'rewind-1', 'b', 'rewind-2'])
  })

  it('drops events that came after the anchor turn on the abandoned branch', () => {
    const result = currentBranchEvents([
      makeEvent({ event_id: 'kept', payload: { turn_id: 'turn-1' } }),
      makeEvent({ event_id: 'dropped-1', payload: { turn_id: 'turn-2' } }),
      makeEvent({ event_id: 'dropped-2', payload: { turn_id: 'turn-3' } }),
      rewind('turn-1', { event_id: 'rewind' }),
    ])
    expect(result.map((event) => event.event_id)).toEqual(['kept', 'rewind'])
  })

  it('ignores thread.session events that are not rewinds', () => {
    const events = [
      makeEvent({ event_id: 'a' }),
      makeEvent({ kind: 'thread.session', raw_payload: { action: 'resume' } }),
    ]
    expect(currentBranchEvents(events)).toEqual(events)
  })

  it('keeps the last matching turn when a turn id repeats', () => {
    const result = currentBranchEvents([
      makeEvent({ event_id: 'first', payload: { turn_id: 'turn-1' } }),
      makeEvent({ event_id: 'second', payload: { turn_id: 'turn-1' } }),
      rewind('turn-1', { event_id: 'rewind' }),
    ])
    expect(result.map((event) => event.event_id)).toEqual(['first', 'second', 'rewind'])
  })
})

describe('pendingQueue', () => {
  const queue = (kind: string, id: string, extra: Record<string, unknown> = {}) =>
    makeEvent({ kind, payload: { queue_id: id, ...extra } })

  it('lists prompts that were added and not yet consumed', () => {
    const result = pendingQueue([
      queue('queue.added', 'q1', { text: 'first' }),
      queue('queue.added', 'q2', { text: 'second' }),
    ])
    expect(result.map((item) => item.message)).toEqual(['first', 'second'])
  })

  it('removes an entry once it starts', () => {
    const result = pendingQueue([
      queue('queue.added', 'q1', { text: 'first' }),
      queue('queue.started', 'q1'),
    ])
    expect(result).toEqual([])
  })

  it('removes an entry the user deleted', () => {
    const result = pendingQueue([
      queue('queue.added', 'q1', { text: 'first' }),
      queue('queue.removed', 'q1'),
    ])
    expect(result).toEqual([])
  })

  it('surfaces the provider message on a failed entry', () => {
    const failed = makeEvent({
      kind: 'queue.failed',
      payload: { queue_id: 'q1', text: 'first' },
      raw_payload: { error: { message: 'provider rejected it' } },
    })
    expect(pendingQueue([failed])[0].error).toBe('provider rejected it')
  })

  it('falls back to a generic reason when a failure carries no message', () => {
    const failed = makeEvent({ kind: 'queue.failed', payload: { queue_id: 'q1' } })
    expect(pendingQueue([failed])[0].error).toBe('Failed to start')
  })

  it('clears the error when a failed entry is re-added', () => {
    const result = pendingQueue([
      makeEvent({ kind: 'queue.failed', payload: { queue_id: 'q1' } }),
      queue('queue.added', 'q1', { text: 'retry' }),
    ])
    expect(result[0].error).toBeUndefined()
  })

  it('ignores events without a queue id', () => {
    expect(pendingQueue([makeEvent({ kind: 'queue.added', payload: {} })])).toEqual([])
  })

  it('preserves insertion order', () => {
    const result = pendingQueue([
      queue('queue.added', 'q1', { text: 'a' }),
      queue('queue.added', 'q2', { text: 'b' }),
      queue('queue.started', 'q1'),
      queue('queue.added', 'q3', { text: 'c' }),
    ])
    expect(result.map((item) => item.id)).toEqual(['q2', 'q3'])
  })
})

describe('mergeSessionMessages', () => {
  it('returns the prior array identity when nothing arrives, so React can skip re-render', () => {
    const prior = [makeMessage({ id: 'm1' })]
    expect(mergeSessionMessages(prior, [])).toBe(prior)
  })

  it('returns the prior array identity when incoming messages are unchanged', () => {
    const prior = [makeMessage({ id: 'm1', text: 'same' })]
    const incoming = [makeMessage({ id: 'm1', text: 'same', timestamp: prior[0].timestamp })]
    expect(mergeSessionMessages(prior, incoming)).toBe(prior)
  })

  it('replaces a message whose text changed', () => {
    const prior = [makeMessage({ id: 'm1', text: 'draft' })]
    const incoming = [makeMessage({ id: 'm1', text: 'final', timestamp: prior[0].timestamp })]
    const result = mergeSessionMessages(prior, incoming)
    expect(result).not.toBe(prior)
    expect(result[0].text).toBe('final')
  })

  it('detects a change that is only visible inside meta', () => {
    const prior = [makeMessage({ id: 'm1', kind: 'tool', meta: { status: 'running' } })]
    const incoming = [
      makeMessage({
        id: 'm1',
        kind: 'tool',
        meta: { status: 'completed' },
        timestamp: prior[0].timestamp,
      }),
    ]
    expect(mergeSessionMessages(prior, incoming)[0].meta?.status).toBe('completed')
  })

  it('appends messages it has not seen before', () => {
    const prior = [makeMessage({ id: 'm1' })]
    const result = mergeSessionMessages(prior, [makeMessage({ id: 'm2' })])
    expect(result.map((message) => message.id)).toEqual(['m1', 'm2'])
  })

  it('keeps untouched neighbours by identity when one message changes', () => {
    const prior = [makeMessage({ id: 'm1' }), makeMessage({ id: 'm2', text: 'old' })]
    const result = mergeSessionMessages(prior, [
      makeMessage({ id: 'm2', text: 'new', timestamp: prior[1].timestamp }),
    ])
    expect(result[0]).toBe(prior[0])
    expect(result[1].text).toBe('new')
  })

  it('notices a duration that arrived late', () => {
    const prior = [makeMessage({ id: 'm1', kind: 'turn_completed' })]
    const incoming = [
      makeMessage({
        id: 'm1',
        kind: 'turn_completed',
        duration_ms: 1200,
        timestamp: prior[0].timestamp,
      }),
    ]
    expect(mergeSessionMessages(prior, incoming)[0].duration_ms).toBe(1200)
  })
})

describe('transcriptTurnOpen', () => {
  it('reports open while activity follows the last completion', () => {
    const messages = [
      makeMessage({ kind: 'turn_completed' }),
      makeMessage({ kind: 'message', text: 'still going' }),
    ]
    expect(transcriptTurnOpen(messages, 'idle')).toBe(true)
  })

  it('reports closed once a completion is the last thing seen', () => {
    const messages = [
      makeMessage({ kind: 'message', text: 'hi' }),
      makeMessage({ kind: 'turn_completed' }),
    ]
    expect(transcriptTurnOpen(messages, 'idle')).toBe(false)
  })

  it('trusts a running session when the transcript has no completion yet', () => {
    expect(transcriptTurnOpen([], 'running')).toBe(true)
  })

  it('reports closed for an empty transcript on an idle session', () => {
    expect(transcriptTurnOpen([], 'idle')).toBe(false)
  })

  it('reports open for activity with no completion at all', () => {
    expect(transcriptTurnOpen([makeMessage({ kind: 'message' })], 'idle')).toBe(true)
  })
})
