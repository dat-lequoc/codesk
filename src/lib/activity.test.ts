import { beforeEach, describe, expect, it } from 'vitest'

import { makeEvent, makeMessage, makeRun, resetIds } from '../test/factories'
import {
  activityCommandValue,
  activityFileSummary,
  activityRowLabel,
  activityStatus,
  activityText,
  changePath,
  compactActivityValue,
  diffCounts,
  historicalActivityEntry,
  historicalActivityItems,
  historicalActivityKinds,
  isActivityEvent,
  isActivityGroup,
  isWrappedExecEntry,
  liveActivityEntry,
  liveActivityItems,
  mergeActivityEntries,
  normalizeHistoricalActivityMessages,
  timelineItems,
  turnDurations,
  wrappedExecCommand,
  type ActivityEntry,
} from './activity'

beforeEach(resetIds)

const entry = (overrides: Partial<ActivityEntry> = {}): ActivityEntry => ({
  id: 'entry-1',
  type: 'tool',
  label: 'Tool',
  status: 'completed',
  changes: [],
  timestamp: new Date(1_700_000_000_000).toISOString(),
  raw: null,
  ...overrides,
})

describe('diffCounts', () => {
  it('counts added and removed lines', () => {
    expect(diffCounts('+one\n+two\n-three')).toEqual({ additions: 2, deletions: 1 })
  })

  it('ignores the +++/--- file headers of a unified diff', () => {
    const diff = ['--- a/file.ts', '+++ b/file.ts', '@@ -1 +1 @@', '-old', '+new'].join('\n')
    expect(diffCounts(diff)).toEqual({ additions: 1, deletions: 1 })
  })

  it('returns zeroes for an empty or absent diff', () => {
    expect(diffCounts()).toEqual({ additions: 0, deletions: 0 })
    expect(diffCounts('')).toEqual({ additions: 0, deletions: 0 })
  })

  it('ignores context lines', () => {
    expect(diffCounts(' unchanged\n+added')).toEqual({ additions: 1, deletions: 0 })
  })
})

describe('changePath', () => {
  const run = makeRun({ cwd: '/home/dev/codesk' })

  it('leaves an absolute path alone', () => {
    expect(changePath(run, '/etc/hosts')).toBe('/etc/hosts')
  })

  it('resolves a relative path against the run cwd', () => {
    expect(changePath(run, 'src/App.tsx')).toBe('/home/dev/codesk/src/App.tsx')
  })

  it('does not double the separator when cwd has a trailing slash', () => {
    expect(changePath(makeRun({ cwd: '/home/dev/codesk/' }), 'a.ts')).toBe('/home/dev/codesk/a.ts')
  })

  it('returns the bare cwd for an empty path', () => {
    expect(changePath(run)).toBe('/home/dev/codesk/')
  })
})

describe('activityText', () => {
  it('passes strings through unchanged', () => {
    expect(activityText('hello')).toBe('hello')
  })

  it('renders objects as indented JSON', () => {
    expect(activityText({ a: 1 })).toBe('{\n  "a": 1\n}')
  })

  it('returns empty string for nullish and empty input', () => {
    expect(activityText(undefined)).toBe('')
    expect(activityText(null)).toBe('')
    expect(activityText('')).toBe('')
  })

  it('falls back to String() when a value cannot be serialised', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(activityText(circular)).toBe('[object Object]')
  })

  it('preserves falsy-but-real values', () => {
    expect(activityText(0)).toBe('0')
    expect(activityText(false)).toBe('false')
  })
})

describe('compactActivityValue', () => {
  it('collapses runs of whitespace onto one line', () => {
    expect(compactActivityValue('a\n\n   b')).toBe('a b')
  })

  it('truncates past the limit with an ellipsis', () => {
    const result = compactActivityValue('x'.repeat(200), 10)
    expect(result).toHaveLength(10)
    expect(result.endsWith('…')).toBe(true)
  })

  it('leaves text at exactly the limit intact', () => {
    expect(compactActivityValue('x'.repeat(10), 10)).toBe('x'.repeat(10))
  })

  it('returns empty string for nullish input', () => {
    expect(compactActivityValue(null)).toBe('')
  })
})

