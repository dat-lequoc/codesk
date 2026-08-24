import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  applyTheme,
  normalizeTheme,
  rememberTheme,
  resolvedTheme,
  storedTheme,
  themeStorageKey,
  watchSystemTheme,
} from './theme'

const mockMatchMedia = (matches: boolean) => {
  const listeners = new Set<() => void>()
  const media = {
    matches,
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  }
  vi.stubGlobal('matchMedia', () => media)
  return { media, listeners }
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.documentElement.classList.remove('light')
})

describe('theme', () => {
  it('normalizes unknown values to system', () => {
    expect(normalizeTheme('light')).toBe('light')
    expect(normalizeTheme('dark')).toBe('dark')
    expect(normalizeTheme('solarized')).toBe('system')
    expect(normalizeTheme(null)).toBe('system')
  })

  it('resolves system from the OS preference', () => {
    mockMatchMedia(true)
    expect(resolvedTheme('system')).toBe('light')
    mockMatchMedia(false)
    expect(resolvedTheme('system')).toBe('dark')
    expect(resolvedTheme('light')).toBe('light')
    expect(resolvedTheme('dark')).toBe('dark')
  })

  it('falls back to dark when matchMedia is unavailable', () => {
    expect(resolvedTheme('system')).toBe('dark')
  })

  it('toggles the light class on the document root', () => {
    applyTheme('light')
    expect(document.documentElement.classList.contains('light')).toBe(true)
    applyTheme('dark')
    expect(document.documentElement.classList.contains('light')).toBe(false)
  })

  it('remembers and restores the preference across launches', () => {
    rememberTheme('light')
    expect(storedTheme()).toBe('light')
    localStorage.setItem(themeStorageKey, 'garbage')
    expect(storedTheme()).toBe('system')
  })

  it('follows OS appearance changes while set to system', () => {
    const { media, listeners } = mockMatchMedia(false)
    const stop = watchSystemTheme('system')
    expect(listeners.size).toBe(1)
    media.matches = true
    for (const listener of listeners) listener()
    expect(document.documentElement.classList.contains('light')).toBe(true)
    stop()
    expect(listeners.size).toBe(0)
  })

  it('does not watch the OS while an explicit theme is set', () => {
    const { listeners } = mockMatchMedia(false)
    watchSystemTheme('dark')
    expect(listeners.size).toBe(0)
  })
})
