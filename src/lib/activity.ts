// Extracted from App.tsx during the Tailwind/module refactor.
import type { Run, RunEvent, SessionMessage } from '../types'

export type TimelineItem = RunEvent | { type: 'activity'; id: string; events: RunEvent[] }

export const isActivityGroup = (
  item: TimelineItem,
): item is Extract<TimelineItem, { type: 'activity' }> => 'type' in item && item.type === 'activity'

export const isActivityEvent = (event: RunEvent) =>
  ['reasoning.message', 'tool.output', 'file.change'].includes(event.kind)

export const timelineItems = (events: RunEvent[]) => {
  const items: TimelineItem[] = []
  let group: RunEvent[] = []
  const flush = () => {
    if (!group.length) return
    items.push({ type: 'activity', id: `activity:${group[0].event_id}`, events: group })
    group = []
  }
  for (const event of events) {
    if (isActivityEvent(event)) group.push(event)
    else {
      flush()
      items.push(event)
    }
  }
  flush()
  return items
}

export const turnDurations = (events: RunEvent[]) => {
  const starts = new Map<string, number>()
  const durations = new Map<string, number>()
  for (const event of events) {
    const turnId = typeof event.payload.turn_id === 'string' ? event.payload.turn_id : ''
    if (!turnId) continue
    if (event.kind === 'turn.started') starts.set(turnId, new Date(event.timestamp).getTime())
    if (event.kind === 'turn.completed' && starts.has(turnId))
      durations.set(event.event_id, new Date(event.timestamp).getTime() - starts.get(turnId)!)
  }
  return durations
}

export type FileChange = { path?: string; kind?: string; diff?: string }

export type ActivityStatus = 'running' | 'completed' | 'failed'

export type ActivityEntry = {
  id: string
  correlationId?: string
  type: 'tool' | 'files'
  label: string
  status: ActivityStatus
  input?: unknown
  output?: unknown
  changes: FileChange[]
  timestamp: string
  raw: unknown
}

export type ActivityLedgerItem =
  | { type: 'reasoning'; id: string; text: string }
  | { type: 'entry'; entry: ActivityEntry }

export const diffCounts = (diff = '') =>
  diff.split('\n').reduce(
    (counts, line) => {
      if (line.startsWith('+') && !line.startsWith('+++')) counts.additions += 1
      if (line.startsWith('-') && !line.startsWith('---')) counts.deletions += 1
      return counts
    },
    { additions: 0, deletions: 0 },
  )

export const changePath = (run: Run, path = '') =>
  path.startsWith('/') ? path : `${run.cwd.replace(/\/$/, '')}/${path}`

