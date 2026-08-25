import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { mergeSessionMessages } from '../lib/events'
import type { Host, Provider, ProviderSession, SessionMessage } from '../types'

const PAGE_SIZE = 100

/**
 * Polls the provider transcript for the selected session with tail-paged loading:
 * loads the latest 100 messages instantly, supports loading earlier history,
 * and polls for new incoming messages.
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
  const [hasEarlierBySession, setHasEarlierBySession] = useState<Record<string, boolean>>({})
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const sessionMessagesRef = useRef<Record<string, SessionMessage[]>>({})

  const loadEarlier = useCallback(async () => {
    if (
      !selectedSessionKey ||
      !sessionHostId ||
      sessionProjectId === undefined ||
      !sessionProviderId ||
      !sessionNativeId ||
      loadingEarlier
    )
      return
    const current = sessionMessagesRef.current[selectedSessionKey] || []
    const oldestTimestamp = current.find((item) => item.timestamp)?.timestamp
    if (!oldestTimestamp) return
    setLoadingEarlier(true)
    try {
      const incoming = await api.sessionMessages(
        sessionHostId,
        sessionProjectId,
        sessionProviderId,
        sessionNativeId,
        undefined,
        oldestTimestamp,
        PAGE_SIZE,
      )
      setHasEarlierBySession((prev) => ({
        ...prev,
        [selectedSessionKey]: incoming.length >= PAGE_SIZE,
      }))
      if (incoming.length > 0) {
        setSessionMessages((prev) => {
          const existing = prev[selectedSessionKey] || []
          const next = mergeSessionMessages(incoming, existing)
          sessionMessagesRef.current = { ...prev, [selectedSessionKey]: next }
          return { ...prev, [selectedSessionKey]: next }
        })
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoadingEarlier(false)
    }
  }, [
    loadingEarlier,
    selectedSessionKey,
    sessionHostId,
    sessionNativeId,
    sessionProjectId,
    sessionProviderId,
    setError,
  ])

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
      const isInitial = prior.length === 0
      const after = isInitial
        ? undefined
        : [...prior].reverse().find((item) => item.timestamp)?.timestamp
      try {
        const incoming = await api.sessionMessages(
          sessionHostId,
          sessionProjectId,
          sessionProviderId,
          sessionNativeId,
          after,
          undefined,
          isInitial ? PAGE_SIZE : undefined,
        )
        if (stopped) return false
        setSessionMessages((current) => {
          const existing = current[selectedSessionKey]
          if (!existing) {
            const updated = { ...current, [selectedSessionKey]: mergeSessionMessages([], incoming) }
            sessionMessagesRef.current = updated
            setHasEarlierBySession((prev) => ({
              ...prev,
              [selectedSessionKey]: incoming.length >= PAGE_SIZE,
            }))
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

  return {
    sessionMessages,
    hasEarlier: selectedSessionKey ? hasEarlierBySession[selectedSessionKey] === true : false,
    loadingEarlier,
    loadEarlier,
  }
}