describe('wrappedExecCommand', () => {
  it('unwraps a double-quoted command and prefixes the shell', () => {
    expect(wrappedExecCommand('tools.exec_command({ cmd: "ls -la" })')).toBe('/bin/zsh -lc ls -la')
  })

  it('unwraps a single-quoted command', () => {
    expect(wrappedExecCommand("tools.exec_command({ cmd: 'git status' })")).toBe(
      '/bin/zsh -lc git status',
    )
  })

  it('unwraps a backtick-quoted command', () => {
    expect(wrappedExecCommand('tools.exec_command({ cmd: `npm test` })')).toBe(
      '/bin/zsh -lc npm test',
    )
  })

  it('decodes escapes inside a double-quoted literal', () => {
    expect(wrappedExecCommand(String.raw`tools.exec_command({ cmd: "echo \"hi\"" })`)).toBe(
      '/bin/zsh -lc echo "hi"',
    )
  })

  it('does not double the shell prefix when it is already present', () => {
    expect(wrappedExecCommand('tools.exec_command({ cmd: "/bin/zsh -lc ls" })')).toBe(
      '/bin/zsh -lc ls',
    )
  })

  it('returns empty string for anything that is not a wrapped exec', () => {
    expect(wrappedExecCommand('ls -la')).toBe('')
    expect(wrappedExecCommand(42)).toBe('')
    expect(wrappedExecCommand(null)).toBe('')
    expect(wrappedExecCommand('tools.exec_command({ notcmd: "x" })')).toBe('')
  })
})

describe('activityCommandValue', () => {
  it('prefers command, then cmd, then argv, then args, then path', () => {
    expect(activityCommandValue({ command: 'a', cmd: 'b' })).toBe('a')
    expect(activityCommandValue({ cmd: 'b', argv: 'c' })).toBe('b')
    expect(activityCommandValue({ argv: 'c', args: 'd' })).toBe('c')
    expect(activityCommandValue({ args: 'd', path: 'e' })).toBe('d')
    expect(activityCommandValue({ path: 'e' })).toBe('e')
    expect(activityCommandValue({ paths: ['f'] })).toEqual(['f'])
  })

  it('returns non-object input unchanged', () => {
    expect(activityCommandValue('plain')).toBe('plain')
    expect(activityCommandValue(['a'])).toEqual(['a'])
    expect(activityCommandValue(null)).toBeNull()
  })
})

describe('activityStatus', () => {
  it('maps provider status strings onto the three ledger states', () => {
    for (const value of ['failed', 'error', 'errored', 'cancelled'])
      expect(activityStatus(value)).toBe('failed')
    for (const value of ['in_progress', 'running', 'pending', 'started'])
      expect(activityStatus(value)).toBe('running')
    expect(activityStatus('completed')).toBe('completed')
  })

  it('is case-insensitive', () => {
    expect(activityStatus('FAILED')).toBe('failed')
    expect(activityStatus('In_Progress')).toBe('running')
  })

  it('lets an explicit failure flag override the reported status', () => {
    expect(activityStatus('running', true)).toBe('failed')
  })

  it('defaults an unknown or missing status to completed', () => {
    expect(activityStatus(undefined)).toBe('completed')
    expect(activityStatus('something-new')).toBe('completed')
  })
})

describe('activityFileSummary', () => {
  it('lists up to three paths and counts the rest', () => {
    const summary = activityFileSummary(
      entry({
        type: 'files',
        changes: ['a', 'b', 'c', 'd', 'e'].map((path) => ({ path })),
      }),
    )
    expect(summary).toContain('a · b · c')
    expect(summary).toContain('+2 more')
  })

  it('totals additions and deletions across every change', () => {
    const summary = activityFileSummary(
      entry({
        type: 'files',
        changes: [
          { path: 'a', diff: '+1\n+2' },
          { path: 'b', diff: '-1' },
        ],
      }),
    )
    expect(summary).toContain('+2 -1')
  })

  it('omits a count that is zero', () => {
    const summary = activityFileSummary(
      entry({ type: 'files', changes: [{ path: 'a', diff: '+1' }] }),
    )
    expect(summary).toContain('+1')
    expect(summary).not.toContain('-0')
  })

  it('describes pathless changes by count', () => {
    expect(activityFileSummary(entry({ type: 'files', changes: [{}, {}] }))).toContain(
      '2 changed paths',
    )
  })

  it('returns empty string for a tool entry', () => {
    expect(activityFileSummary(entry({ type: 'tool' }))).toBe('')
  })
})

