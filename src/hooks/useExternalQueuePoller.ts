import { useEffect } from 'react'
import type { RefObject } from 'react'
import { api } from '../api'
import type { ExternalQueuedInput, Run } from '../types'

/**
 * Polls an external session's queue once a second (visibility-aware) while
 * items are queued, adopting the run once the daemon starts one. Shared by
 * SessionScreen and ObservedScreen, which previously carried identical copies.
 */
export function useExternalQueuePoller({
  hostId,
  pid,
  enabled,
  handleStarted,
  setQueued,
}: {
  hostId: string | undefined
  pid: number | null | undefined
  enabled: boolean
  /**
   * Returns true when the started run was adopted; the poller then removes the
   * queue item and ends this cycle. Held in a ref so the poller does not tear
   * down on every parent render.
   */
  handleStarted: RefObject<(run: Run) => boolean>
  setQueued: (items: ExternalQueuedInput[]) => void
}) {
  useEffect(() => {
    if (!hostId || !pid || !enabled) return
    let stopped = false
    let timer = 0
    const poll = async () => {
      if (stopped || document.hidden) return
      try {
        const items = await api.externalSessionQueue(hostId, pid)
        if (stopped) return
        const started = items.find((item) => item.status === 'started' && item.run)
        if (started?.run && handleStarted.current(started.run)) {
          void api.removeExternalQueued(hostId, pid, started.id).catch(() => {})
          return
        }
        setQueued(items)
      } catch {
        // Transient daemon errors just mean the next tick retries.
      }
      if (!stopped && !document.hidden) timer = window.setTimeout(poll, 1000)
    }
    const visibility = () => {
      clearTimeout(timer)
      if (!document.hidden) void poll()
    }
    document.addEventListener('visibilitychange', visibility)
    timer = window.setTimeout(poll, 1000)
    return () => {
      stopped = true
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [hostId, pid, enabled, handleStarted, setQueued])
}
