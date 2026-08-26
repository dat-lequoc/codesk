import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import { recallThreadScroll, rememberThreadScroll } from '../lib/thread-scroll'

const NEAR_BOTTOM_PX = 100

const atBottom = (element: HTMLElement) =>
  element.scrollHeight - element.scrollTop - element.clientHeight < NEAR_BOTTOM_PX

const applyPosition = (element: HTMLElement, key: string) => {
  const saved = recallThreadScroll(key)
  if (!saved || saved.following) element.scrollTop = element.scrollHeight
  else element.scrollTop = saved.top
}

/**
 * Remembers where a thread was scrolled and restores it when the screen
 * remounts. A first visit, or a visit that left the user pinned to the latest
 * turn, sticks to the bottom. Mid-thread reading comes back to that offset.
 *
 * While restoring, scroll events are ignored — content growing from the top
 * used to fire `onScroll` at offset 0 and flip "following" off, which is why
 * switching away and back landed on the first message.
 */
type ThreadScrollOptions = {
  /// False while the transcript is still loading, so an empty pane is not
  /// treated as "the user has read to the end".
  ready?: boolean
  /// Fires when the visible pane is at the latest turn — used to dismiss the
  /// just-finished marker once the user has actually checked the result.
  onAtEnd?: () => void
}

const hasLaidOut = (element: HTMLElement) => element.scrollHeight > 0 || element.clientHeight > 0

export function useThreadScroll(key: string, contentKey: string, options?: ThreadScrollOptions) {
  const scroll = useRef<HTMLDivElement>(null)
  const following = useRef(recallThreadScroll(key)?.following !== false)
  const restoring = useRef(true)
  const onAtEndRef = useRef(options?.onAtEnd)
  const readyRef = useRef(options?.ready !== false)
  const [isAtBottom, setIsAtBottom] = useState(true)
  const atBottomRef = useRef(true)
  const trackAtBottom = useCallback((value: boolean) => {
    if (atBottomRef.current === value) return
    atBottomRef.current = value
    setIsAtBottom(value)
  }, [])

  const notifyIfAtEnd = () => {
    const element = scroll.current
    const cb = onAtEndRef.current
    if (!element || !readyRef.current || !cb || !hasLaidOut(element)) return
    if (atBottom(element)) cb()
  }

  useLayoutEffect(() => {
    onAtEndRef.current = options?.onAtEnd
    readyRef.current = options?.ready !== false
  })

  useLayoutEffect(() => {
    following.current = recallThreadScroll(key)?.following !== false
    const element = scroll.current
    if (!element) return
    restoring.current = true
    applyPosition(element, key)
    trackAtBottom(atBottom(element))
    requestAnimationFrame(() => {
      restoring.current = false
      notifyIfAtEnd()
    })
  }, [key, contentKey, options?.ready, trackAtBottom])

  useLayoutEffect(() => {
    const element = scroll.current
    return () => {
      if (!element) return
      // Layout cleanup still has the node. useEffect cleanup runs after the
      // ref is cleared, which is why an earlier version never saved the
      // offset when switching conversations.
      rememberThreadScroll(key, { following: atBottom(element), top: element.scrollTop })
    }
  }, [key])

  useEffect(() => {
    const element = scroll.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (restoring.current || !following.current) return
      restoring.current = true
      element.scrollTop = element.scrollHeight
      trackAtBottom(true)
      requestAnimationFrame(() => {
        restoring.current = false
        notifyIfAtEnd()
      })
    })
    for (const child of element.children) observer.observe(child)
    return () => observer.disconnect()
  }, [key, contentKey, options?.ready, trackAtBottom])

  const onScroll = () => {
    const element = scroll.current
    if (!element || restoring.current) return
    const bot = atBottom(element)
    following.current = bot
    trackAtBottom(bot)
    rememberThreadScroll(key, { following: following.current, top: element.scrollTop })
    if (following.current) notifyIfAtEnd()
  }

  const scrollToBottom = useCallback(
    (smooth = true) => {
      const element = scroll.current
      if (!element) return
      if (smooth) {
        element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' })
      } else {
        element.scrollTop = element.scrollHeight
      }
      following.current = true
      trackAtBottom(true)
    },
    [trackAtBottom],
  )

  const adjustScrollTopBy = useCallback((delta: number) => {
    const element = scroll.current
    if (!element || delta <= 0) return
    element.scrollTop += delta
  }, [])

  const getScrollHeight = useCallback(() => scroll.current?.scrollHeight ?? 0, [])

  const saved = recallThreadScroll(key)
  const startAtEnd = !saved || saved.following
  return {
    scroll,
    following,
    onScroll,
    startAtEnd,
    savedTop: saved?.top ?? 0,
    isAtBottom,
    scrollToBottom,
    adjustScrollTopBy,
    getScrollHeight,
  }
}