export const activityText = (value: unknown) => {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export const compactActivityValue = (value: unknown, limit = 150) => {
  if (value === undefined || value === null || value === '') return ''
  const text = activityText(value).replace(/\s+/g, ' ').trim()
  if (text.length <= limit) return text
  return `${text.slice(0, Math.max(1, limit - 1)).trimEnd()}…`
}

export const wrappedExecCommand = (value: unknown) => {
  if (typeof value !== 'string' || !value.includes('tools.exec_command')) return ''
  const match = value.match(
    /tools\.exec_command\(\s*\{\s*cmd\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/s,
  )
  if (!match) return ''
  const literal = match[1]
  let command = literal.slice(1, -1)
  if (literal.startsWith('"')) {
    try {
      command = JSON.parse(literal) as string
    } catch {}
  } else
    command = command
      .replace(/\\(['\\`])/g, '$1')
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
  command = compactActivityValue(command, 600)
  if (!command) return ''
  return /^\/bin\/zsh\s+-lc\b/.test(command) ? command : `/bin/zsh -lc ${command}`
}

export const activityCommandValue = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const record = value as Record<string, unknown>
  return record.command ?? record.cmd ?? record.argv ?? record.args ?? record.path ?? record.paths
}

export const activityFileSummary = (entry: ActivityEntry) => {
  if (entry.type === 'files') {
    const paths = entry.changes
      .map((change) => change.path)
      .filter(Boolean)
      .slice(0, 3) as string[]
    const hidden = Math.max(0, entry.changes.filter((change) => change.path).length - paths.length)
    const stats = entry.changes.reduce(
      (total, change) => {
        const counts = diffCounts(change.diff)
        total.additions += counts.additions
        total.deletions += counts.deletions
        return total
      },
      { additions: 0, deletions: 0 },
    )
    const pathText = paths.join(' · ')
    const countText = `${stats.additions > 0 ? `+${stats.additions}` : ''}${stats.deletions > 0 ? `${stats.additions > 0 ? ' ' : ''}-${stats.deletions}` : ''}`
    return [
      pathText || (entry.changes.length ? `${entry.changes.length} changed paths` : ''),
      hidden > 0 ? `+${hidden} more` : '',
      countText,
    ]
      .filter(Boolean)
      .join('  ')
  }
  return ''
}

export const activityRowLabel = (entry: ActivityEntry) => {
  if (entry.type === 'files')
    return [entry.label, activityFileSummary(entry)].filter(Boolean).join(' · ')
  return (
    wrappedExecCommand(entry.input) ||
    compactActivityValue(activityCommandValue(entry.input), 600) ||
    compactActivityValue(entry.label, 600) ||
    'Tool activity'
  )
}

export const isWrappedExecEntry = (entry: ActivityEntry) => Boolean(wrappedExecCommand(entry.input))

export const mergeWrappedExecEntry = (items: ActivityLedgerItem[], entry: ActivityEntry) => {
  if (entry.type !== 'tool' || isWrappedExecEntry(entry)) return false
  const label = activityRowLabel(entry)
  for (let index = items.length - 1; index >= 0; index--) {
    const candidate = items[index]
    if (candidate.type === 'reasoning') break
    if (
      candidate.entry.type === 'tool' &&
      isWrappedExecEntry(candidate.entry) &&
      activityRowLabel(candidate.entry) === label
    ) {
      items[index] = { type: 'entry', entry: mergeActivityEntries(candidate.entry, entry) }
      return true
    }
  }
  return false
}

export const activityStatus = (value: unknown, failed = false): ActivityStatus => {
  const status = String(value || '').toLowerCase()
  if (failed || ['failed', 'error', 'errored', 'cancelled'].includes(status)) return 'failed'
  if (['in_progress', 'running', 'pending', 'started'].includes(status)) return 'running'
  return 'completed'
}

export const liveActivityEntry = (event: RunEvent): ActivityEntry | null => {
  if (event.kind === 'reasoning.message') return null
  const raw = event.raw_payload as {
    method?: string
    params?: {
      command?: unknown
      item?: { type?: string; command?: unknown; changes?: FileChange[] }
      update?: { title?: string; kind?: string; status?: string }
    }
  }
  const method = raw?.method || ''
  const item = raw?.params?.item
  const payloadChanges = Array.isArray(event.payload.changes)
    ? (event.payload.changes as FileChange[])
    : []
  const changes = payloadChanges.length ? payloadChanges : item?.changes || []
  const files =
    event.kind === 'file.change' ||
    method.includes('fileChange') ||
    item?.type === 'fileChange' ||
    changes.length > 0
  const text = String(event.payload.text || '')
  const command =
    event.payload.tool_title ??
    event.payload.tool_name ??
    raw?.params?.update?.title ??
    raw?.params?.command ??
    item?.command
  const label = files
    ? changes.length
      ? `Edited ${changes.length} file${changes.length === 1 ? '' : 's'}`
      : 'File changes'
    : activityText(command) ||
      (event.kind === 'tool.output' ? 'Tool output' : event.kind.replaceAll('.', ' '))
  const status = event.payload.tool_status ?? raw?.params?.update?.status
  const input =
    event.payload.raw_input ??
    event.payload.input ??
    (!files && command !== undefined ? command : undefined)
  const rawOutput = event.payload.raw_output ?? event.payload.output
  const output =
    rawOutput !== undefined
      ? rawOutput
      : text && text !== label && text !== activityText(command)
        ? text
        : undefined
  const correlationId =
    typeof event.payload.item_id === 'string' ? event.payload.item_id : undefined
  return {
    id: `run:${event.run_id}:${correlationId || event.event_id}`,
    correlationId,
    type: files ? 'files' : 'tool',
    label,
    status: activityStatus(status, event.channel === 'stderr' || event.kind === 'run.error'),
    input,
    output,
    changes,
    timestamp: event.timestamp,
    raw: {
      kind: event.kind,
      provider_event_type: event.provider_event_type,
      channel: event.channel,
      payload: event.payload,
      provider_payload: event.raw_payload,
    },
  }
}

export const liveActivityItems = (events: RunEvent[]): ActivityLedgerItem[] => {
  const items: ActivityLedgerItem[] = []
  for (const event of events) {
    if (event.kind === 'reasoning.message') {
      items.push({ type: 'reasoning', id: event.event_id, text: String(event.payload.text || '') })
      continue
    }
    const entry = liveActivityEntry(event)
    if (!entry) continue
    if (event.kind === 'tool.output' && entry.label === 'Tool output') {
      let match = -1
      for (let index = items.length - 1; index >= 0; index--) {
        const candidate = items[index]
        if (candidate.type === 'reasoning') break
        if (
          candidate.entry.type === 'tool' &&
          (candidate.entry.correlationId === entry.correlationId || index === items.length - 1)
        ) {
          match = index
          break
        }
      }
      if (match >= 0) {
        const candidate = items[match]
        if (candidate.type === 'entry') {
          items[match] = { type: 'entry', entry: mergeActivityEntries(candidate.entry, entry) }
          continue
        }
      }
      continue
    }
    if (mergeWrappedExecEntry(items, entry)) continue
    items.push({ type: 'entry', entry })
  }
  return items
}

export const historicalActivityEntry = (message: SessionMessage): ActivityEntry => {
  const meta = message.meta || {}
  const changes = meta.changes || []
  const files = message.kind === 'file_change' || changes.length > 0
  const output = meta.output !== undefined ? meta.output : message.text || undefined
  const input = meta.input !== undefined ? meta.input : meta.command
  const correlationId = meta.call_id || message.id
  return {
    id: `history:${correlationId}`,
    correlationId,
    type: files ? 'files' : 'tool',
    label: files
      ? changes.length
        ? `Edited ${changes.length} file${changes.length === 1 ? '' : 's'}`
        : 'File changes'
      : activityText(meta.display || meta.tool || meta.command) || 'Tool output',
    status: activityStatus(meta.status),
    input,
    output,
    changes,
    timestamp: message.timestamp,
    raw: { id: message.id, kind: message.kind, text: message.text, meta: message.meta },
  }
}

export const mergeActivityEntries = (prior: ActivityEntry, next: ActivityEntry): ActivityEntry => ({
  ...prior,
  type: prior.type === 'files' || next.type === 'files' ? 'files' : 'tool',
  label: prior.label === 'Tool output' ? next.label : prior.label,
  status: next.status,
  input: prior.input ?? next.input,
  output: next.output ?? prior.output,
  changes: next.changes.length ? next.changes : prior.changes,
  timestamp: next.timestamp || prior.timestamp,
  raw: [prior.raw, next.raw],
})

export const historicalActivityItems = (messages: SessionMessage[]): ActivityLedgerItem[] => {
  const items: ActivityLedgerItem[] = []
  for (const message of messages) {
    if (message.kind === 'reasoning') {
      items.push({ type: 'reasoning', id: message.id, text: message.text })
      continue
    }
    const entry = historicalActivityEntry(message)
    let match = -1
    if (message.kind === 'tool_output') {
      for (let index = items.length - 1; index >= 0; index--) {
        const candidate = items[index]
        if (candidate.type === 'reasoning') break
        if (
          candidate.entry.type === 'tool' &&
          (candidate.entry.correlationId === entry.correlationId || index === items.length - 1)
        ) {
          match = index
          break
        }
      }
    }
    if (match >= 0) {
      const candidate = items[match]
      if (candidate.type === 'entry')
        items[match] = { type: 'entry', entry: mergeActivityEntries(candidate.entry, entry) }
    } else if (message.kind !== 'tool_output' && !mergeWrappedExecEntry(items, entry))
      items.push({ type: 'entry', entry })
  }
  return items
}

export type HistoricalTimelineItem =
  | SessionMessage
  | { type: 'activity'; id: string; messages: SessionMessage[] }

export const isHistoricalActivity = (
  item: HistoricalTimelineItem,
): item is Extract<HistoricalTimelineItem, { type: 'activity' }> =>
  'type' in item && item.type === 'activity'

export const historicalActivityKinds = new Set(['reasoning', 'tool', 'tool_output', 'file_change'])

export const normalizeHistoricalActivityMessages = (messages: SessionMessage[]) => {
  const normalized: SessionMessage[] = []
  for (const message of messages) {
    if (message.kind === 'tool_output') {
      let match = -1
      const callId = message.meta?.call_id
      for (let index = normalized.length - 1; index >= 0; index--) {
        const prior = normalized[index]
        if (prior.role === 'user' || prior.kind === 'turn_completed') break
        if (
          (prior.kind === 'tool' || prior.kind === 'file_change') &&
          (!callId || prior.meta?.call_id === callId)
        ) {
          match = index
          break
        }
      }
      if (match >= 0) {
        const prior = normalized[match]
        normalized[match] = {
          ...prior,
          text: prior.text || message.text,
          meta: {
            ...prior.meta,
            output: message.meta?.output ?? (message.text || prior.meta?.output),
            status: message.meta?.status || prior.meta?.status,
            raw: [prior.meta?.raw, message.meta?.raw].filter(Boolean),
          },
        }
        continue
      }
    }
    normalized.push(message)
  }
  return normalized
}

export const historicalTimelineItems = (messages: SessionMessage[]) => {
  const items: HistoricalTimelineItem[] = []
  let activity: SessionMessage[] = []
  const flush = () => {
    if (!activity.length) return
    items.push({ type: 'activity', id: `history-activity:${activity[0].id}`, messages: activity })
    activity = []
  }
  for (const message of normalizeHistoricalActivityMessages(messages)) {
    if (historicalActivityKinds.has(message.kind || '')) activity.push(message)
    else {
      flush()
      items.push(message)
    }
  }
  flush()
  return items
}
