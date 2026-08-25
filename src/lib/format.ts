// Extracted from App.tsx during the Tailwind/module refactor.
import type { DraftSession } from '../types'

export const environmentContextPattern =
  /<environment_context(?:\s[^>]*)?>[\s\S]*?<\/environment_context>/gi

export const relative = (value?: string | null) => {
  if (!value) return ''
  const seconds = Math.floor((Date.now() - new Date(value).getTime()) / 1000)
  return seconds < 60
    ? 'now'
    : seconds < 3600
      ? `${Math.floor(seconds / 60)}m`
      : `${Math.floor(seconds / 3600)}h`
}

export const draftTitle = (draft: DraftSession) => {
  const text = draft.prompt?.trim().replace(/\s+/g, ' ') || ''
  return text.length > 46 ? `${text.slice(0, 45)}…` : text
}

export const pathLike = (value: string) => {
  const query = value.trim()
  return query.startsWith('/') || query.startsWith('~') || query.includes('/')
}

export const conversationText = (value: string) => {
  const hadContext = environmentContextPattern.test(value)
  environmentContextPattern.lastIndex = 0
  return { text: value.replace(environmentContextPattern, '').trim(), hadContext }
}

export const modelEffortLabel = (model?: string | null, effort?: string | null) =>
  [model, effort].filter(Boolean).join(' · ')

export const durationLabel = (durationMs: number) => {
  const seconds = Math.max(0, Math.round(durationMs / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`
}