describe('activityRowLabel', () => {
  it('combines label and file summary for a files entry', () => {
    const label = activityRowLabel(
      entry({ type: 'files', label: 'Edited', changes: [{ path: 'a.ts' }] }),
    )
    expect(label).toBe('Edited · a.ts')
  })

  it('prefers an unwrapped exec command over the raw label', () => {
    const label = activityRowLabel(
      entry({ label: 'shell', input: 'tools.exec_command({ cmd: "ls" })' }),
    )
    expect(label).toBe('/bin/zsh -lc ls')
  })

  it('falls back to the command field of a structured input', () => {
    expect(activityRowLabel(entry({ label: 'shell', input: { command: 'git log' } }))).toBe(
      'git log',
    )
  })

  it('falls back to the label when there is no usable input', () => {
    expect(activityRowLabel(entry({ label: 'Read file' }))).toBe('Read file')
  })

  it('falls back to a generic label when nothing is available', () => {
    expect(activityRowLabel(entry({ label: '' }))).toBe('Tool activity')
  })
})

describe('mergeActivityEntries', () => {
  it('lets the newer entry supply status and output', () => {
    const merged = mergeActivityEntries(
      entry({ status: 'running', output: undefined }),
      entry({ status: 'completed', output: 'done' }),
    )
    expect(merged.status).toBe('completed')
    expect(merged.output).toBe('done')
  })

  it('keeps the earlier input when the newer entry has none', () => {
    const merged = mergeActivityEntries(entry({ input: 'original' }), entry({ input: undefined }))
    expect(merged.input).toBe('original')
  })

  it('keeps the earlier changes when the newer entry reports none', () => {
    const merged = mergeActivityEntries(
      entry({ changes: [{ path: 'a.ts' }] }),
      entry({ changes: [] }),
    )
    expect(merged.changes).toEqual([{ path: 'a.ts' }])
  })
})

describe('isWrappedExecEntry', () => {
  it('recognises an entry whose input is a wrapped exec call', () => {
    expect(isWrappedExecEntry(entry({ input: 'tools.exec_command({ cmd: "ls" })' }))).toBe(true)
  })

  it('rejects an ordinary entry', () => {
    expect(isWrappedExecEntry(entry({ input: 'ls' }))).toBe(false)
  })
})

describe('isActivityEvent / isActivityGroup', () => {
  it('classifies reasoning, tool output and file changes as activity', () => {
    for (const kind of ['reasoning.message', 'tool.output', 'file.change'])
      expect(isActivityEvent(makeEvent({ kind }))).toBe(true)
  })

  it('does not classify a tool call as activity — only its output is grouped', () => {
    expect(isActivityEvent(makeEvent({ kind: 'tool.call' }))).toBe(false)
  })

  it('does not classify an assistant message as activity', () => {
    expect(isActivityEvent(makeEvent({ kind: 'assistant.message' }))).toBe(false)
  })

  it('distinguishes a group from a bare event', () => {
    expect(isActivityGroup({ type: 'activity', id: 'g', events: [] })).toBe(true)
    expect(isActivityGroup(makeEvent())).toBe(false)
  })
})

describe('timelineItems', () => {
  it('collects consecutive activity events into one group', () => {
    const items = timelineItems([
      makeEvent({ kind: 'reasoning.message' }),
      makeEvent({ kind: 'tool.output' }),
    ])
    expect(items).toHaveLength(1)
    expect(isActivityGroup(items[0])).toBe(true)
  })

  it('breaks a group when a message interrupts the run of activity', () => {
    const items = timelineItems([
      makeEvent({ kind: 'tool.output' }),
      makeEvent({ kind: 'assistant.message' }),
      makeEvent({ kind: 'tool.output' }),
    ])
    expect(items.map(isActivityGroup)).toEqual([true, false, true])
  })

  it('passes a message-only stream through untouched', () => {
    const items = timelineItems([makeEvent({ kind: 'assistant.message' })])
    expect(items).toHaveLength(1)
    expect(isActivityGroup(items[0])).toBe(false)
  })

  it('returns nothing for an empty stream', () => {
    expect(timelineItems([])).toEqual([])
  })
})

