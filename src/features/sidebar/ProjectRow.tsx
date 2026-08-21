import { memo } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import {
  ChevronDown,
  ChevronRight,
  FolderGit2,
  MoreHorizontal,
  Pencil,
  RefreshCw,
} from 'lucide-react'
import { Spinner } from '../../components/ui/spinner'
import { StatusDot } from '../../components/ui/status-dot'
import { cn } from '../../lib/cn'
import { draftTitle, relative } from '../../lib/format'
import { sessionKey } from '../../lib/keys'
import { hasHiddenItems } from '../../sessionBudget'
import type { DraftSession, Project, ProviderSession, Run } from '../../types'
import { hostTone, recentStatus, rowMeta, rowTitle, sessionRow, unreadDot } from './row-styles'
import { RunRow } from './RunRow'
import { SessionRow } from './SessionRow'
import { SidebarHarness } from './SidebarHarness'
import type { ProjectRowModel } from './useProjectRows'

export const ProjectRow = memo(function ProjectRow({
  row,
  needle,
  selectedId,
  selectedSessionKey,
  selectedDraftId,
  projectOnlySelected,
  menuOpen,
  refreshing,
  pinnedKeys,
  hasUnreadSession,
  hasUnreadRun,
  onToggle,
  onSelectProject,
  onSelectDraft,
  onSelectSession,
  onSelectRun,
  onTogglePin,
  onArchiveSession,
  onArchiveRun,
  onOpenMenu,
  onRefresh,
  onShowMore,
}: {
  row: ProjectRowModel
  needle: string
  selectedId: string | null
  selectedSessionKey: string | null
  selectedDraftId: string | null
  projectOnlySelected: boolean
  menuOpen: boolean
  refreshing: boolean
  pinnedKeys: string[]
  hasUnreadSession: (session: ProviderSession) => boolean
  hasUnreadRun: (run: Run) => boolean
  onToggle: (key: string) => void
  onSelectProject: (project: Project) => void
  onSelectDraft: (draft: DraftSession) => void
  onSelectSession: (session: ProviderSession) => void
  onSelectRun: (run: Run) => void
  onTogglePin: (session: ProviderSession) => Promise<void>
  onArchiveSession: (project: Project, session: ProviderSession) => void
  onArchiveRun: (project: Project, run: Run) => void
  onOpenMenu: (event: ReactMouseEvent<HTMLElement>, project: Project, canArchive: boolean) => void
  onRefresh: (project: Project) => void
  onShowMore: (project: Project) => void
}) {
  const {
    project,
    key,
    host,
    open,
    canArchive,
    projectUnread,
    totalProjectItems,
    itemLimit,
    visibleProjectDrafts,
    visibleProjectSessions,
    visibleProjectRuns,
    runningSessions,
    runningCount,
  } = row
  return (
    <div
      className={cn(
        'group/project [contain-intrinsic-size:auto_31px] [content-visibility:auto]',
        host?.status !== 'online' && 'opacity-[0.72]',
      )}
      role="treeitem"
      aria-expanded={open}
      aria-selected={projectOnlySelected}
    >
      <div
        className={cn(
          'flex h-[31px] items-center gap-1 rounded-[7px] pr-[5px] pl-px text-fg-soft hover:bg-ink-700',
          projectOnlySelected && 'bg-ink-600',
          menuOpen && 'bg-ink-600',
        )}
        onContextMenu={(event) => onOpenMenu(event, project, canArchive)}
      >
        <button
          className="grid h-[27px] w-4 shrink-0 place-items-center text-dim hover:text-fg-soft"
          aria-label={`${open ? 'Collapse' : 'Expand'} ${project.name}`}
          onClick={() => onToggle(key)}
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        <button
          className="flex h-full min-w-0 flex-1 items-center gap-[5px] text-left"
          onClick={() => onSelectProject(project)}
        >
          <FolderGit2 size={14} className="shrink-0 text-fg-soft" />
          <strong className="min-w-0 flex-1 truncate text-[13.5px] leading-none font-medium tracking-[-0.08px]">
            {project.name}
          </strong>
        </button>
        {projectUnread && (
          <i
            className={cn(unreadDot, 'mx-px')}
            title="Unread agent update"
            aria-label="Unread agent update"
          />
        )}
        {runningCount > 0 && (
          <button
            type="button"
            className="flex h-4 min-w-[22px] shrink-0 items-center justify-center gap-[3px] rounded-full bg-grass-950 px-[5px] text-[8.5px] font-semibold text-grass-400 hover:bg-grass-600/35"
            title={
              runningCount === 1
                ? `Running: ${runningSessions[0].title}`
                : `${runningCount} running conversations`
            }
            aria-label={
              runningCount === 1
                ? `Open running conversation ${runningSessions[0].title}`
                : `Show ${runningCount} running conversations in ${project.name}`
            }
            onClick={(event) => {
              event.stopPropagation()
              if (!open) onToggle(key)
              if (runningCount === 1) onSelectSession(runningSessions[0])
            }}
          >
            <Spinner size={9} />
            {runningCount}
          </button>
        )}
        <button
          className={cn(
            'grid size-[21px] shrink-0 place-items-center rounded-sm text-muted opacity-0 hover:bg-ink-500 hover:text-fg focus-visible:opacity-100 group-hover/project:opacity-100',
            'disabled:cursor-default disabled:text-ink-400',
            refreshing && 'text-grass-400 opacity-100',
          )}
          aria-label={`Refresh sessions for ${project.name}`}
          title={`Refresh sessions for ${project.name}`}
          disabled={refreshing || host?.status !== 'online'}
          onClick={(event) => {
            event.stopPropagation()
            onRefresh(project)
          }}
        >
          <RefreshCw className={cn(refreshing && 'animate-spin')} size={13} />
        </button>
        <button
          className="grid size-[21px] shrink-0 place-items-center rounded-sm text-muted opacity-0 hover:bg-ink-500 hover:text-fg focus-visible:opacity-100 group-hover/project:opacity-100 aria-expanded:opacity-100"
          aria-label={`Project actions for ${project.name}`}
          aria-controls="project-actions-menu"
          aria-expanded={menuOpen}
          title={`Project actions for ${project.name}`}
          onClick={(event) => onOpenMenu(event, project, canArchive)}
        >
          <MoreHorizontal size={14} />
        </button>
        <span className="max-w-[66px] shrink-0 truncate text-[9.5px] leading-none text-muted">
          {host?.name || project.hostId}
        </span>
        <StatusDot tone={hostTone(host?.status)} title={host?.status || 'offline'} />
      </div>
      {open && (
        <div className="pt-px pb-[3px] pl-[15px]" role="group">
          {visibleProjectDrafts.map((draft) => (
            <button
              key={draft.id}
              className={cn(sessionRow, 'pr-1.5', draft.id === selectedDraftId && 'bg-ink-600')}
              onClick={() => onSelectDraft(draft)}
            >
              <span className={cn(recentStatus, 'text-dim')}>
                <Pencil size={10} />
              </span>
              <span className={rowTitle}>
                <SidebarHarness provider={draft.provider} />
                <span className="min-w-0 truncate">{draftTitle(draft)}</span>
              </span>
              <small className={rowMeta}>{relative(draft.updatedAt)}</small>
            </button>
          ))}
          {visibleProjectSessions.map((session) => {
            const sessionId = sessionKey(session)
            return (
              <SessionRow
                key={sessionId}
                session={session}
                sessionId={sessionId}
                selected={sessionId === selectedSessionKey}
                unread={hasUnreadSession(session)}
                pinned={pinnedKeys.includes(sessionId)}
                onSelect={onSelectSession}
                onTogglePin={onTogglePin}
                onArchive={(next) => onArchiveSession(project, next)}
              />
            )
          })}
          {visibleProjectRuns.map((run) => (
            <RunRow
              key={`${run.hostId}:${run.id}`}
              run={run}
              selected={run.id === selectedId}
              unread={hasUnreadRun(run)}
              onSelect={onSelectRun}
              onArchive={(next) => onArchiveRun(project, next)}
            />
          ))}
          {!needle && hasHiddenItems(totalProjectItems, itemLimit) && (
            <button
              className="h-[25px] w-full pr-1.5 pl-[29px] text-left text-[10.5px] text-muted hover:text-fg-soft"
              onClick={() => onShowMore(project)}
            >
              Show more
            </button>
          )}
          {totalProjectItems === 0 && (
            <div className="flex h-[25px] items-center pl-[29px] text-[9.5px] text-dim">
              No chats
            </div>
          )}
        </div>
      )}
    </div>
  )
})
