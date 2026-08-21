import { useEffect, useMemo, useRef } from 'react'
import type { RefObject } from 'react'
import { api } from '../api'
import { externalCompletionSettleMs, transcriptTurnOpen } from '../lib/events'
import type { ExternalTranscriptWatch } from '../lib/events'
import { sessionNotificationKey } from '../lib/keys'
import { notify } from '../lib/notifications'
import type { AppState, ProviderSession } from '../types'

/**
 * Watches the transcripts of externally-driven sessions (agents the user runs
 * in their own terminal) so a completed turn can raise an unread badge and a
 * notification, even though no Codesk-managed run reports events for them.
 */
export function useExternalTranscriptWatcher({
  sessions,
  stateRef,
  addUnread,
  clearUnread,
  rememberNotification,
  notified,
  selectedSessionNotificationKeyRef,
  sessionCompletionNotifiedAt,
}: {
  sessions: ProviderSession[]
  stateRef: RefObject<AppState>
  addUnread: (keys: string[]) => void
  clearUnread: (keys: string[]) => void
  rememberNotification: (tag: string) => boolean
  notified: RefObject<Set<string>>
  selectedSessionNotificationKeyRef: RefObject<string | null>
  sessionCompletionNotifiedAt: RefObject<Map<string, number>>
}) {
  const externalTranscriptWatches = useRef<Map<string, ExternalTranscriptWatch>>(new Map())
  const liveExternalSessionSignature = useMemo(
    () =>
      sessions
        .filter((item) => item.pid)
        .map((item) => sessionNotificationKey(item))
        .sort()
        .join('|'),
    [sessions],
  )
  useEffect(() => {
    let stopped = false
    let timer = 0
    let loading = false
    const pollSession = async (session: ProviderSession) => {
      const key = sessionNotificationKey(session)
      let watch = externalTranscriptWatches.current.get(key)
      if (!watch) {
        watch = { seen: new Set(), initialized: false, turnOpen: false }
        externalTranscriptWatches.current.set(key, watch)
      }
      try {
        const incoming = await api.sessionMessages(
          session.hostId,
          session.projectId,
          session.provider,
          session.nativeSessionId,
          watch.after,
        )
        if (stopped) return
        const latestTimestamp = incoming.reduce(
          (latest, message) => (message.timestamp > latest ? message.timestamp : latest),
          watch.after || '',
        )
        if (latestTimestamp) watch.after = latestTimestamp
        if (!watch.initialized) {
          watch.seen = new Set(incoming.map((message) => message.id))
          watch.turnOpen = transcriptTurnOpen(incoming, session.status)
          watch.initialized = true
          return
        }
        for (const message of incoming) {
          if (watch.seen.has(message.id)) continue
          watch.seen.add(message.id)
          if (message.kind !== 'turn_completed') {
            if (!watch.turnOpen || watch.pendingCompletion) clearUnread([key])
            watch.turnOpen = true
            watch.pendingCompletion = undefined
            sessionCompletionNotifiedAt.current.delete(key)
            continue
          }
          if (!watch.turnOpen) continue
          watch.turnOpen = false
          const tag = `session-turn:${session.hostId}:${session.provider}:${session.nativeSessionId}:${message.id}`
          if (!notified.current.has(tag))
            watch.pendingCompletion = { messageId: message.id, detectedAt: Date.now() }
        }
        const pending = watch.pendingCompletion
        if (
          pending &&
          !watch.turnOpen &&
          session.status !== 'running' &&
          Date.now() - pending.detectedAt >= externalCompletionSettleMs
        ) {
          watch.pendingCompletion = undefined
          const tag = `session-turn:${session.hostId}:${session.provider}:${session.nativeSessionId}:${pending.messageId}`
          if (rememberNotification(tag)) {
            sessionCompletionNotifiedAt.current.set(key, Date.now())
            const activelyViewing =
              !document.hidden &&
              document.hasFocus() &&
              selectedSessionNotificationKeyRef.current === key
            if (!activelyViewing) {
              addUnread([key])
              if (stateRef.current.settings.notifications)
                void notify('Codesk · Turn completed', session.title, tag)
            }
          }
        }
      } catch {}
    }
    const poll = async () => {
      // Watching external transcripts is a notification nicety; it has no
      // business polling while the window is hidden.
      if (stopped || loading || document.hidden) return
      loading = true
      const snapshot = stateRef.current
      const managedSessions = new Set(
        snapshot.runs.flatMap((run) =>
          run.sessionId ? [`${run.hostId}:${run.provider}:${run.sessionId}`] : [],
        ),
      )
      const sessions = snapshot.sessions.filter(
        (session) =>
          session.pid &&
          snapshot.hosts.find((host) => host.id === session.hostId)?.status === 'online' &&
          !managedSessions.has(`${session.hostId}:${session.provider}:${session.nativeSessionId}`),
      )
      const activeKeys = new Set(sessions.map(sessionNotificationKey))
      for (const key of externalTranscriptWatches.current.keys())
        if (!activeKeys.has(key)) externalTranscriptWatches.current.delete(key)
      await Promise.all(sessions.map(pollSession))
      loading = false
      if (stopped) return
      const needsFastPoll = sessions.some((session) => {
        const watch = externalTranscriptWatches.current.get(sessionNotificationKey(session))
        return watch?.turnOpen || watch?.pendingCompletion
      })
      timer = window.setTimeout(poll, needsFastPoll ? 3_000 : 15_000)
    }
    const visibility = () => {
      clearTimeout(timer)
      if (!document.hidden) void poll()
    }
    document.addEventListener('visibilitychange', visibility)
    void poll()
    return () => {
      stopped = true
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [
    addUnread,
    clearUnread,
    liveExternalSessionSignature,
    notified,
    rememberNotification,
    selectedSessionNotificationKeyRef,
    sessionCompletionNotifiedAt,
    stateRef,
  ])
}
