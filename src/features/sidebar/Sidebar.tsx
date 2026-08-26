import {
  Archive,
  Bell,
  ChevronDown,
  ChevronRight,
  Clock3,
  Eye,
  EyeOff,
  GitBranch,
  Pin,
  PinOff,
  Plug,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Square,
  Trash2,
  X,
  XCircle,
} from 'lucide-react'

import { api } from '../../api'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu'
import { useLatest } from '../../hooks/useLatest'
import { cn } from '../../lib/cn'
import { DETACHED_FOLDER_PREVIEW, logoUrl, observedAgents } from '../../lib/app-state'
import { normalizedFolder, projectKey, sessionKey } from '../../lib/keys'
import { hiddenAgentKey, observedAgentTitle, observedAgentTooltip } from '../../lib/observed'
import { loadExpandedProjects, saveStringSet } from '../../lib/storage'
import { providerName } from '../../lib/providers'
import { budgetAfterArchive, budgetAfterShowMore, itemBudget } from '../../sessionBudget'
import type {
  AppState,
  DiscoveredAgent,
  DraftSession,
  Project,
  ProviderSession,
  Run,
} from '../../types'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { ProjectRow } from './ProjectRow'
import { recentStatus, rowAffordance, rowTitle, unreadDot } from './row-styles'
import { SidebarHarness } from './SidebarHarness'
import { useProjectRows } from './useProjectRows'

export { SidebarHarness } from './SidebarHarness'

const sideAction =
  'flex h-[34px] w-full items-center gap-[9px] rounded-[7px] px-[7px] text-[13px] text-fg-soft hover:bg-ink-650'
