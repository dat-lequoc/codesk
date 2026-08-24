import { describe, expect, it } from 'vitest'

import {
  recallThreadScroll,
  rememberThreadScroll,
  resetThreadScrollCache,
  threadScrollStorageKey,
} from './thread-scroll'

describe('thread scroll cache', () => {
  it('round-trips a position', () => {
    rememberThreadScroll('session:a', { following: false, top: 420 })
    expect(recallThreadScroll('session:a')).toEqual({ following: false, top: 420 })
  })

  it('keeps conversations independent', () => {
    rememberThreadScroll('session:a', { following: false, top: 10 })
    rememberThreadScroll('session:b', { following: true, top: 800 })
    expect(recallThreadScroll('session:a')?.top).toBe(10)
    expect(recallThreadScroll('session:b')?.following).toBe(true)
  })

  it('clamps a negative offset', () => {
    rememberThreadScroll('session:a', { following: false, top: -40 })
    expect(recallThreadScroll('session:a')?.top).toBe(0)
  })

  it('returns nothing for a thread that was never visited', () => {
    expect(recallThreadScroll('missing')).toBeUndefined()
  })

  it('survives a reload from localStorage', () => {
    rememberThreadScroll('session:a', { following: false, top: 90 })
    resetThreadScrollCache()
    expect(recallThreadScroll('session:a')).toEqual({ following: false, top: 90 })
    expect(localStorage.getItem(threadScrollStorageKey)).toContain('session:a')
  })

  it('ignores a malformed store rather than throwing during render', () => {
    localStorage.setItem(threadScrollStorageKey, 'not json{')
    resetThreadScrollCache()
    expect(recallThreadScroll('session:a')).toBeUndefined()
  })

  it('drops the oldest entry once the cache is full', () => {
    for (let index = 0; index < 81; index++)
      rememberThreadScroll(`session:${index}`, { following: false, top: index })
    expect(recallThreadScroll('session:0')).toBeUndefined()
    expect(recallThreadScroll('session:80')?.top).toBe(80)
  })
})
