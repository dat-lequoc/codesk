// Extracted from App.tsx during the Tailwind/module refactor.
import type { AppState } from '../types'
import { runEventNotificationKey, runRowKey, sessionKey, sessionNotificationKey } from './keys'

export const isTauriDesktop = () => '__TAURI_INTERNALS__' in window

export const prepareNotifications = async () => {
  if (isTauriDesktop()) {
    try {
      const { isPermissionGranted, requestPermission } = await import(
        '@tauri-apps/plugin-notification'
      )
      if (await isPermissionGranted()) return true
      return (await requestPermission()) === 'granted'
    } catch {}
  }
  if (!('Notification' in window)) return false
  if (Notification.permission === 'default') await Notification.requestPermission()
  return Notification.permission === 'granted'
}

export const notify = async (title: string, body: string, tag: string) => {
  if (!(await prepareNotifications())) return
  if (isTauriDesktop()) {
    try {
      const { sendNotification } = await import('@tauri-apps/plugin-notification')
      sendNotification({ title, body })
      return
    } catch {}
  }
  if ('Notification' in window && Notification.permission === 'granted')
    new Notification(title, { body, tag })
}

export const reconcileUnreadKeys = (current: Set<string>, state: AppState) => {
  const sessions = [
    ...state.sessions,
    ...state.settings.pinnedSessions,
    ...state.settings.archivedSessions,
  ]
  // Archiving a conversation is the user saying they are done with it, so an
  // archived chat must not keep the bell badge alive — nothing in the sidebar
  // would explain the count.
  const archivedSessionRowKeys = new Set(state.settings.archivedSessionKeys)
  const archivedNotificationKeys = new Set(
    sessions
      .filter((session) => archivedSessionRowKeys.has(sessionKey(session)))
      .map(sessionNotificationKey),
  )
  const archivedRunRowKeys = new Set(state.settings.archivedRunKeys)
  const validSessionKeys = new Set(sessions.map(sessionNotificationKey))
  const runsByKey = new Map(
    state.runs
      .filter((run) => !archivedRunRowKeys.has(runRowKey(run)))
      .map((run) => [runEventNotificationKey(run.hostId, run.id), run]),
  )
  for (const run of state.runs)
    if (run.sessionId && !archivedRunRowKeys.has(runRowKey(run)))
      validSessionKeys.add(`session:${run.hostId}:${run.provider}:${run.sessionId}`)
  const next = new Set<string>()
  for (const key of current) {
    if (archivedNotificationKeys.has(key)) continue
    if (validSessionKeys.has(key)) {
      next.add(key)
      continue
    }
    const run = runsByKey.get(key)
    if (!run) continue
    const resolved = run.sessionId
      ? `session:${run.hostId}:${run.provider}:${run.sessionId}`
      : key
    if (!archivedNotificationKeys.has(resolved)) next.add(resolved)
  }
  return next
}
