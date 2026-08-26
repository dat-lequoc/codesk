// Extracted from App.tsx during the Tailwind/module refactor.
import type { AppState, ProviderSession, Run, RunEvent, SessionMessage } from '../types'

export const active = new Set([
  'queued',
  'starting',
  'running',
  'waiting_for_input',
  'interrupting',
])

export const notificationEventKinds = new Set([
  'run.completed',
  'run.failed',
  'run.interrupted',
  'run.killed',
  'run.orphaned',
  'input.required',
  'approval.required',
])

export const terminalRunStatuses = new Set<Run['status']>([
  'completed',
  'failed',
  'interrupted',
  'killed',
  'orphaned',
])

export const terminalStatusByEventKind = new Map<string, Run['status']>(
  [...terminalRunStatuses].map((status) => [`run.${status}`, status]),
)

export const mergeEvents = (prior: RunEvent[], incoming: RunEvent[]) => {
  const merged = new Map(prior.map((event) => [event.event_id, event]))
  for (const event of incoming) merged.set(event.event_id, event)
  return [...merged.values()].sort((left, right) => left.run_sequence - right.run_sequence)
}

export const mergeSessionMessages = (prior: SessionMessage[], incoming: SessionMessage[]) => {
  if (!incoming.length) return prior
  const incomingById = new Map(incoming.map((item) => [item.id, item]))
  const priorIds = new Set(prior.map((item) => item.id))
  const next = prior.map((item) => {
    const replacement = incomingById.get(item.id)
    if (!replacement) return item
    const unchanged =
      item.timestamp === replacement.timestamp &&
      item.role === replacement.role &&
      item.text === replacement.text &&
      item.kind === replacement.kind &&
      item.duration_ms === replacement.duration_ms &&
      JSON.stringify(item.meta) === JSON.stringify(replacement.meta)
    return unchanged ? item : replacement
  })
  for (const item of incoming) if (!priorIds.has(item.id)) next.push(item)
  return next.length === prior.length && next.every((item, index) => item === prior[index])
    ? prior
    : next
}

export type ExternalTranscriptWatch = {
  seen: Set<string>
  after?: string
  initialized: boolean
  turnOpen: boolean
  pendingCompletion?: { messageId: string; detectedAt: number }
}

export const externalCompletionSettleMs = 12_000

/**
 * The live conversations whose transcript has to be watched for a finished turn.
 *
 * A run on a protocol transport publishes its own `turn.completed` event, so
 * watching its transcript as well would announce the same turn twice. Every
 * other live conversation needs the transcript: an agent the user started in
 * their own terminal has no run at all, and a tmux-driven run parks at
 * `waiting_for_input` between turns without ever reaching a terminal status, so
 * its events say nothing when a turn ends.
 */
export const sessionsNeedingTranscriptWatch = (state: AppState) => {
  const reportedByRunEvents = new Set(
    state.runs.flatMap((run) =>
      run.sessionId && run.inputTransport !== 'tmux'
        ? [`${run.hostId}:${run.provider}:${run.sessionId}`]
        : [],
    ),
  )
  return state.sessions.filter(
    (session) =>
      session.pid &&
      state.hosts.find((host) => host.id === session.hostId)?.status === 'online' &&
      !reportedByRunEvents.has(`${session.hostId}:${session.provider}:${session.nativeSessionId}`),
  )
}

export const transcriptTurnOpen = (
  messages: SessionMessage[],
  sessionStatus: ProviderSession['status'],
) => {
  let lastActivity = -1
  let lastCompletion = -1
  messages.forEach((message, index) => {
    if (message.kind === 'turn_completed') lastCompletion = index
    else lastActivity = index
  })
  return lastActivity > lastCompletion || (lastCompletion < 0 && sessionStatus === 'running')
}

export const coalesceStreamEvents = (events: RunEvent[]) => {
  const result: RunEvent[] = []
  for (const event of events) {
    const itemId = typeof event.payload.item_id === 'string' ? event.payload.item_id : ''
    const stream =
      itemId && ['assistant.message', 'reasoning.message', 'tool.output'].includes(event.kind)
    const prior = result.at(-1)
    if (
      stream &&
      prior?.kind === event.kind &&
      prior.channel === event.channel &&
      prior.payload.item_id === itemId
    ) {
      const replacePayload = event.kind === 'tool.output' || event.kind === 'file.change'
      const finalItem = event.provider_event_type === 'codex.item/completed'
      const nextText =
        replacePayload || finalItem
          ? String(event.payload.text || prior.payload.text || '')
          : `${String(prior.payload.text || '')}${String(event.payload.text || '')}`
      result[result.length - 1] = {
        ...prior,
        ...event,
        payload: { ...prior.payload, ...event.payload, text: nextText },
      }
    } else result.push(event)
  }
  return result
}

export const currentBranchEvents = (events: RunEvent[]) => {
  let rewindIndex = -1
  for (let index = events.length - 1; index >= 0; index--)
    if (
      events[index].kind === 'thread.session' &&
      (events[index].raw_payload as { action?: string })?.action === 'rewind'
    ) {
      rewindIndex = index
      break
    }
  if (rewindIndex < 0) return events
  const lastTurnId =
    typeof events[rewindIndex].payload.last_turn_id === 'string'
      ? events[rewindIndex].payload.last_turn_id
      : null
  if (!lastTurnId) return events.slice(rewindIndex)
  let prefixEnd = -1
  for (let index = 0; index < rewindIndex; index++)
    if (events[index].payload.turn_id === lastTurnId) prefixEnd = index
  return [...events.slice(0, prefixEnd + 1), ...events.slice(rewindIndex)]
}

export const pendingQueue = (events: RunEvent[]) => {
  const queued = new Map<string, { id: string; message: string; error?: string }>()
  for (const event of events) {
    const id = typeof event.payload.queue_id === 'string' ? event.payload.queue_id : ''
    if (!id) continue
    if (event.kind === 'queue.added' || event.kind === 'queue.failed') {
      const raw = event.raw_payload as { error?: { message?: string } }
      queued.set(id, {
        id,
        message: String(event.payload.text || ''),
        error: event.kind === 'queue.failed' ? raw?.error?.message || 'Failed to start' : undefined,
      })
    } else if (event.kind === 'queue.started' || event.kind === 'queue.removed') queued.delete(id)
  }
  return [...queued.values()]
}
