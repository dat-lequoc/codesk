import { memo } from 'react'
import { Archive, Circle } from 'lucide-react'
import { Spinner } from '../../components/ui/spinner'
import { cn } from '../../lib/cn'
import { active } from '../../lib/events'
import { relative } from '../../lib/format'
import { providerName } from '../../lib/providers'
import type { Run } from '../../types'
import { recentStatus, rowAffordance, rowMeta, rowTitle, sessionRow, unreadDot } from './row-styles'
import { SidebarHarness } from './SidebarHarness'

export const RunRow = memo(function RunRow({
  run,
  selected,
  unread,
  onSelect,
  onArchive,
}: {
  run: Run
  selected: boolean
  unread: boolean
  onSelect: (run: Run) => void
  onArchive: (run: Run) => void
}) {
  const isWorking =
    run.status === 'running' || run.status === 'starting' || run.status === 'interrupting'
  const isWaiting = run.status === 'waiting_for_input'
  const isActive = active.has(run.status)

  return (
    <div className="group relative flex min-h-7 min-w-0">
      <button
        className={cn(sessionRow, selected && 'bg-ink-600')}
        title={`${providerName(run.provider)} · ${run.title}`}
        onClick={() => onSelect(run)}
      >
        <span
          className={cn(
            recentStatus,
            isWorking && 'text-grass-400',
            isWaiting && 'text-azure-400',
            !isActive && 'text-muted',
          )}
        >
          {isWorking ? (
            <Spinner />
          ) : (
            <Circle
              size={7}
              fill="currentColor"
              className={isWaiting ? 'animate-pulse' : undefined}
            />
          )}
        </span>
        <span className={rowTitle}>
          <SidebarHarness provider={run.provider} />
          <span className="min-w-0 truncate">{run.title}</span>
        </span>
        {unread ? (
          <i
            className={cn(unreadDot, 'ml-0.5')}
            title="Finished — unread agent update"
            aria-label="Finished, unread agent update"
          />
        ) : (
          <small className={rowMeta}>{relative(run.createdAt)}</small>
        )}
      </button>
      <button
        className={cn(rowAffordance, 'right-[3px] hover:text-amber-signal-400')}
        title="Archive run"
        onClick={() => onArchive(run)}
      >
        <Archive size={12} />
      </button>
    </div>
  )
})
