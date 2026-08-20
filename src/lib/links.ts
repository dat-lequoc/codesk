// Extracted from App.tsx during the Tailwind/module refactor.
import { isTauriDesktop } from './notifications'

export const externalHrefPattern = /^[a-z][a-z\d+.-]*:/i

export const openExternalHref = async (href: string) => {
  if (isTauriDesktop()) {
    try {
      const { openUrl } = await import('@tauri-apps/plugin-opener')
      await openUrl(href)
      return
    } catch (cause) {
      console.error('Could not open external link through Tauri', cause)
    }
  }
  window.open(href, '_blank', 'noopener,noreferrer')
}

export const linkedFilePath = (href: string, cwd: string) => {
  let value = href
  if (value.startsWith('file://')) {
    try {
      value = new URL(value).pathname
    } catch {}
  } else value = value.split(/[?#]/, 1)[0]
  try {
    value = decodeURIComponent(value)
  } catch {}
  value = value.replace(/:(\d+)(?::\d+)?$/, '')
  if (value.startsWith('/')) return value
  return `${cwd.replace(/\/$/, '')}/${value.replace(/^\.\//, '')}`
}
