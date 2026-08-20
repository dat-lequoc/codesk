import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { makeDraft, resetIds } from '../test/factories'
import { conversationText, draftTitle, durationLabel, pathLike, relative } from './format'

beforeEach(resetIds)

describe('relative', () => {
  const now = new Date('2026-01-01T12:00:00.000Z')
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString()

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
  })
  afterEach(() => vi.useRealTimers())

  it('says "now" for anything under a minute', () => {
    expect(relative(ago(0))).toBe('now')
    expect(relative(ago(59_000))).toBe('now')
  })

  it('switches to minutes at one minute', () => {
    expect(relative(ago(60_000))).toBe('1m')
    expect(relative(ago(59 * 60_000))).toBe('59m')
  })

  it('switches to hours at one hour', () => {
    expect(relative(ago(3_600_000))).toBe('1h')
    expect(relative(ago(25 * 3_600_000))).toBe('25h')
  })

  it('returns empty string for nullish input', () => {
    expect(relative(undefined)).toBe('')
    expect(relative(null)).toBe('')
    expect(relative('')).toBe('')
  })

  it('does not go negative for a timestamp in the future', () => {
    expect(relative(new Date(now.getTime() + 60_000).toISOString())).toBe('now')
  })
})

describe('draftTitle', () => {
  it('uses the prompt as the title', () => {
    expect(draftTitle(makeDraft({ prompt: 'Add a button' }))).toBe('Add a button')
  })

  it('collapses whitespace so multi-line prompts fit on one row', () => {
    expect(draftTitle(makeDraft({ prompt: 'line one\n\n  line two' }))).toBe('line one line two')
  })

  it('truncates a long prompt with an ellipsis', () => {
    const title = draftTitle(makeDraft({ prompt: 'x'.repeat(100) }))
    expect(title).toHaveLength(46)
    expect(title.endsWith('…')).toBe(true)
  })

  it('leaves a prompt at the boundary untouched', () => {
    expect(draftTitle(makeDraft({ prompt: 'x'.repeat(46) }))).toBe('x'.repeat(46))
  })

  it('returns empty string for a draft with no prompt', () => {
    expect(draftTitle(makeDraft({ prompt: undefined }))).toBe('')
    expect(draftTitle(makeDraft({ prompt: '   ' }))).toBe('')
  })
})

describe('pathLike', () => {
  it('recognises absolute, home-relative and nested paths', () => {
    expect(pathLike('/home/dev')).toBe(true)
    expect(pathLike('~/projects')).toBe(true)
    expect(pathLike('src/App.tsx')).toBe(true)
  })

  it('rejects a bare search term', () => {
    expect(pathLike('codesk')).toBe(false)
    expect(pathLike('')).toBe(false)
  })

  it('ignores surrounding whitespace', () => {
    expect(pathLike('  /home/dev  ')).toBe(true)
  })
})

describe('conversationText', () => {
  it('strips an environment_context block and reports that it was there', () => {
    const result = conversationText('<environment_context>cwd=/tmp</environment_context>Hello')
    expect(result.text).toBe('Hello')
    expect(result.hadContext).toBe(true)
  })

  it('handles a context tag that carries attributes', () => {
    const result = conversationText('<environment_context id="1">x</environment_context>Hi')
    expect(result.text).toBe('Hi')
    expect(result.hadContext).toBe(true)
  })

  it('strips several context blocks', () => {
    const result = conversationText(
      '<environment_context>a</environment_context>mid<environment_context>b</environment_context>',
    )
    expect(result.text).toBe('mid')
  })

  it('reports no context for ordinary text', () => {
    expect(conversationText('Just a message')).toEqual({
      text: 'Just a message',
      hadContext: false,
    })
  })

  it('is repeatable — the shared regex does not carry lastIndex between calls', () => {
    const input = '<environment_context>a</environment_context>Hello'
    expect(conversationText(input)).toEqual(conversationText(input))
    expect(conversationText(input)).toEqual(conversationText(input))
  })

  it('yields empty text when the message is only context', () => {
    const result = conversationText('<environment_context>only</environment_context>')
    expect(result.text).toBe('')
    expect(result.hadContext).toBe(true)
  })
})

describe('durationLabel', () => {
  it('renders sub-minute durations in seconds', () => {
    expect(durationLabel(0)).toBe('0s')
    expect(durationLabel(5_000)).toBe('5s')
    expect(durationLabel(59_000)).toBe('59s')
  })

  it('renders whole minutes without a seconds part', () => {
    expect(durationLabel(60_000)).toBe('1m')
    expect(durationLabel(120_000)).toBe('2m')
  })

  it('renders minutes and seconds together', () => {
    expect(durationLabel(90_000)).toBe('1m 30s')
  })

  it('rounds to the nearest second', () => {
    expect(durationLabel(1_600)).toBe('2s')
  })

  it('clamps a negative duration to zero rather than showing "-3s"', () => {
    expect(durationLabel(-3_000)).toBe('0s')
  })
})