describe('turnDurations', () => {
  // The map is keyed by the completion event's id, not the turn id, because
  // RunScreen looks it up as `durations.get(item.event_id)` while rendering.
  it('measures each turn from start to completion, keyed by the completion event', () => {
    const durations = turnDurations([
      makeEvent({
        kind: 'turn.started',
        payload: { turn_id: 't1' },
        timestamp: '2026-01-01T00:00:00.000Z',
      }),
      makeEvent({
        event_id: 'completion',
        kind: 'turn.completed',
        payload: { turn_id: 't1' },
        timestamp: '2026-01-01T00:00:05.000Z',
      }),
    ])
    expect(durations.get('completion')).toBe(5000)
  })

  it('records nothing for a turn that has not completed', () => {
    expect(
      turnDurations([makeEvent({ kind: 'turn.started', payload: { turn_id: 't1' } })]).size,
    ).toBe(0)
  })

  it('ignores a completion whose start was never seen', () => {
    const durations = turnDurations([
      makeEvent({ event_id: 'c', kind: 'turn.completed', payload: { turn_id: 'unknown' } }),
    ])
    expect(durations.size).toBe(0)
  })

  it('ignores turn events that carry no turn id', () => {
    expect(turnDurations([makeEvent({ kind: 'turn.completed', payload: {} })]).size).toBe(0)
  })

  it('handles several turns independently', () => {
    const durations = turnDurations([
      makeEvent({
        kind: 'turn.started',
        payload: { turn_id: 't1' },
        timestamp: '2026-01-01T00:00:00.000Z',
      }),
      makeEvent({
        event_id: 'c1',
        kind: 'turn.completed',
        payload: { turn_id: 't1' },
        timestamp: '2026-01-01T00:00:01.000Z',
      }),
      makeEvent({
        kind: 'turn.started',
        payload: { turn_id: 't2' },
        timestamp: '2026-01-01T00:00:02.000Z',
      }),
      makeEvent({
        event_id: 'c2',
        kind: 'turn.completed',
        payload: { turn_id: 't2' },
        timestamp: '2026-01-01T00:00:04.000Z',
      }),
    ])
    expect(durations.get('c1')).toBe(1000)
    expect(durations.get('c2')).toBe(2000)
  })
})

describe('liveActivityEntry', () => {
  it('ignores reasoning, which the ledger renders separately', () => {
    expect(liveActivityEntry(makeEvent({ kind: 'reasoning.message' }))).toBeNull()
  })

  it('builds a files entry from a file.change event', () => {
    const result = liveActivityEntry(
      makeEvent({ kind: 'file.change', payload: { changes: [{ path: 'a.ts', diff: '+1' }] } }),
    )
    expect(result?.type).toBe('files')
    expect(result?.changes).toEqual([{ path: 'a.ts', diff: '+1' }])
  })

  it('marks a stderr tool event as failed', () => {
    const result = liveActivityEntry(
      makeEvent({ kind: 'tool.output', channel: 'stderr', payload: { tool_title: 'build' } }),
    )
    expect(result?.status).toBe('failed')
  })
})

describe('liveActivityItems', () => {
  it('emits reasoning as its own ledger item', () => {
    const items = liveActivityItems([
      makeEvent({ kind: 'reasoning.message', payload: { text: 'thinking' } }),
    ])
    expect(items[0]).toMatchObject({ type: 'reasoning', text: 'thinking' })
  })

  it('drops reasoning that carries no text', () => {
    expect(liveActivityItems([makeEvent({ kind: 'reasoning.message', payload: {} })])).toEqual([])
  })

  it('returns nothing for an empty stream', () => {
    expect(liveActivityItems([])).toEqual([])
  })
})

describe('historicalActivityEntry', () => {
  it('builds a files entry from a file_change message', () => {
    const result = historicalActivityEntry(
      makeMessage({ kind: 'file_change', meta: { changes: [{ path: 'a.ts' }] } }),
    )
    expect(result.type).toBe('files')
    expect(result.changes).toEqual([{ path: 'a.ts' }])
  })

  it('carries the reported tool status through', () => {
    const result = historicalActivityEntry(
      makeMessage({ kind: 'tool', meta: { tool: 'bash', status: 'failed' } }),
    )
    expect(result.type).toBe('tool')
    expect(result.status).toBe('failed')
  })
})

describe('historicalActivityItems', () => {
  it('turns reasoning messages into reasoning items', () => {
    const items = historicalActivityItems([makeMessage({ kind: 'reasoning', text: 'because' })])
    expect(items[0]).toMatchObject({ type: 'reasoning', text: 'because' })
  })

  it('returns nothing for an empty transcript', () => {
    expect(historicalActivityItems([])).toEqual([])
  })
})

describe('normalizeHistoricalActivityMessages', () => {
  it('recognises exactly the kinds the ledger knows how to render', () => {
    expect([...historicalActivityKinds].sort()).toEqual([
      'file_change',
      'reasoning',
      'tool',
      'tool_output',
    ])
  })

  it('leaves plain messages in place', () => {
    const messages = [makeMessage({ kind: 'message', text: 'hi' })]
    expect(normalizeHistoricalActivityMessages(messages)).toHaveLength(1)
  })

  it('returns nothing for an empty transcript', () => {
    expect(normalizeHistoricalActivityMessages([])).toEqual([])
  })
})
