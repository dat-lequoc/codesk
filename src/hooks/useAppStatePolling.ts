import { useCallback, useEffect, useRef } from 'react'
import type { Dispatch, RefObject, SetStateAction } from 'react'
import { api } from '../api'
import { normalizeState } from '../lib/app-state'
import { sessionKey } from '../lib/keys'
import type { AppState, ProviderSession, Run } from '../types'

/**
 * Keeps the app snapshot fresh: `reload` fetches and reconciles a new
 * snapshot, the navigation bootstrap paints the sidebar from the cheap
 * navigation payload before the first full snapshot lands, and a 15s
 * visibility-aware poll covers hosts whose events do not reach the socket.
 */
export function useAppStatePolling({
  setState,
  setExtraSessions,
  setError,
  reconcileUnread,
  noticeStatusChanges,
  initializeSelection,
  initialized,
  selectedRunRef,
}: {
  setState: Dispatch<SetStateAction<AppState>>
  setExtraSessions: Dispatch<SetStateAction<Record<string, ProviderSession[]>>>
  setError: (message: string) => void
  reconcileUnread: (snapshot: AppState) => void
  noticeStatusChanges: (next: AppState) => void
  initializeSelection: (next: AppState) => void
  initialized: RefObject<boolean>
  selectedRunRef: RefObject<Run | null>
}) {
  const lastSnapshotSignature = useRef('')
  const reload = useCallback(async () => {
    try {
      const next = normalizeState(await api.state())
      // An unchanged snapshot must not re-render the whole tree. Polling and
      // WS-triggered reloads mostly return identical data; comparing the
      // normalized payload is far cheaper than the render it prevents.
      const signature = JSON.stringify(next)
      if (signature === lastSnapshotSignature.current) {
        setError('')
        return
      }
      lastSnapshotSignature.current = signature
      reconcileUnread(next)
      const selectedRun = selectedRunRef.current
      const refreshedRun = selectedRun && next.runs.find((item) => item.id === selectedRun.id)
      if (refreshedRun) selectedRunRef.current = refreshedRun
      else if (selectedRun)
        next.runs = [selectedRun, ...next.runs.filter((item) => item.id !== selectedRun.id)]
      setState(next)
      setExtraSessions((current) => {
        const refreshed = { ...current }
        for (const [key, items] of Object.entries(refreshed)) {
          const latest = new Map(
            next.sessions
              .filter((item) => `${item.hostId}:${item.projectId}` === key)
              .map((item) => [sessionKey(item), item]),
          )
          refreshed[key] = items.map((item) => latest.get(sessionKey(item)) || item)
        }
        return refreshed
      })
      setError('')
      noticeStatusChanges(next)
      if (!initialized.current) initializeSelection(next)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [
    initialized,
    initializeSelection,
    noticeStatusChanges,
    reconcileUnread,
    selectedRunRef,
    setError,
    setExtraSessions,
    setState,
  ])
  useEffect(() => {
    let cancelled = false
    api
      .navigation()
      .then((value) => {
        if (cancelled || initialized.current) return
        const next = normalizeState(value)
        setState(next)
        reconcileUnread(next)
        noticeStatusChanges(next)
        if (
          next.projects.length ||
          next.drafts.length ||
          next.sessions.length ||
          next.runs.length ||
          next.settings.pinnedSessions.length
        )
          initializeSelection(next)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [initialized, initializeSelection, noticeStatusChanges, reconcileUnread, setState])
  useEffect(() => {
    let cancelled = false
    let timer = 0
    let loading = false
    const poll = async () => {
      if (cancelled || loading || document.hidden) return
      loading = true
      try {
        await reload()
      } finally {
        loading = false
      }
      if (!cancelled && !document.hidden) timer = window.setTimeout(poll, 10_000)
    }
    const visibility = () => {
      clearTimeout(timer)
      if (!document.hidden) void poll()
    }
    document.addEventListener('visibilitychange', visibility)
    void poll()
    return () => {
      cancelled = true
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [reload])
  return { reload }
}
