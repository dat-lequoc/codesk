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

export const durationLabel = (durationMs: number) => {
  const seconds = Math.max(0, Math.round(durationMs / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`
}

/**
 * Truncate long file paths by keeping the initial segment, '...', and the
 * trailing segments (at least the parent folder and file name when possible).
 */
export const middleTruncatePath = (path?: string | null, maxLength = 40): string => {
  if (!path) return ''
  const trimmed = path.trim()
  if (!trimmed || trimmed.length <= maxLength) return trimmed

  const isAbsolute = trimmed.startsWith('/')
  const isHome = trimmed.startsWith('~/')
  const normalized = trimmed.replace(/\\/g, '/')

  let rawParts: string[]
  let basePrefix = ''
  if (isHome) {
    rawParts = normalized.slice(2).split('/').filter(Boolean)
    basePrefix = '~/'
  } else if (isAbsolute) {
    rawParts = normalized.slice(1).split('/').filter(Boolean)
    basePrefix = '/'
  } else {
    rawParts = normalized.split('/').filter(Boolean)
    basePrefix = ''
  }

  if (rawParts.length <= 1) {
    const fileName = rawParts[0] || trimmed
    if (fileName.length <= maxLength) return `${basePrefix}${fileName}`
    const keep = Math.max(3, Math.floor((maxLength - basePrefix.length - 3) / 2))
    return `${basePrefix}${fileName.slice(0, keep)}...${fileName.slice(-keep)}`
  }

  const fileName = rawParts[rawParts.length - 1]
  const parentFolder = rawParts[rawParts.length - 2]
  const minTail = `${parentFolder}/${fileName}`

  // If minTail itself is too long for maxLength
  if (minTail.length >= maxLength - 4) {
    if (fileName.length <= maxLength - 4) {
      return `.../${fileName}`
    }
    const keep = Math.max(3, Math.floor((maxLength - 7) / 2))
    return `.../${fileName.slice(0, keep)}...${fileName.slice(-keep)}`
  }

  const firstSegment = `${basePrefix}${rawParts[0]}`
  const ellipsis = '/.../'

  // Try prefix + '/.../' + tail
  if (`${firstSegment}${ellipsis}${minTail}`.length <= maxLength) {
    let tailParts = [parentFolder, fileName]
    for (let i = rawParts.length - 3; i >= 1; i--) {
      const candidateTail = [rawParts[i], ...tailParts].join('/')
      if (`${firstSegment}${ellipsis}${candidateTail}`.length <= maxLength) {
        tailParts = [rawParts[i], ...tailParts]
      } else {
        break
      }
    }
    return `${firstSegment}${ellipsis}${tailParts.join('/')}`
  }

  // If firstSegment doesn't fit with minTail, try root prefix (e.g. '/' or '~/') + '.../'
  if (basePrefix && `${basePrefix}.../${minTail}`.length <= maxLength) {
    let tailParts = [parentFolder, fileName]
    for (let i = rawParts.length - 3; i >= 0; i--) {
      const candidateTail = [rawParts[i], ...tailParts].join('/')
      if (`${basePrefix}.../${candidateTail}`.length <= maxLength) {
        tailParts = [rawParts[i], ...tailParts]
      } else {
        break
      }
    }
    return `${basePrefix}.../${tailParts.join('/')}`
  }

  let tailParts = [parentFolder, fileName]
  for (let i = rawParts.length - 3; i >= 0; i--) {
    const candidateTail = [rawParts[i], ...tailParts].join('/')
    if (`.../${candidateTail}`.length <= maxLength) {
      tailParts = [rawParts[i], ...tailParts]
    } else {
      break
    }
  }
  return `.../${tailParts.join('/')}`
}
