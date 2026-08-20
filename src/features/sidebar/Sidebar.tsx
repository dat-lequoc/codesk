import {
  Archive,
  Bell,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock3,
  FolderGit2,
  GitBranch,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plug,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Trash2,
  X,
} from 'lucide-react'

import { api } from '../../api'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu'
import { Spinner } from '../../components/ui/spinner'
import { StatusDot, type StatusTone } from '../../components/ui/status-dot'
import { useLatest } from '../../hooks/useLatest'
import { cn } from '../../lib/cn'
import { DETACHED_FOLDER_PREVIEW, logoUrl, observedAgents } from '../../lib/app-state'
import { active } from '../../lib/events'
import { draftTitle, relative } from '../../lib/format'
import {
  normalizedFolder,
  projectKey,
  recentFirst,
  runNotificationKeys,
  runRowKey,
  sessionKey,
  sessionNotificationKey,
} from '../../lib/keys'
import { loadExpandedProjects, saveStringSet } from '../../lib/storage'
import { providerName } from '../../lib/providers'
import { ProviderIcon } from '../../components/ProviderIcon'
import {
  budgetAfterArchive,
  budgetAfterShowMore,
  hasHiddenItems,
  itemBudget,
} from '../../sessionBudget'
import type {
  AppState,
  DiscoveredAgent,
  DraftSession,
  Project,
  Provider,
  ProviderSession,
  Run,
} from '../../types'
import { useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
/* Shared row styles. Values mirror the computed styles of the stylesheet this
   replaced, so density is unchanged; the names now say what each row is. */
const sideAction =
  'flex h-[34px] w-full items-center gap-[9px] rounded-[7px] px-[7px] text-[13px] text-fg-soft hover:bg-ink-650'
const sideHeading = 'flex h-8 items-end gap-1 px-[7px] pb-1.5 text-[11.5px] text-dim'
const iconButton = 'grid place-items-center text-muted hover:text-fg'
const rowTitle = 'flex min-w-0 flex-1 items-center gap-1 overflow-hidden whitespace-nowrap'
const rowMeta = 'max-w-[44px] shrink-0 truncate text-[9px] text-muted'
const recentStatus = 'grid w-[11px] shrink-0 place-items-center [&>svg]:max-w-[10px]'
const unreadDot =
  'block size-2 shrink-0 rounded-full bg-scarlet-500 shadow-[0_0_0_2px_#ff3b3033,0_0_7px_#ff3b30aa]'
/* Hover/focus reveals the trailing controls, so the row pads out to make room. */
const rowAffordance =
  'absolute top-[3px] grid size-[21px] place-items-center rounded-sm bg-ink-600 text-muted opacity-0 transition-opacity hover:bg-ink-500 hover:text-fg focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100'
const sessionRow =
  'flex h-7 min-w-0 flex-1 items-center gap-1 rounded-md py-0 pl-0.5 text-left text-[12.5px] text-fg-soft transition-[padding] pr-1.5 group-hover:pr-[47px] group-focus-within:pr-[47px] hover:bg-ink-700'

const hostTone = (status?: string): StatusTone =>
  status === 'online'
    ? 'online'
    : status === 'connecting' || status === 'checking'
      ? 'connecting'
      : 'offline'

export function SidebarHarness({ provider }: { provider: Provider['id'] }) {
  const label = providerName(provider)
  return (
    <span
      className="grid size-3.5 shrink-0 place-items-center text-muted [&>svg]:size-3"
      title={label}
      aria-label={label}
    >
      <ProviderIcon provider={provider} />
    </span>
  )
}

export function Sidebar({
  state,
  runs,
  sessions,
  agents,
  unreadKeys,
  selectedId,
  selectedSessionKey,
  selectedAgentKey,
  selectedDraftId,
  selectedProjectKey,
  query,
  onQuery,
  onSelectRun,
  onSelectSession,
  onSelectDraft,
  onSelectAgent,
  onSelectProject,
  onRemoveProject,
  onArchiveProject,
  onTogglePin,
  onToggleArchive,
  onToggleArchiveRun,
  onRefreshProject,
  onShowMore,
  onNewRun,
  onNewProject,
  onRegisterFolder,
  onSettings,
  onArchives,
}: {
  state: AppState
  runs: Run[]
  sessions: ProviderSession[]
  agents: ReturnType<typeof observedAgents>
  unreadKeys: Set<string>
  selectedId: string | null
  selectedSessionKey: string | null
  selectedAgentKey: string | null
  selectedDraftId: string | null
  selectedProjectKey: string | null
  query: string
  onQuery: (value: string) => void
  onSelectRun: (run: Run) => void
  onSelectSession: (session: ProviderSession) => void
  onSelectDraft: (draft: DraftSession) => void
  onSelectAgent: (hostId: string, agent: DiscoveredAgent, project?: Project) => void
  onSelectProject: (project: Project) => void
  onRemoveProject: (project: Project) => void
  onArchiveProject: (project: Project) => Promise<void>
  onTogglePin: (session: ProviderSession) => Promise<void>
  onToggleArchive: (session: ProviderSession) => Promise<void>
  onToggleArchiveRun: (run: Run) => Promise<void>
  onRefreshProject: (project: Project) => Promise<void>
  onShowMore: (project: Project, visibleLimit: number) => Promise<boolean>
  onNewRun: () => void
  onNewProject: () => void
  onRegisterFolder: (hostId: string, path: string) => Promise<void>
  onSettings: () => void
  onArchives: () => void
}) {
  const [expanded, setExpanded] = useState<Set<string>>(loadExpandedProjects)
  const [projectItemLimits, setProjectItemLimits] = useState<Map<string, number>>(() => new Map())
  const [searchOpen, setSearchOpen] = useState(Boolean(query))
  const [refreshingProjects, setRefreshingProjects] = useState<Set<string>>(() => new Set())
  const [projectMenu, setProjectMenu] = useState<{
    project: Project
    top: number
    left: number
    canArchive: boolean
  } | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const preSearchScroll = useRef(0)
  const restoreSearchScroll = useRef(false)
  const searchScrollCaptured = useRef(false)
  // The Cmd-K / Cmd-N shortcut listener is registered once, so it reads both of
  // these instead of re-subscribing whenever the query or the callback changes.
  const queryRef = useLatest(query)
  const onNewRunRef = useLatest(onNewRun)
  const needle = query.trim().toLowerCase()
  const hasUnreadSession = (session: ProviderSession) =>
    unreadKeys.has(sessionNotificationKey(session)) ||
    runs.some(
      (run) =>
        run.hostId === session.hostId &&
        run.provider === session.provider &&
        run.sessionId === session.nativeSessionId &&
        runNotificationKeys(run).some((key) => unreadKeys.has(key)),
    )
  const hasUnreadRun = (run: Run) => runNotificationKeys(run).some((key) => unreadKeys.has(key))
  const unreadCount = unreadKeys.size
  const pinnedKeys = state.settings.pinnedSessionKeys
  const archivedKeys = new Set(state.settings.archivedSessionKeys)
  const archivedRunKeys = new Set(state.settings.archivedRunKeys)
  const pinnedSessions = pinnedKeys
    .map((key) => sessions.find((session) => sessionKey(session) === key))
    .filter((session): session is ProviderSession => Boolean(session))
    .filter((session) => !archivedKeys.has(sessionKey(session)))
    .filter((session) => {
      if (!needle) return true
      const project = state.projects.find(
        (item) => item.id === session.projectId && item.hostId === session.hostId,
      )
      const host = state.hosts.find((item) => item.id === session.hostId)
      return `${session.title} ${session.provider} ${project?.name || ''} ${host?.name || ''}`
        .toLowerCase()
        .includes(needle)
    })
  // Selecting anything inside a project opens it. Adjusting during render rather
  // than in an effect keeps it to a single pass, and leaves a project the user
  // collapses afterwards collapsed — the expansion is tied to the selection
  // changing, not to the selection's current value.
  const [expandedForProjectKey, setExpandedForProjectKey] = useState(selectedProjectKey)
  if (selectedProjectKey !== expandedForProjectKey) {
    setExpandedForProjectKey(selectedProjectKey)
    if (selectedProjectKey)
      setExpanded((current) => {
        if (current.has(selectedProjectKey)) return current
        const next = new Set(current).add(selectedProjectKey)
        saveStringSet('codesk.expanded-projects:v1', next)
        return next
      })
  }
  useEffect(() => {
    const target = [
      ...(scroller.current?.querySelectorAll<HTMLElement>('[data-session-key]') || []),
    ].find((item) => item.dataset.sessionKey === selectedSessionKey)
    target?.scrollIntoView({ block: 'nearest' })
  }, [selectedSessionKey])
  useEffect(() => {
    const element = scroller.current
    if (!element) return
    try {
      element.scrollTop = Number(localStorage.getItem('codesk.navigation-scroll:v1') || 0)
    } catch {}
  }, [])
  useEffect(() => {
    if (query || !restoreSearchScroll.current) return
    restoreSearchScroll.current = false
    const restore = () => {
      const element = scroller.current
      if (!element) return
      element.scrollTop = preSearchScroll.current
      try {
        localStorage.setItem('codesk.navigation-scroll:v1', String(preSearchScroll.current))
      } catch {}
    }
    restore()
    const timer = window.setTimeout(restore, 0)
    searchScrollCaptured.current = false
    return () => clearTimeout(timer)
  }, [query])
  useEffect(() => {
    const shortcuts = (event: globalThis.KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return
      if (event.key.toLowerCase() === 'k') {
        event.preventDefault()
        if (!queryRef.current && !searchScrollCaptured.current) {
          preSearchScroll.current = scroller.current?.scrollTop || 0
          searchScrollCaptured.current = true
        }
        setSearchOpen(true)
        window.setTimeout(() => searchInput.current?.focus(), 0)
      }
      if (event.key.toLowerCase() === 'n') {
        event.preventDefault()
        onNewRunRef.current()
      }
    }
    document.addEventListener('keydown', shortcuts)
    return () => document.removeEventListener('keydown', shortcuts)
  }, [onNewRunRef, queryRef])
  useEffect(() => {
    if (!projectMenu) return
    const resize = () => setProjectMenu(null)
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [projectMenu])
  const toggle = (key: string) =>
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      saveStringSet('codesk.expanded-projects:v1', next)
      return next
    })
  /// A harness only becomes a conversation once its working directory is a
  /// registered project, so agents found anywhere else would otherwise be
  /// discovered and then silently dropped from navigation.
  const [showAllDetached, setShowAllDetached] = useState(false)
  const [registeringFolder, setRegisteringFolder] = useState('')
  const createProjectDraft = async (project: Project) => {
    const key = projectKey(project)
    if (!expanded.has(key)) toggle(key)
    onSelectDraft(await api.createDraft({ hostId: project.hostId, projectId: project.id }))
  }
  const openProjectMenu = (
    event: ReactMouseEvent<HTMLElement>,
    project: Project,
    canArchive: boolean,
  ) => {
    event.preventDefault()
    event.stopPropagation()
    const rect = event.currentTarget.getBoundingClientRect()
    const width = 226
    const height = 126
    setProjectMenu({
      project,
      canArchive,
      left: Math.max(10, Math.min(window.innerWidth - width - 10, rect.right - width)),
      top: Math.max(10, Math.min(window.innerHeight - height - 10, rect.bottom + 5)),
    })
  }
  // How many items a project may list. Zero is a real budget the user can reach
  // by archiving, so a stored zero must not be mistaken for a missing entry.
  const projectItemLimit = (key: string) => itemBudget(projectItemLimits, key)
  const expandSessions = async (project: Project) => {
    const key = projectKey(project)
    const grown = budgetAfterShowMore(projectItemLimits, key)
    if (await onShowMore(project, itemBudget(grown, key))) setProjectItemLimits(grown)
  }
  // Archiving a listed conversation should shrink the list. Holding the budget
  // fixed would promote the next hidden conversation into the freed slot, so the
  // count never drops and archiving feels like it did nothing. Shrink the budget
  // with it and let Show more be the only thing that grows it again.
  const archiveSession = async (project: Project, session: ProviderSession) => {
    setProjectItemLimits((current) => budgetAfterArchive(current, projectKey(project)))
    await onToggleArchive(session)
  }
  const archiveRun = async (project: Project, run: Run) => {
    setProjectItemLimits((current) => budgetAfterArchive(current, projectKey(project)))
    await onToggleArchiveRun(run)
  }
  const refreshProject = async (project: Project) => {
    const key = projectKey(project)
    if (refreshingProjects.has(key)) return
    setRefreshingProjects((current) => new Set(current).add(key))
    setExpanded((current) => {
      if (current.has(key)) return current
      const next = new Set(current).add(key)
      saveStringSet('codesk.expanded-projects:v1', next)
      return next
    })
    try {
      await onRefreshProject(project)
    } finally {
      setRefreshingProjects((current) => {
        const next = new Set(current)
        next.delete(key)
        return next
      })
    }
  }
  const updateQuery = (value: string) => {
    if (!query && value && !searchScrollCaptured.current) {
      preSearchScroll.current = scroller.current?.scrollTop || 0
      searchScrollCaptured.current = true
    }
    const restore = Boolean(query && !value)
    if (restore) restoreSearchScroll.current = true
    onQuery(value)
  }
  const openSearch = () => {
    setSearchOpen(true)
    window.setTimeout(() => searchInput.current?.focus(), 0)
  }
  const detachedFolders = [
    ...agents
      .filter((item) => !item.project)
      .reduce((groups, item) => {
        const folder = item.agent.cwd ? normalizedFolder(item.agent.cwd) : ''
        const key = `${item.hostId}:${folder}`
        const group = groups.get(key) || {
          hostId: item.hostId,
          folder,
          providers: [] as string[],
          agents: [] as DiscoveredAgent[],
          newest: item.agent,
        }
        if (!group.providers.includes(item.agent.provider))
          group.providers.push(item.agent.provider)
        group.agents.push(item.agent)
        if (item.agent.pid > group.newest.pid) group.newest = item.agent
        groups.set(key, group)
        return groups
      }, new Map<string, { hostId: string; folder: string; providers: string[]; agents: DiscoveredAgent[]; newest: DiscoveredAgent }>())
      .values(),
  ]
    .filter(
      (group) =>
        !needle ||
        `${group.folder} ${group.providers.map(providerName).join(' ')}`
          .toLowerCase()
          .includes(needle),
    )
    .sort((left, right) => left.folder.localeCompare(right.folder))
  const projectRows = state.projects.map((project) => {
    const key = projectKey(project)
    const host = state.hosts.find((item) => item.id === project.hostId)
    const refreshing = refreshingProjects.has(key)
    const allProjectDrafts = state.drafts.filter(
      (draft) =>
        draft.projectId === project.id && draft.hostId === project.hostId && draft.prompt?.trim(),
    )
    const providerProjectSessions = sessions.filter(
      (session) => session.projectId === project.id && session.hostId === project.hostId,
    )
    const allProjectSessions = providerProjectSessions
      .filter((session) => !archivedKeys.has(sessionKey(session)))
      .sort(recentFirst)
    const allProjectRuns = runs.filter(
      (run) =>
        run.projectId === project.id &&
        run.hostId === project.hostId &&
        !archivedRunKeys.has(runRowKey(run)) &&
        (run.id === selectedId ||
          !providerProjectSessions.some((session) => session.nativeSessionId === run.sessionId)),
    )
    const projectUnread =
      allProjectSessions.some(hasUnreadSession) || allProjectRuns.some(hasUnreadRun)
    const allProjectAgents = agents.filter(
      (item) =>
        item.project &&
        projectKey(item.project) === key &&
        !providerProjectSessions.some(
          (session) => session.provider === item.agent.provider && session.status === 'running',
        ),
    )
    const projectMatches = `${project.name} ${project.path} ${host?.name || ''}`
      .toLowerCase()
      .includes(needle)
    const projectDrafts =
      !needle || projectMatches
        ? allProjectDrafts
        : allProjectDrafts.filter((draft) =>
            `${draftTitle(draft)} draft`.toLowerCase().includes(needle),
          )
    const matchingSessions =
      !needle || projectMatches
        ? allProjectSessions
        : allProjectSessions.filter((session) =>
            `${session.title} ${session.provider}`.toLowerCase().includes(needle),
          )
    const projectRuns =
      !needle || projectMatches
        ? allProjectRuns
        : allProjectRuns.filter((run) =>
            `${run.title} ${run.prompt} ${run.provider}`.toLowerCase().includes(needle),
          )
    const projectAgents =
      !needle || projectMatches
        ? allProjectAgents
        : allProjectAgents.filter(({ agent }) =>
            `${providerName(agent.provider)} ${agent.cwd || ''}`.toLowerCase().includes(needle),
          )
    if (
      needle &&
      !projectMatches &&
      !projectDrafts.length &&
      !matchingSessions.length &&
      !projectRuns.length &&
      !projectAgents.length
    )
      return null
    const open = needle ? true : expanded.has(key)
    const totalProjectItems =
      projectDrafts.length + matchingSessions.length + projectRuns.length + projectAgents.length
    const itemLimit = needle ? totalProjectItems : projectItemLimit(key)
    const unreadProjectSessions = matchingSessions.filter(hasUnreadSession)
    const unreadProjectRuns = projectRuns.filter(hasUnreadRun)
    // A running conversation keeps a slot ahead of quiet history, so the count
    // in the project header always has a row to point at.
    const runningProjectSessions = matchingSessions.filter(
      (session) => session.status === 'running' && !hasUnreadSession(session),
    )
    const activeProjectRuns = projectRuns.filter(
      (run) => active.has(run.status) && !hasUnreadRun(run),
    )
    const readProjectSessions = matchingSessions.filter(
      (session) => !hasUnreadSession(session) && session.status !== 'running',
    )
    const readProjectRuns = projectRuns.filter(
      (run) => !hasUnreadRun(run) && !active.has(run.status),
    )
    let slotsRemaining = itemLimit
    const visibleUnreadSessions = unreadProjectSessions.slice(0, slotsRemaining)
    slotsRemaining -= visibleUnreadSessions.length
    const visibleUnreadRuns = unreadProjectRuns.slice(0, slotsRemaining)
    slotsRemaining -= visibleUnreadRuns.length
    const visibleRunningSessions = runningProjectSessions.slice(0, slotsRemaining)
    slotsRemaining -= visibleRunningSessions.length
    const visibleActiveRuns = activeProjectRuns.slice(0, slotsRemaining)
    slotsRemaining -= visibleActiveRuns.length
    const visibleProjectDrafts = projectDrafts.slice(0, slotsRemaining)
    slotsRemaining -= visibleProjectDrafts.length
    const visibleReadSessions = readProjectSessions.slice(0, slotsRemaining)
    slotsRemaining -= visibleReadSessions.length
    const visibleReadRuns = readProjectRuns.slice(0, slotsRemaining)
    slotsRemaining -= visibleReadRuns.length
    const visibleProjectAgents = projectAgents.slice(0, slotsRemaining)
    const visibleProjectSessions = [
      ...visibleUnreadSessions,
      ...visibleRunningSessions,
      ...visibleReadSessions,
    ]
    const visibleProjectRuns = [...visibleUnreadRuns, ...visibleActiveRuns, ...visibleReadRuns]
    const runningSessions = matchingSessions.filter((session) => session.status === 'running')
    const runningCount = runningSessions.length
    const projectOnlySelected =
      selectedProjectKey === key &&
      !selectedId &&
      !selectedSessionKey &&
      !selectedAgentKey &&
      !selectedDraftId
    return (
      <div
        className={cn(
          'group/project [contain-intrinsic-size:auto_31px] [content-visibility:auto]',
          host?.status !== 'online' && 'opacity-[0.72]',
        )}
        key={key}
        role="treeitem"
        aria-expanded={open}
        aria-selected={projectOnlySelected}
      >
        <div
          className={cn(
            'flex h-[31px] items-center gap-1 rounded-[7px] pr-[5px] pl-px text-fg-soft hover:bg-ink-700',
            projectOnlySelected && 'bg-ink-600',
            projectMenu?.project.id === project.id &&
              projectMenu.project.hostId === project.hostId &&
              'bg-ink-600',
          )}
          onContextMenu={(event) => openProjectMenu(event, project, allProjectSessions.length > 0)}
        >
          <button
            className="grid h-[27px] w-4 shrink-0 place-items-center text-dim hover:text-fg-soft"
            aria-label={`${open ? 'Collapse' : 'Expand'} ${project.name}`}
            onClick={() => toggle(key)}
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
                if (!open) toggle(key)
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
              void refreshProject(project)
            }}
          >
            <RefreshCw className={cn(refreshing && 'animate-spin')} size={13} />
          </button>
          <button
            className="grid size-[21px] shrink-0 place-items-center rounded-sm text-muted opacity-0 hover:bg-ink-500 hover:text-fg focus-visible:opacity-100 group-hover/project:opacity-100 aria-expanded:opacity-100"
            aria-label={`Project actions for ${project.name}`}
            aria-controls="project-actions-menu"
            aria-expanded={
              projectMenu?.project.id === project.id &&
              projectMenu.project.hostId === project.hostId
            }
            title={`Project actions for ${project.name}`}
            onClick={(event) => openProjectMenu(event, project, allProjectSessions.length > 0)}
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
              const pinned = pinnedKeys.includes(sessionId)
              const unread = hasUnreadSession(session)
              return (
                <div className="group relative flex min-h-7 min-w-0" key={sessionId}>
                  <button
                    data-session-key={sessionId}
                    className={cn(
                      sessionRow,
                      session.status === 'running' && 'bg-grass-950/70 hover:bg-grass-950',
                      sessionId === selectedSessionKey && 'bg-ink-600',
                    )}
                    title={`${providerName(session.provider)} · ${session.title}`}
                    onClick={() => onSelectSession(session)}
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
                      ) : session.status === 'stopped' ? (
                        <Circle
                          className="drop-shadow-[0_0_3px_#e54848]"
                          size={7}
                          fill="currentColor"
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
                    onClick={() => void archiveSession(project, session)}
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
            })}
            {visibleProjectRuns.map((run) => {
              const unread = hasUnreadRun(run)
              return (
                <div
                  className="group relative flex min-h-7 min-w-0"
                  key={`${run.hostId}:${run.id}`}
                >
                  <button
                    className={cn(sessionRow, run.id === selectedId && 'bg-ink-600')}
                    title={`${providerName(run.provider)} · ${run.title}`}
                    onClick={() => onSelectRun(run)}
                  >
                    <span
                      className={cn(
                        recentStatus,
                        active.has(run.status) ? 'text-grass-400' : 'text-muted',
                      )}
                    >
                      {active.has(run.status) ? (
                        <Spinner />
                      ) : (
                        <Circle size={7} fill="currentColor" />
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
                    onClick={() => void archiveRun(project, run)}
                  >
                    <Archive size={12} />
                  </button>
                </div>
              )
            })}
            {visibleProjectAgents.map(({ hostId, agent }) => (
              <button
                key={`${hostId}:${agent.id}`}
                className={cn(
                  sessionRow,
                  'pr-1.5',
                  `${hostId}:${agent.id}` === selectedAgentKey && 'bg-ink-600',
                )}
                onClick={() => onSelectAgent(hostId, agent, project)}
              >
                <span className={cn(recentStatus, 'text-amber-signal-500')}>
                  <Spinner />
                </span>
                <span className={rowTitle}>
                  <SidebarHarness provider={agent.provider} />
                  <span className="min-w-0 truncate">Observed session</span>
                </span>
                <small className={rowMeta}>observed</small>
              </button>
            ))}
            {!needle && hasHiddenItems(totalProjectItems, itemLimit) && (
              <button
                className="h-[25px] w-full pr-1.5 pl-[29px] text-left text-[10.5px] text-muted hover:text-fg-soft"
                onClick={() => void expandSessions(project)}
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
  return (
    <aside className="flex min-h-0 flex-col border-r border-ink-650 bg-sidebar pt-[13px] pr-0 pb-[9px] pl-2">
      <div className="flex h-[38px] items-center gap-[7px] pr-2 pl-1.5">
        <img
          className="size-[25px] shrink-0 rounded-[7px] object-cover shadow-[0_0_0_1px_#ffffff1c]"
          src={logoUrl}
          alt=""
        />
        <strong className="text-[17px] tracking-[-0.2px]">Codesk</strong>
        <ChevronDown size={14} />
        <span className="flex-1" />
        <button className={iconButton} title="Search conversations" onClick={openSearch}>
          <Search size={17} />
        </button>
        <button
          className={cn(iconButton, 'relative')}
          title={unreadCount ? `${unreadCount} unread agent updates` : 'Notifications'}
          aria-label={unreadCount ? `${unreadCount} unread agent updates` : 'Notifications'}
        >
          <Bell size={17} />
          {unreadCount > 0 && (
            <i className="absolute -top-[3px] -right-1 grid h-[13px] min-w-[13px] place-items-center rounded-full border-2 border-sidebar bg-scarlet-400 px-[3px] text-[8px] leading-none font-bold text-white not-italic">
              {unreadCount > 9 ? '9+' : unreadCount}
            </i>
          )}
        </button>
      </div>
      <button className={sideAction} onClick={onNewRun}>
        <Plus size={17} />
        New chat
      </button>
      <button className={sideAction}>
        <GitBranch size={17} />
        Pull requests
      </button>
      <button className={sideAction}>
        <Clock3 size={17} />
        Scheduled
      </button>
      <button className={sideAction}>
        <Plug size={17} />
        Plugins
      </button>
      <div
        className="scroll-thin min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain pb-[7px]"
        ref={scroller}
        onScroll={(event) => {
          setProjectMenu(null)
          if (needle || restoreSearchScroll.current) return
          try {
            localStorage.setItem(
              'codesk.navigation-scroll:v1',
              String(event.currentTarget.scrollTop),
            )
          } catch {}
        }}
      >
        <div
          className={cn(
            'mx-[7px] flex items-center gap-[7px] overflow-hidden rounded-md border border-transparent px-2 text-dim transition-all duration-150',
            'focus-within:border-line-strong focus-within:bg-ink-850',
            searchOpen || query
              ? 'pointer-events-auto my-[3px] mb-0.5 h-[29px] opacity-100'
              : 'pointer-events-none my-0 h-0 opacity-0',
          )}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node) && !query)
              setSearchOpen(false)
          }}
        >
          <Search size={13} />
          <input
            ref={searchInput}
            aria-label="Search projects and conversations"
            value={query}
            onPointerDown={() => {
              if (!query && !searchScrollCaptured.current) {
                preSearchScroll.current = scroller.current?.scrollTop || 0
                searchScrollCaptured.current = true
              }
            }}
            onFocus={() => {
              setSearchOpen(true)
              if (!query && !searchScrollCaptured.current) {
                preSearchScroll.current = scroller.current?.scrollTop || 0
                searchScrollCaptured.current = true
              }
            }}
            className="min-w-0 flex-1 border-0 bg-transparent text-xs outline-none"
            onChange={(event) => updateQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                updateQuery('')
                setSearchOpen(false)
                event.currentTarget.blur()
              }
            }}
            placeholder="Search"
          />
          {query && (
            <button
              className={cn(iconButton, 'size-[22px] shrink-0')}
              title="Clear search"
              onClick={() => updateQuery('')}
            >
              <X size={12} />
            </button>
          )}
        </div>
        {pinnedSessions.length > 0 && (
          <section className="min-w-0" aria-label="Pinned conversations">
            <div className={sideHeading}>
              <span className="flex-1">Pinned</span>
            </div>
            {pinnedSessions.map((session) => {
              const key = sessionKey(session)
              const project = state.projects.find(
                (item) => item.id === session.projectId && item.hostId === session.hostId,
              )
              const host = state.hosts.find((item) => item.id === session.hostId)
              return (
                <div className="group relative flex min-w-0" key={key}>
                  <button
                    data-session-key={key}
                    className={cn(
                      'flex h-[39px] min-w-0 flex-1 items-center gap-2 rounded-md py-0 pl-2 text-left text-fg-soft transition-[padding]',
                      'pr-2 group-hover:pr-[31px] group-focus-within:pr-[31px] hover:bg-ink-600',
                      key === selectedSessionKey && 'bg-ink-600',
                    )}
                    title={`${providerName(session.provider)} · ${project?.name || session.cwd} · ${host?.name || session.hostId}`}
                    onClick={() => onSelectSession(session)}
                    onContextMenu={(event) => {
                      event.preventDefault()
                      void onTogglePin(session)
                    }}
                  >
                    <Pin size={12} className="shrink-0 text-muted" />
                    <span className="min-w-0">
                      <strong className="flex items-center gap-1 truncate text-[13px] font-medium">
                        <SidebarHarness provider={session.provider} />
                        {hasUnreadSession(session) && (
                          <i
                            className={cn(unreadDot, 'ml-px')}
                            title="Unread agent update"
                            aria-label="Unread agent update"
                          />
                        )}
                        <span className="min-w-0 truncate">{session.title}</span>
                      </strong>
                      <small className="mt-0.5 block truncate text-[10px] text-dim">
                        {project?.name || 'Unknown project'} · {host?.name || session.hostId}
                      </small>
                    </span>
                  </button>
                  <button
                    className={cn(rowAffordance, 'right-1 opacity-100')}
                    title="Unpin conversation"
                    onClick={() => void onTogglePin(session)}
                  >
                    <PinOff size={12} />
                  </button>
                </div>
              )
            })}
          </section>
        )}
        {detachedFolders.length > 0 && (
          <section className="min-w-0" aria-label="Agents outside your projects">
            <div className={sideHeading}>
              <span className="flex-1">Outside your projects</span>
            </div>
            {(showAllDetached
              ? detachedFolders
              : detachedFolders.slice(0, DETACHED_FOLDER_PREVIEW)
            ).map((group) => {
              const host = state.hosts.find((item) => item.id === group.hostId)
              const folderKey = `${group.hostId}:${group.folder}`
              const label =
                group.folder.split('/').filter(Boolean).at(-1) || group.folder || 'Unknown folder'
              const agentKey = `${group.hostId}:${group.newest.id}`
              return (
                <div className="group relative flex min-w-0" key={folderKey}>
                  <button
                    className={cn(
                      'flex h-[31px] min-w-0 flex-1 items-center gap-1.5 rounded-md py-0 pr-[26px] pl-2 text-left text-fg-soft hover:bg-ink-600',
                      agentKey === selectedAgentKey && 'bg-ink-600',
                    )}
                    title={`${group.agents.length} running ${group.agents.length === 1 ? 'agent' : 'agents'} in ${group.folder || 'an unreported folder'} · ${host?.name || group.hostId}`}
                    onClick={() => onSelectAgent(group.hostId, group.newest)}
                  >
                    <span className={cn(recentStatus, 'text-amber-signal-500')}>
                      <Spinner />
                    </span>
                    <span className={rowTitle}>
                      {group.providers.map((provider) => (
                        <SidebarHarness key={provider} provider={provider} />
                      ))}
                      <span className="min-w-0 truncate">{label}</span>
                    </span>
                    {group.agents.length > 1 && (
                      <small className="shrink-0 text-[9px] text-dim">{group.agents.length}</small>
                    )}
                  </button>
                  <button
                    className={cn(
                      rowAffordance,
                      'right-[3px] disabled:cursor-default disabled:opacity-45',
                    )}
                    disabled={!group.folder || registeringFolder === folderKey}
                    title={
                      group.folder
                        ? `Add ${group.folder} as a project`
                        : 'This agent did not report a working directory'
                    }
                    aria-label={
                      group.folder
                        ? `Add ${group.folder} as a project`
                        : 'No working directory to add'
                    }
                    onClick={async () => {
                      setRegisteringFolder(folderKey)
                      try {
                        await onRegisterFolder(group.hostId, group.folder)
                      } finally {
                        setRegisteringFolder('')
                      }
                    }}
                  >
                    {registeringFolder === folderKey ? (
                      <RefreshCw className="animate-spin" size={12} />
                    ) : (
                      <Plus size={13} />
                    )}
                  </button>
                </div>
              )
            })}
            {detachedFolders.length > DETACHED_FOLDER_PREVIEW && (
              <button
                className="h-[25px] w-full pr-1.5 pl-[29px] text-left text-[10.5px] text-muted hover:text-fg-soft"
                onClick={() => setShowAllDetached((value) => !value)}
              >
                {showAllDetached
                  ? 'Show less'
                  : `Show ${detachedFolders.length - DETACHED_FOLDER_PREVIEW} more`}
              </button>
            )}
          </section>
        )}
        <section className="min-w-0" aria-label="Projects">
          <div className={sideHeading}>
            <span className="flex-1">Projects</span>
            <button className={iconButton} title="Add project" onClick={onNewProject}>
              <Plus size={15} />
            </button>
          </div>
          <div className="min-w-0 pr-0.5" role="tree">
            {projectRows}
            {needle && projectRows.every((row) => row === null) && (
              <div className="px-4 py-6 text-center text-[11px] leading-relaxed text-dim">
                No matching projects or conversations
              </div>
            )}
          </div>
        </section>
      </div>
      {/* Radix owns dismissal, focus and collision handling; the stored point
          only anchors the menu where the row was clicked. */}
      <DropdownMenu
        open={Boolean(projectMenu)}
        onOpenChange={(open) => !open && setProjectMenu(null)}
      >
        <DropdownMenuTrigger
          aria-hidden
          tabIndex={-1}
          className="pointer-events-none fixed"
          style={{ top: projectMenu?.top ?? 0, left: projectMenu?.left ?? 0 }}
        />
        {projectMenu && (
          <DropdownMenuContent
            id="project-actions-menu"
            align="start"
            sideOffset={0}
            className="w-[226px]"
            aria-label={`Actions for ${projectMenu.project.name}`}
          >
            <DropdownMenuItem
              onSelect={() => {
                const next = projectMenu.project
                setProjectMenu(null)
                void createProjectDraft(next)
              }}
            >
              <Plus size={15} className="text-muted" />
              <span>New chat</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!projectMenu.canArchive}
              onSelect={() => {
                const next = projectMenu.project
                setProjectMenu(null)
                void onArchiveProject(next)
              }}
            >
              <Archive size={15} className="text-muted" />
              <span>Archive chats</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              destructive
              onSelect={() => {
                const next = projectMenu.project
                setProjectMenu(null)
                onRemoveProject(next)
              }}
            >
              <Trash2 size={15} />
              <span>Remove project</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        )}
      </DropdownMenu>
      <div className="shrink-0 border-t border-ink-600 bg-sidebar pt-[5px] pr-2">
        <button className={cn(sideAction, 'h-[35px] text-[13.5px]')} onClick={onSettings}>
          <Settings2 size={17} />
          <span>Gateway / Settings</span>
        </button>
        <button className={cn(sideAction, 'h-[35px] text-[13.5px]')} onClick={onArchives}>
          <Archive size={17} />
          <span>Archived chats</span>
          {state.settings.archivedSessionKeys.length + state.settings.archivedRunKeys.length >
            0 && (
            <small className="ml-auto grid h-[19px] min-w-[19px] place-items-center rounded-full bg-ink-600 px-1 text-[10px] text-fg-soft">
              {state.settings.archivedSessionKeys.length + state.settings.archivedRunKeys.length}
            </small>
          )}
        </button>
      </div>
    </aside>
  )
}
