import { useEffect, useRef } from 'react'

/**
 * A ref that always holds the most recent value, written after commit.
 *
 * Two uses in this app, both of which were previously served by assigning to a
 * ref during render — which React forbids, because a render can be thrown away
 * or replayed and the write would leak from an abandoned attempt:
 *
 *  - giving long-lived callbacks (WebSocket handlers, window listeners) access
 *    to current state without re-subscribing on every change;
 *  - letting an effect read a value it deliberately does not want in its
 *    dependency list, so it does not re-run when only that value changed.
 *
 * Only read `.current` from callbacks and effects. During render it may lag by
 * one commit, which is precisely the case the render-phase write was hiding.
 */
export function useLatest<T>(value: T) {
  const ref = useRef(value)
  useEffect(() => {
    ref.current = value
  }, [value])
  return ref
}
