import { useEffect, useState } from 'react'
import type { RefObject } from 'react'
import { api, gatewayOrigin } from '../api'
import { mergeEvents } from '../lib/events'
import { useLatest } from './useLatest'
import type { AppState, RunEvent } from '../types'

/**
 * The per-run event journals this client follows: an initial fetch for the
 * selected run (and the managed run backing a tmux session), plus the
 * WebSocket that appends live events and triggers debounced snapshot reloads.
 */
export function useRunEventStream({
  runId,
  runHostId,
  managedRunId,
  sessionHostId,
  stateRef,
  notifyRunEvent,
  reload,
}: {
  runId: string | undefined
  runHostId: string | undefined
  managedRunId: string | null | undefined
  sessionHostId: string | undefined
  stateRef: RefObject<AppState>
  notifyRunEvent: (event: RunEvent) => void
  reload: () => Promise<void>
}) {
  const [events, setEvents] = useState<Record<string, RunEvent[]>>({})
  // The socket handlers are set up once and must not tear down every time
  // events change, so they read this instead of closing over the value
  // directly.
  const eventsRef = useLatest(events)
  useEffect(() => {
    if (!runId || !runHostId || eventsRef.current[runId]) return
    api
      .events(runHostId, runId)
      .then((items) => setEvents((current) => ({ ...current, [runId]: items })))
      .catch(() => {})
  }, [eventsRef, runHostId, runId])
  useEffect(() => {
    // A tmux session is rendered from its provider transcript, but Codesk's own
    // synthetic events (usage snapshots) live on the backing managed run.
    if (!managedRunId || !sessionHostId || eventsRef.current[managedRunId]) return
    api
      .events(sessionHostId, managedRunId)
      .then((items) => setEvents((current) => ({ ...current, [managedRunId]: items })))
      .catch(() => {})
  }, [eventsRef, managedRunId, sessionHostId])
  useEffect(() => {
    const origin = gatewayOrigin
      ? gatewayOrigin.replace('http://', 'ws://').replace('https://', 'wss://')
      : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`
    let ws: WebSocket | null = null
    let stopped = false
    let retry = 500
    let reloadTimer = 0
    // WS envelopes arrive in bursts (queue updates, turn boundaries); one
    // trailing reload covers the burst instead of a state fetch per frame.
    const reloadSoon = () => {
      if (reloadTimer) return
      reloadTimer = window.setTimeout(() => {
        reloadTimer = 0
        void reload()
      }, 300)
    }
    // Reconnect replay only needs to fill gaps in threads this client already
    // follows, from where each one left off. Fetching full journals for every
    // run on every host made reconnects cost N+1 requests.
    const replay = async () => {
      const runsById = new Map(stateRef.current.runs.map((item) => [item.id, item]))
      await Promise.all(
        Object.keys(eventsRef.current).map(async (runId) => {
          const run = runsById.get(runId)
          if (!run) return
          const prior = eventsRef.current[runId] || []
          const after = prior.length ? prior[prior.length - 1].run_sequence : 0
          const incoming = await api.events(run.hostId, runId, after)
          if (!incoming.length) return
          setEvents((current) => ({
            ...current,
            [runId]: mergeEvents(current[runId] || [], incoming),
          }))
        }),
      )
    }
    const connect = () => {
      if (stopped) return
      ws = new WebSocket(`${origin}/ws`)
      ws.onopen = () => {
        retry = 500
        void reload()
        void replay().catch(() => {})
      }
      ws.onmessage = (message) => {
        const envelope = JSON.parse(message.data)
        if (envelope.type === 'daemon.event') {
          const event = envelope.payload.event as RunEvent
          setEvents((current) => {
            const prior = current[event.run_id] || []
            return prior.some((item) => item.event_id === event.event_id)
              ? current
              : {
                  ...current,
                  [event.run_id]: [...prior, event].sort((a, b) => a.run_sequence - b.run_sequence),
                }
          })
          if (
            event.kind.startsWith('run.') ||
            event.kind.startsWith('control.') ||
            event.kind.startsWith('turn.') ||
            event.kind.startsWith('thread.') ||
            event.kind.startsWith('queue.')
          )
            reloadSoon()
          notifyRunEvent(event)
        } else if (
          envelope.type.startsWith('host.') ||
          envelope.type.startsWith('draft.') ||
          envelope.type === 'settings.updated' ||
          envelope.type === 'state.updated'
        )
          reloadSoon()
      }
      ws.onclose = () => {
        if (!stopped) {
          window.setTimeout(connect, retry)
          retry = Math.min(10000, retry * 1.8)
        }
      }
      ws.onerror = () => ws?.close()
    }
    connect()
    return () => {
      stopped = true
      clearTimeout(reloadTimer)
      ws?.close()
    }
  }, [eventsRef, notifyRunEvent, reload, stateRef])
  return { events }
}
