import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { mergeSessionMessages } from '../lib/events'
import type { Host, Provider, ProviderSession, SessionMessage } from '../types'

/**
 * Polls the provider transcript for the selected session, backing off while
 * the session is idle and resetting to a fast cadence whenever it is running
 * or new messages arrive.
 */
export function useSessionMessagesPoller({
  selectedSessionKey,
  sessionHostId,
  sessionProjectId,
  sessionProviderId,
  sessionNativeId,
  sessionStatus,
  sessionHostStatus,
  setError,
}: {
  selectedSessionKey: string | null
  sessionHostId: string | undefined
  sessionProjectId: string | undefined
  sessionProviderId: Provider['id'] | undefined
  sessionNativeId: string | undefined
  sessionStatus: ProviderSession['status'] | undefined
  sessionHostStatus: Host['status'] | undefined
  setError: (message: string) => void
}) {
  const [sessionMessages, setSessionMessages] = useState<Record<string, SessionMessage[]>>({})
  const sessionMessagesRef = useRef<Record<string, SessionMessage[]>>({})
  useEffect(() => {
    if (
      !selectedSessionKey ||
      !sessionHostId ||
      sessionProjectId === undefined ||
      !sessionProviderId ||
      !sessionNativeId ||
      sessionHostStatus !== 'online'
    )
      return
    let stopped = false
    let timer = 0
    let idleDelay = 2000
    const load = async () => {
      const prior = sessionMessagesRef.current[selectedSessionKey] || []
      const after = [...prior].reverse().find((item) => item.timestamp)?.timestamp
      try {
        const incoming = await api.sessionMessages(
          sessionHostId,
          sessionProjectId,
          sessionProviderId,
          sessionNativeId,
          after,
        )
        if (stopped) return false
        setSessionMessages((current) => {
          const existing = current[selectedSessionKey]
          // Record even an empty first result: the key existing is how the
          // screen tells "loaded and genuinely empty" apart from "still
          // loading", which used to spin forever on empty conversations.
          if (!existing) {
            const updated = { ...current, [selectedSessionKey]: mergeSessionMessages([], incoming) }
            sessionMessagesRef.current = updated
            return updated
          }
          if (!incoming.length) return current
          const next = mergeSessionMessages(existing, incoming)
          if (next === existing) return current
          const updated = { ...current, [selectedSessionKey]: next }
          sessionMessagesRef.current = updated
          return updated
        })
        return incoming.length > 0
      } catch (cause) {
        if (!stopped) setError(cause instanceof Error ? cause.message : String(cause))
        return false
      }
    }
    const poll = async () => {
      if (stopped || document.hidden) return
      const changed = await load()
      if (stopped || document.hidden) return
      if (sessionStatus === 'running' || changed) idleDelay = 2000
      else idleDelay = Math.min(15_000, idleDelay * 2)
      timer = window.setTimeout(poll, sessionStatus === 'running' ? 2000 : idleDelay)
    }
    const visibility = () => {
      clearTimeout(timer)
      if (!document.hidden) {
        idleDelay = 2000
        void poll()
      }
    }
    document.addEventListener('visibilitychange', visibility)
    void poll()
    return () => {
      stopped = true
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [
    selectedSessionKey,
    sessionHostId,
    sessionProjectId,
    sessionProviderId,
    sessionNativeId,
    sessionStatus,
    sessionHostStatus,
    setError,
  ])
  return { sessionMessages }
}