const sideHeading = 'flex h-8 items-end gap-1 px-[7px] pb-1.5 text-[11.5px] text-dim'
const iconButton = 'grid place-items-center text-muted hover:text-fg'

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
  onHideAgent,
  onControlAgent,
  onRefreshProject,
  onShowMore,
  onNewRun,
  onNewProject,
  onRegisterFolder,
  onSettings,
  onArchives,
  onJumpToUnread,
  onClose,
  className,
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
  onHideAgent: (hostId: string, agent: DiscoveredAgent) => Promise<void>
  onControlAgent: (
    hostId: string,
    agent: DiscoveredAgent,
    action: 'interrupt' | 'terminate',
  ) => Promise<void>
  onRefreshProject: (project: Project) => Promise<void>
  onShowMore: (project: Project, visibleLimit: number) => Promise<boolean>
  onNewRun: () => void
  onNewProject: () => void
  onRegisterFolder: (hostId: string, path: string) => Promise<void>
  onSettings: () => void
  onArchives: () => void
  onJumpToUnread: () => void
  onClose?: () => void
  className?: string
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
  const [agentMenu, setAgentMenu] = useState<{
    hostId: string
    agent: DiscoveredAgent
    hidden: boolean
    top: number
    left: number
  } | null>(null)
  const [showHiddenAgents, setShowHiddenAgents] = useState(false)
  const [detachedOpen, setDetachedOpen] = useState(false)
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
  const hiddenAgentKeys = state.settings.hiddenAgentKeys
  const hiddenKeys = new Set(hiddenAgentKeys)
  const hiddenCount = agents.filter((item) =>
    hiddenKeys.has(hiddenAgentKey(item.hostId, item.agent)),
  ).length
  const visibleAgents =
    showHiddenAgents || hiddenCount === 0
      ? agents
      : agents.filter((item) => !hiddenKeys.has(hiddenAgentKey(item.hostId, item.agent)))
  const { rows, hasUnreadSession, hasUnreadRun } = useProjectRows({
    projects: state.projects,
    hosts: state.hosts,
    drafts: state.drafts,
    sessions,
    runs,
    unreadKeys,
    archivedSessionKeys: state.settings.archivedSessionKeys,
    archivedRunKeys: state.settings.archivedRunKeys,
    needle,
    expanded,
    projectItemLimits,
    selectedId,
  })
  const unreadCount = unreadKeys.size
  const pinnedKeys = state.settings.pinnedSessionKeys
  const archivedKeys = new Set(state.settings.archivedSessionKeys)
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
  const toggle = useCallback(
    (key: string) =>
      setExpanded((current) => {
        const next = new Set(current)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        saveStringSet('codesk.expanded-projects:v1', next)
        return next
      }),
    [],
  )
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
  const openProjectMenu = useCallback(
    (event: ReactMouseEvent<HTMLElement>, project: Project, canArchive: boolean) => {
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
    },
    [],
  )
  const openAgentMenu = useCallback(
    (event: ReactMouseEvent<HTMLElement>, hostId: string, agent: DiscoveredAgent) => {
      event.preventDefault()
      event.stopPropagation()
      const rect = event.currentTarget.getBoundingClientRect()
      const width = 226
      const height = 148
      setAgentMenu({
        hostId,
        agent,
        hidden: hiddenAgentKeys.includes(hiddenAgentKey(hostId, agent)),
        left: Math.max(10, Math.min(window.innerWidth - width - 10, rect.right - width)),
        top: Math.max(10, Math.min(window.innerHeight - height - 10, rect.bottom + 5)),
      })
    },
    [hiddenAgentKeys],
  )
  const expandSessions = useCallback(
    async (project: Project) => {
      const key = projectKey(project)
      const grown = budgetAfterShowMore(projectItemLimits, key)
      if (await onShowMore(project, itemBudget(grown, key))) setProjectItemLimits(grown)
    },
    [onShowMore, projectItemLimits],
  )
  // Archiving a listed conversation should shrink the list. Holding the budget
  // fixed would promote the next hidden conversation into the freed slot, so the
  // count never drops and archiving feels like it did nothing. Shrink the budget
  // with it and let Show more be the only thing that grows it again.
  const archiveSession = useCallback(
    async (project: Project, session: ProviderSession) => {
      setProjectItemLimits((current) => budgetAfterArchive(current, projectKey(project)))
      await onToggleArchive(session)
    },
    [onToggleArchive],
  )
  const archiveRun = useCallback(
    async (project: Project, run: Run) => {
      setProjectItemLimits((current) => budgetAfterArchive(current, projectKey(project)))
      await onToggleArchiveRun(run)
    },
    [onToggleArchiveRun],
  )
  const refreshProject = useCallback(
    async (project: Project) => {
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
    },
    [onRefreshProject, refreshingProjects],
  )
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
    ...visibleAgents
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
  const detachedSelected = Boolean(
    selectedAgentKey &&
      detachedFolders.some((group) => `${group.hostId}:${group.newest.id}` === selectedAgentKey),
  )
  const detachedExpanded = Boolean(needle) || detachedOpen || detachedSelected
  // One block per host, local hosts first, so remote agents read as "this
  // machine's stray sessions" instead of an unattributed flat list.
  const previewDetached = showAllDetached
    ? detachedFolders
    : detachedFolders.slice(0, DETACHED_FOLDER_PREVIEW)
  const detachedHostGroups = [
    ...previewDetached
      .reduce((byHost, group) => {
        const list = byHost.get(group.hostId) || []
        list.push(group)
        byHost.set(group.hostId, list)
        return byHost
      }, new Map<string, typeof previewDetached>())
      .entries(),
  ].sort(([leftId], [rightId]) => {
    const left = state.hosts.find((item) => item.id === leftId)
    const right = state.hosts.find((item) => item.id === rightId)
    if ((left?.type === 'local') !== (right?.type === 'local'))
      return left?.type === 'local' ? -1 : 1
    return (left?.name || leftId).localeCompare(right?.name || rightId)
  })
  return (
    <aside
      className={cn(
        'flex h-full min-h-0 flex-col border-r border-ink-650 bg-sidebar pt-[13px] pr-0 pb-[9px] pl-2',
        className,
      )}
    >
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
        {/* With unread updates the bell jumps straight to the conversation the
            badge counts; otherwise archives is the closest thing to a
            notification list until a dedicated center exists. */}
        <button
          className={cn(iconButton, 'relative')}
          title={
            unreadCount ? `${unreadCount} unread agent updates — click to open` : 'Notifications'
          }
          aria-label={
            unreadCount ? `${unreadCount} unread agent updates — click to open` : 'Notifications'
          }
          onClick={unreadCount ? onJumpToUnread : onArchives}
        >
          <Bell size={17} />
          {unreadCount > 0 && (
            <i className="absolute -top-[3px] -right-1 grid h-[13px] min-w-[13px] place-items-center rounded-full border-2 border-sidebar bg-scarlet-400 px-[3px] text-[8px] leading-none font-bold text-white not-italic">
              {unreadCount > 9 ? '9+' : unreadCount}
            </i>
          )}
        </button>
        {onClose && (
          <button
            className={cn(iconButton, 'md:hidden')}
            title="Close sidebar"
            aria-label="Close sidebar"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        )}
      </div>
      <button className={sideAction} onClick={onNewRun}>
        <Plus size={17} />
        New chat
      </button>
      {/* Disabled until implemented: a clickable control that does nothing
          reads as broken rather than upcoming. */}
      <button className={sideAction} title="Coming soon" disabled>
        <GitBranch size={17} />
        Pull requests
      </button>
      <button className={sideAction} title="Coming soon" disabled>
        <Clock3 size={17} />
        Scheduled
      </button>
      <button className={sideAction} title="Coming soon" disabled>
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
        {(detachedFolders.length > 0 || hiddenCount > 0) && (
          <section className="min-w-0" aria-label="Agents outside your projects">
            <button
              className={cn(sideHeading, 'w-full cursor-pointer hover:text-fg-soft')}
              aria-expanded={detachedExpanded}
              onClick={() => setDetachedOpen((value) => !value)}
            >
              {detachedExpanded ? (
                <ChevronDown size={12} className="mb-px" />
              ) : (
                <ChevronRight size={12} className="mb-px" />
              )}
              <span className="flex-1 text-left">Outside your projects</span>
              <small className="tabular-nums">{detachedFolders.length}</small>
            </button>
            {detachedExpanded &&
              detachedHostGroups.map(([groupHostId, hostFolders]) => {
                const host = state.hosts.find((item) => item.id === groupHostId)
                return (
                  <div key={groupHostId} className="min-w-0">
                    <div
                      className="flex h-[22px] items-center gap-1.5 pl-2 text-[9.5px] text-muted"
                      title={host?.status || 'offline'}
                    >
                      <span className="truncate">{host?.name || groupHostId}</span>
                      {host?.type === 'ssh' && <span className="text-dim">· remote</span>}
                    </div>
                    {hostFolders.map((group) => {
                      const folderKey = `${group.hostId}:${group.folder}`
                      const folderLabel =
                        group.folder.split('/').filter(Boolean).at(-1) ||
                        group.folder ||
                        'Unknown folder'
                      const label =
                        group.agents.length === 1 ? observedAgentTitle(group.newest) : folderLabel
                      const agentKey = `${group.hostId}:${group.newest.id}`
                      return (
                        <div className="group relative flex min-w-0" key={folderKey}>
                          <button
                            className={cn(
                              'flex h-[31px] min-w-0 flex-1 items-center gap-1.5 rounded-md py-0 pr-[26px] pl-4 text-left text-fg-soft hover:bg-ink-600',
                              agentKey === selectedAgentKey && 'bg-ink-600',
                            )}
                            title={
                              group.agents.length === 1
                                ? `${observedAgentTooltip(group.newest)} · ${host?.name || group.hostId}`
                                : `${group.agents.length} agents in ${group.folder || 'an unreported folder'} · ${host?.name || group.hostId}`
                            }
                            onClick={() => onSelectAgent(group.hostId, group.newest)}
                            onContextMenu={(event) =>
                              openAgentMenu(event, group.hostId, group.newest)
                            }
                          >
                            <span className={cn(recentStatus, 'text-amber-signal-500')}>
                              <span className="size-1.5 rounded-full bg-current" />
                            </span>
                            <span className={rowTitle}>
                              {group.providers.map((provider) => (
                                <SidebarHarness key={provider} provider={provider} />
                              ))}
                              <span className="min-w-0 truncate">{label}</span>
                            </span>
                            {group.agents.length > 1 && (
                              <small className="shrink-0 text-[9px] text-dim">
                                {group.agents.length}
                              </small>
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
                  </div>
                )
              })}
            {detachedExpanded && detachedFolders.length > DETACHED_FOLDER_PREVIEW && (
              <button
                className="h-[25px] w-full pr-1.5 pl-[29px] text-left text-[10.5px] text-muted hover:text-fg-soft"
                onClick={() => setShowAllDetached((value) => !value)}
              >
                {showAllDetached
                  ? 'Show less'
                  : `Show ${detachedFolders.length - DETACHED_FOLDER_PREVIEW} more`}
              </button>
            )}
            {detachedExpanded && hiddenCount > 0 && (
              <button
                className="h-[25px] w-full pr-1.5 pl-[29px] text-left text-[10.5px] text-muted hover:text-fg-soft"
                onClick={() => setShowHiddenAgents((value) => !value)}
              >
                {showHiddenAgents ? 'Hide hidden agents' : `Show hidden (${hiddenCount})`}
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
            {rows.map((row) => (
              <ProjectRow
                key={row.key}
                row={row}
                needle={needle}
                selectedId={selectedId}
                selectedSessionKey={selectedSessionKey}
                selectedDraftId={selectedDraftId}
                projectOnlySelected={
                  selectedProjectKey === row.key &&
                  !selectedId &&
                  !selectedSessionKey &&
                  !selectedAgentKey &&
                  !selectedDraftId
                }
                menuOpen={
                  projectMenu?.project.id === row.project.id &&
                  projectMenu.project.hostId === row.project.hostId
                }
                refreshing={refreshingProjects.has(row.key)}
                pinnedKeys={pinnedKeys}
                hasUnreadSession={hasUnreadSession}
                hasUnreadRun={hasUnreadRun}
                onToggle={toggle}
                onSelectProject={onSelectProject}
                onSelectDraft={onSelectDraft}
                onSelectSession={onSelectSession}
                onSelectRun={onSelectRun}
                onTogglePin={onTogglePin}
                onArchiveSession={archiveSession}
                onArchiveRun={archiveRun}
                onOpenMenu={openProjectMenu}
                onRefresh={refreshProject}
                onShowMore={expandSessions}
              />
            ))}
            {needle && rows.length === 0 && (
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
      <DropdownMenu open={Boolean(agentMenu)} onOpenChange={(open) => !open && setAgentMenu(null)}>
        <DropdownMenuTrigger
          aria-hidden
          tabIndex={-1}
          className="pointer-events-none fixed"
          style={{ top: agentMenu?.top ?? 0, left: agentMenu?.left ?? 0 }}
        />
        {agentMenu && (
          <DropdownMenuContent
            align="start"
            sideOffset={0}
            className="w-[226px]"
            aria-label={`Actions for ${observedAgentTitle(agentMenu.agent)}`}
          >
            <DropdownMenuItem
              onSelect={() => {
                const next = agentMenu
                setAgentMenu(null)
                void onHideAgent(next.hostId, next.agent)
              }}
            >
              {agentMenu.hidden ? (
                <Eye size={15} className="text-muted" />
              ) : (
                <EyeOff size={15} className="text-muted" />
              )}
              <span>{agentMenu.hidden ? 'Unhide' : 'Hide'}</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => {
                const next = agentMenu
                setAgentMenu(null)
                void onControlAgent(next.hostId, next.agent, 'interrupt')
              }}
            >
              <Square size={15} className="text-muted" />
              <span>Interrupt</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              destructive
              onSelect={() => {
                const next = agentMenu
                setAgentMenu(null)
                void onControlAgent(next.hostId, next.agent, 'terminate')
              }}
            >
              <XCircle size={15} />
              <span>Terminate</span>
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
