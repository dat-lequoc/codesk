import { useEffect, useLayoutEffect, useRef } from 'react'

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
export function useThreadScroll(key: string, contentKey: string) {
  const scroll = useRef<HTMLDivElement>(null)
  const following = useRef(recallThreadScroll(key)?.following !== false)
  const restoring = useRef(true)

  useLayoutEffect(() => {
    following.current = recallThreadScroll(key)?.following !== false
    const element = scroll.current
    if (!element) return
    restoring.current = true
    applyPosition(element, key)
    requestAnimationFrame(() => {
      restoring.current = false
    })
  }, [key, contentKey])

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
      requestAnimationFrame(() => {
        restoring.current = false
      })
    })
    for (const child of element.children) observer.observe(child)
    return () => observer.disconnect()
  }, [key, contentKey])

  const onScroll = () => {
    const element = scroll.current
    if (!element || restoring.current) return
    following.current = atBottom(element)
    rememberThreadScroll(key, { following: following.current, top: element.scrollTop })
  }

  const saved = recallThreadScroll(key)
  const startAtEnd = !saved || saved.following
  return { scroll, following, onScroll, startAtEnd, savedTop: saved?.top ?? 0 }
}
