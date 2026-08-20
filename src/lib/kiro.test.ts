import { describe, expect, it } from 'vitest'

import {
  fallbackKiroCommands,
  kiroEffortLevels,
  kiroSlashSuggestions,
  kiroSuggestionLimit,
  type KiroCommandContext,
} from './kiro'

const context = (overrides: Partial<KiroCommandContext> = {}): KiroCommandContext => ({
  commands: fallbackKiroCommands,
  models: [],
  modelsPending: false,
  ...overrides,
})

const labels = (message: string, ctx = context()) =>
  kiroSlashSuggestions(message, ctx).map((suggestion) => suggestion.label)

describe('kiroSuggestionLimit', () => {
  it('shows a short list while the user is still naming the command', () => {
    expect(kiroSuggestionLimit('/mod')).toBe(8)
    expect(kiroSuggestionLimit('')).toBe(8)
  })

  it('shows a long list once an argument is being typed', () => {
    expect(kiroSuggestionLimit('/model ')).toBe(24)
    expect(kiroSuggestionLimit('/model gpt')).toBe(24)
  })

  it('ignores leading whitespace', () => {
    expect(kiroSuggestionLimit('  /model x')).toBe(24)
  })
})

describe('kiroSlashSuggestions — command names', () => {
  it('suggests nothing for ordinary prose', () => {
    expect(kiroSlashSuggestions('just a message', context())).toEqual([])
  })

  it('suggests nothing once the message spans lines', () => {
    expect(kiroSlashSuggestions('/model\nmore', context())).toEqual([])
  })

  it('lists every command for a bare slash', () => {
    expect(labels('/')).toEqual(fallbackKiroCommands.map((command) => command.name))
  })

  it('filters by prefix', () => {
    expect(labels('/mod')).toEqual(['/model'])
  })

  it('is case-insensitive', () => {
    expect(labels('/MOD')).toEqual(['/model'])
  })

  it('ranks the common commands first', () => {
    const ranked = labels('/')
    expect(ranked.slice(0, 4)).toEqual(['/usage', '/model', '/effort', '/compact'])
  })

  it('appends a space to commands that take an argument', () => {
    const suggestions = kiroSlashSuggestions('/', context())
    const byLabel = new Map(suggestions.map((s) => [s.label, s.value]))
    expect(byLabel.get('/model')).toBe('/model ')
    expect(byLabel.get('/effort')).toBe('/effort ')
    expect(byLabel.get('/usage')).toBe('/usage')
  })

  it('returns nothing for an unknown command prefix', () => {
    expect(labels('/zzz')).toEqual([])
  })

  it('tolerates leading whitespace', () => {
    expect(labels('   /mod')).toEqual(['/model'])
  })
})

describe('kiroSlashSuggestions — /model', () => {
  const models = [
    { id: 'kiro-fast', description: 'Fast responses' },
    { id: 'kiro-deep', description: 'Careful reasoning' },
  ]

  it('lists the available models', () => {
    expect(labels('/model ', context({ models }))).toEqual(['kiro-fast', 'kiro-deep'])
  })

  it('filters by id', () => {
    expect(labels('/model fast', context({ models }))).toEqual(['kiro-fast'])
  })

  it('filters by description too', () => {
    expect(labels('/model reasoning', context({ models }))).toEqual(['kiro-deep'])
  })

  it('marks the model currently in use', () => {
    const [first] = kiroSlashSuggestions('/model ', context({ models, currentModel: 'kiro-fast' }))
    expect(first.detail).toBe('Current model')
  })

  it('shows a loading row while the harness is still reporting its models', () => {
    const suggestions = kiroSlashSuggestions('/model ', context({ modelsPending: true }))
    expect(suggestions).toHaveLength(1)
    expect(suggestions[0].detail).toBe('Loading')
  })

  it('shows nothing when the model list is genuinely empty', () => {
    expect(kiroSlashSuggestions('/model ', context({ modelsPending: false }))).toEqual([])
  })

  it('returns nothing when the filter matches no model', () => {
    expect(labels('/model nope', context({ models }))).toEqual([])
  })
})

describe('kiroSlashSuggestions — /effort', () => {
  it('lists every effort level', () => {
    expect(labels('/effort ')).toEqual(kiroEffortLevels)
  })

  it('filters by prefix', () => {
    expect(labels('/effort h')).toEqual(['high'])
  })

  it('marks the effort currently in use', () => {
    const [first] = kiroSlashSuggestions('/effort h', context({ currentEffort: 'high' }))
    expect(first.detail).toBe('Current effort')
  })

  it('produces a value that replaces the whole input', () => {
    const [first] = kiroSlashSuggestions('/effort h', context())
    expect(first.value).toBe('/effort high')
  })

  it('returns nothing for an unknown level', () => {
    expect(labels('/effort zzz')).toEqual([])
  })
})

describe('kiroSlashSuggestions — commands without arguments', () => {
  it('offers nothing further once a no-argument command is complete', () => {
    expect(kiroSlashSuggestions('/usage ', context())).toEqual([])
  })
})
