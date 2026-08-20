// Extracted from App.tsx during the Tailwind/module refactor.
import type { AppState } from '../types'
import { runEventNotificationKey, sessionNotificationKey } from './keys'

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
  const validSessionKeys = new Set(sessions.map(sessionNotificationKey))
  const runsByKey = new Map(
    state.runs.map((run) => [runEventNotificationKey(run.hostId, run.id), run]),
  )
  for (const run of state.runs)
    if (run.sessionId)
      validSessionKeys.add(`session:${run.hostId}:${run.provider}:${run.sessionId}`)
  const next = new Set<string>()
  for (const key of current) {
    if (validSessionKeys.has(key)) {
      next.add(key)
      continue
    }
    const run = runsByKey.get(key)
    if (!run) continue
    next.add(run.sessionId ? `session:${run.hostId}:${run.provider}:${run.sessionId}` : key)
  }
  return next
}
