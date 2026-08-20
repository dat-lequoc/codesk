import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { useLatest } from './useLatest'

describe('useLatest', () => {
  it('exposes the initial value after mount', () => {
    const { result } = renderHook(() => useLatest('first'))
    expect(result.current.current).toBe('first')
  })

  it('tracks the newest value across re-renders', () => {
    const { result, rerender } = renderHook(({ value }) => useLatest(value), {
      initialProps: { value: 1 },
    })
    rerender({ value: 2 })
    expect(result.current.current).toBe(2)
    rerender({ value: 3 })
    expect(result.current.current).toBe(3)
  })

  it('keeps a stable ref object, so callbacks can close over it once', () => {
    const { result, rerender } = renderHook(({ value }) => useLatest(value), {
      initialProps: { value: 1 },
    })
    const first = result.current
    rerender({ value: 2 })
    expect(result.current).toBe(first)
  })

  // The whole point: a callback captured once still sees current state.
  it('lets a callback captured at mount read a later value', () => {
    let read = () => 0
    const { rerender } = renderHook(
      ({ value }) => {
        const ref = useLatest(value)
        read = () => ref.current
        return null
      },
      { initialProps: { value: 1 } },
    )
    const captured = read
    rerender({ value: 42 })
    expect(captured()).toBe(42)
  })

  it('handles objects and null', () => {
    const a = { id: 'a' }
    const { result, rerender } = renderHook(({ value }) => useLatest(value), {
      initialProps: { value: a as { id: string } | null },
    })
    expect(result.current.current).toBe(a)
    act(() => rerender({ value: null }))
    expect(result.current.current).toBeNull()
  })
})
