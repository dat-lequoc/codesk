import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import {
  active,
  notificationEventKinds,
  terminalRunStatuses,
  terminalStatusByEventKind,
} from '../lib/events'
import {
  runEventNotificationKey,
  runNotificationKeys,
  sessionNotificationKey,
  terminalNotificationTag,
} from '../lib/keys'
import { isTauriDesktop, notify, reconcileUnreadKeys } from '../lib/notifications'
import { loadStringSet, saveStringSet } from '../lib/storage'
import type { AppState, ProviderSession, Run, RunEvent } from '../types'

/**
 * Unread-notification bookkeeping: which runs/sessions carry an unread badge,
 * the persisted ledger of already-delivered notifications, and the transitions
 * (status changes, run events) that mark things unread or announce them.
 */
export function useUnreadNotifications({
  stateRef,
  sessionCompletionNotifiedAt,
}: {
  stateRef: RefObject<AppState>
  sessionCompletionNotifiedAt: RefObject<Map<string, number>>
}) {
  const priorRunStatus = useRef<Map<string, Run['status']>>(new Map())
  const priorSessionStatus = useRef<Map<string, ProviderSession['status']>>(new Map())
  const notified = useRef<Set<string>>(loadStringSet('codesk.notifications'))
  const [unreadKeys, setUnreadKeys] = useState<Set<string>>(() =>
    loadStringSet('codesk.unread-notifications:v1'),
  )
  useEffect(() => {
    if (!isTauriDesktop()) return
    void import('@tauri-apps/api/window')
      .then(({ getCurrentWindow }) =>
        getCurrentWindow().setBadgeCount(unreadKeys.size || undefined),
      )
      .catch(() => {})
  }, [unreadKeys.size])
  const updateUnread = useCallback(
    (added: string[], removed: string[] = []) =>
      setUnreadKeys((current) => {
        const next = new Set(current)
        let changed = false
        for (const key of removed) changed = next.delete(key) || changed
        for (const key of added)
          if (!next.has(key)) {
            next.add(key)
            changed = true
          }
        if (!changed) return current
        saveStringSet('codesk.unread-notifications:v1', next)
        return next
      }),
    [],
  )
  const reconcileUnread = useCallback(
    (snapshot: AppState) =>
      setUnreadKeys((current) => {
        const next = reconcileUnreadKeys(current, snapshot)
        if (next.size === current.size && [...next].every((key) => current.has(key))) return current
        saveStringSet('codesk.unread-notifications:v1', next)
        return next
      }),
    [],
  )
  const addUnread = useCallback((keys: string[]) => updateUnread(keys), [updateUnread])
  const clearUnread = useCallback((keys: string[]) => updateUnread([], keys), [updateUnread])
  const readRun = useCallback((run: Run) => clearUnread(runNotificationKeys(run)), [clearUnread])
  const readSession = useCallback(
    (session: ProviderSession) =>
      clearUnread([
        sessionNotificationKey(session),
        ...stateRef.current.runs
          .filter(
            (run) =>
              run.hostId === session.hostId &&
              run.provider === session.provider &&
              run.sessionId === session.nativeSessionId,
          )
          .flatMap(runNotificationKeys),
      ]),
    [clearUnread, stateRef],
  )
  /// Claims a notification tag, returning false if it was already delivered.
  /// The ledger is capped and persisted so a reload does not re-announce work
  /// the user has already seen.
  const rememberNotification = useCallback((tag: string) => {
    if (notified.current.has(tag)) return false
    notified.current.add(tag)
    localStorage.setItem('codesk.notifications', JSON.stringify([...notified.current].slice(-500)))
    return true
  }, [])
  const markRunUnread = useCallback(
    (runId: string, run: Pick<Run, 'hostId' | 'provider' | 'sessionId'> | undefined) => {
      const runKey = runEventNotificationKey(run?.hostId || 'unknown', runId)
      if (run?.sessionId)
        updateUnread([`session:${run.hostId}:${run.provider}:${run.sessionId}`], [runKey])
      else addUnread([runKey])
    },
    [addUnread, updateUnread],
  )
  const notifyRunEvent = useCallback(
    (event: RunEvent) => {
      if (!notificationEventKinds.has(event.kind)) return
      const run = stateRef.current.runs.find((item) => item.id === event.run_id)
      const terminalStatus = terminalStatusByEventKind.get(event.kind)
      const tag = terminalStatus
        ? terminalNotificationTag(event.run_id, terminalStatus)
        : event.event_id
      if (!rememberNotification(tag)) return
      markRunUnread(event.run_id, run)
      if (!stateRef.current.settings.notifications) return
      const label =
        event.kind === 'input.required'
          ? 'Input required'
          : event.kind === 'approval.required'
            ? 'Approval required'
            : `Run ${terminalStatus || 'updated'}`
      void notify(
        `Codesk · ${label}`,
        String(event.payload.text || run?.title || 'Agent run updated'),
        tag,
      )
    },
    [markRunUnread, rememberNotification, stateRef],
  )
  // Status changes are noticed where a fresh snapshot arrives rather than in an
  // effect keyed on `state`. The only thing that moves a run or session between
  // statuses is a fetch, so this is the event handler for that change — and
  // doing it here keeps the unread writes out of the commit phase, where they
  // would cascade a second render on every poll.
  const noticeStatusChanges = useCallback(
    (next: AppState) => {
      const unread: string[] = []
      const read: string[] = []
      for (const run of next.runs) {
        const prior = priorRunStatus.current.get(run.id)
        priorRunStatus.current.set(run.id, run.status)
        if (!prior || !active.has(prior) || !terminalRunStatuses.has(run.status)) continue
        const tag = terminalNotificationTag(run.id, run.status)
        if (!rememberNotification(tag)) continue
        markRunUnread(run.id, run)
        if (next.settings.notifications) void notify(`Codesk · Run ${run.status}`, run.title, tag)
      }
      for (const session of next.sessions) {
        const key = `${session.hostId}:${session.id}`
        const prior = priorSessionStatus.current.get(key)
        priorSessionStatus.current.set(key, session.status)
        const notificationKey = sessionNotificationKey(session)
        const managed = next.runs.some(
          (run) =>
            run.hostId === session.hostId &&
            run.provider === session.provider &&
            run.sessionId === session.nativeSessionId,
        )
        if (session.status === 'running' && !managed) read.push(notificationKey)
        if (session.status !== 'stopped' || prior !== 'running') continue
        // A turn that already announced itself through the transcript watcher
        // must not announce itself again when the harness later exits.
        const completionAt = sessionCompletionNotifiedAt.current.get(notificationKey) || 0
        if (Date.now() - completionAt < 120_000) continue
        unread.push(notificationKey)
        if (!next.settings.notifications) continue
        const tag = `session-stopped:${key}:${session.updatedAt}`
        if (rememberNotification(tag)) void notify('Codesk · Agent stopped', session.title, tag)
      }
      if (unread.length || read.length) updateUnread(unread, read)
    },
    [markRunUnread, rememberNotification, sessionCompletionNotifiedAt, updateUnread],
  )
  return {
    unreadKeys,
    addUnread,
    clearUnread,
    readRun,
    readSession,
    rememberNotification,
    notifyRunEvent,
    noticeStatusChanges,
    reconcileUnread,
    notified,
  }
}
