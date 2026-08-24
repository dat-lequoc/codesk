import { memo } from 'react'
import { Archive, Circle, Pin, PinOff } from 'lucide-react'
import { Spinner } from '../../components/ui/spinner'
import { useSessionFinishSeen } from '../../hooks/useSessionFinishSeen'
import { cn } from '../../lib/cn'
import { relative } from '../../lib/format'
import { sessionNotificationKey } from '../../lib/keys'
import { providerName } from '../../lib/providers'
import type { ProviderSession } from '../../types'
import { recentStatus, rowAffordance, rowMeta, rowTitle, sessionRow, unreadDot } from './row-styles'
import { SidebarHarness } from './SidebarHarness'

export const SessionRow = memo(function SessionRow({
  session,
  sessionId,
  selected,
  unread,
  pinned,
  onSelect,
  onTogglePin,
  onArchive,
}: {
  session: ProviderSession
  sessionId: string
  selected: boolean
  unread: boolean
  pinned: boolean
  onSelect: (session: ProviderSession) => void
  onTogglePin: (session: ProviderSession) => Promise<void>
  onArchive: (session: ProviderSession) => void
}) {
  // The gateway keeps `stopped` for 45s after a run ends so this circle can
  // surface a just-finished chat. Hide it as soon as the user has read to
  // the bottom — waiting out the hold felt like the indicator was stuck.
  const finishSeen = useSessionFinishSeen(sessionNotificationKey(session))
  const justFinished = session.status === 'stopped' && !finishSeen
  return (
    <div className="group relative flex min-h-7 min-w-0">
      <button
        data-session-key={sessionId}
        className={cn(
          sessionRow,
          session.status === 'running' && 'bg-grass-950/70 hover:bg-grass-950',
          selected && 'bg-ink-600',
        )}
        title={`${providerName(session.provider)} · ${session.title}`}
        onClick={() => onSelect(session)}
        onContextMenu={(event) => {
          event.preventDefault()
          void onTogglePin(session)
        }}
      >
        <span
          className={cn(
            recentStatus,
            session.status === 'running' ? 'text-grass-400' : 'text-scarlet-500',
          )}
        >
          {session.status === 'running' ? (
            <Spinner />
          ) : justFinished ? (
            <Circle
              className="drop-shadow-[0_0_3px_#e54848]"
              size={7}
              fill="currentColor"
              aria-label="Just finished"
            />
          ) : null}
        </span>
        <span className={rowTitle}>
          <SidebarHarness provider={session.provider} />
          <span className="min-w-0 truncate">{session.title}</span>
        </span>
        {unread ? (
          <i
            className={cn(unreadDot, 'ml-0.5')}
            title="Finished — unread agent update"
            aria-label="Finished, unread agent update"
          />
        ) : (
          <small className={rowMeta}>{relative(session.updatedAt)}</small>
        )}
      </button>
      <button
        className={cn(rowAffordance, 'right-[25px] hover:text-amber-signal-400')}
        title="Archive conversation"
        onClick={() => onArchive(session)}
      >
        <Archive size={12} />
      </button>
      <button
        className={cn(rowAffordance, 'right-[3px]', pinned && 'opacity-100')}
        title={pinned ? 'Unpin conversation' : 'Pin conversation'}
        onClick={() => void onTogglePin(session)}
      >
        {pinned ? <PinOff size={12} /> : <Pin size={12} />}
      </button>
    </div>
  )
})
