import { describe, expect, it } from 'vitest'

import { harnessOrder, providerName, providerRegistry, providerUi } from './providers'

describe('providerRegistry', () => {
  it('is sorted by the declared display order', () => {
    const orders = providerRegistry.map((provider) => provider.order)
    expect(orders).toEqual([...orders].sort((a, b) => a - b))
  })

  it('gives every provider a unique id', () => {
    const ids = providerRegistry.map((provider) => provider.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('gives every provider a name and short name', () => {
    for (const provider of providerRegistry) {
      expect(provider.name).toBeTruthy()
      expect(provider.shortName).toBeTruthy()
    }
  })

  it('declares a valid approval mode and active input for each provider', () => {
    for (const provider of providerRegistry) {
      expect(['native', 'acp']).toContain(provider.approvalMode)
      expect(['steer', 'queue']).toContain(provider.activeInput)
    }
  })
})

describe('providerUi', () => {
  it('resolves a known provider', () => {
    expect(providerUi('codex').name).toBe('Codex')
    expect(providerUi('claude').name).toBe('Claude Code')
  })

  // A daemon that reports a provider this build has never heard of must still
  // render a row rather than crashing the sidebar.
  it('falls back to a shell-shaped entry for an unknown provider', () => {
    const unknown = providerUi('brand-new-agent')
    expect(unknown.id).toBe('brand-new-agent')
    expect(unknown.name).toBe('brand-new-agent')
    expect(unknown.shortName).toBe('brand-new-agent')
  })

  it('keeps the shell defaults on that fallback', () => {
    const unknown = providerUi('brand-new-agent')
    expect(unknown.approvalMode).toBe(providerUi('shell').approvalMode)
    expect(unknown.activeInput).toBe(providerUi('shell').activeInput)
  })
})

describe('providerName', () => {
  it('returns the display name', () => {
    expect(providerName('agy')).toBe('Antigravity')
  })

  it('echoes an unknown id', () => {
    expect(providerName('nope')).toBe('nope')
  })
})

describe('harnessOrder', () => {
  it('lists selectable harnesses and excludes the shell escape hatch', () => {
    expect(harnessOrder).not.toContain('shell')
    expect(harnessOrder).toContain('codex')
  })

  it('follows the registry order', () => {
    const expected = providerRegistry
      .filter((provider) => provider.id !== 'shell')
      .map((provider) => provider.id)
    expect(harnessOrder).toEqual(expected)
  })
})
