import { RemoveProjectDialog } from './features/dialogs/RemoveProjectDialog'
import { RunScreen } from './features/screens/RunScreen'
import { ArchivedChatsDialog } from './features/dialogs/ArchivedChatsDialog'
import { ConnectionsDialog } from './features/dialogs/ConnectionsDialog'
import { ProjectDialog } from './features/dialogs/ProjectDialog'
import { ObservedScreen } from './features/screens/ObservedScreen'
import { SessionScreen } from './features/screens/SessionScreen'
import { StartScreen } from './features/screens/StartScreen'
import { Sidebar } from './features/sidebar/Sidebar'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { api } from './api'
import { cn } from './lib/cn'
import type { AppState, DiscoveredAgent, Project, ProviderSession, Run } from './types'
import { useLatest } from './hooks/useLatest'
import { empty, observedAgents } from './lib/app-state'
import {
  projectKey,
  recentFirst,
  runNotificationKeys,
  runRowKey,
  sessionKey,
  sessionNotificationKey,
} from './lib/keys'
import { hiddenAgentKey } from './lib/observed'
import { prepareNotifications } from './lib/notifications'
import { forgetSessionFinishSeen } from './lib/session-finish'
import { applyTheme, rememberTheme, watchSystemTheme } from './lib/theme'
import type { ThemePreference } from './lib/theme'
import { useAppStatePolling } from './hooks/useAppStatePolling'
import { useExternalTranscriptWatcher } from './hooks/useExternalTranscriptWatcher'
import { useRunEventStream } from './hooks/useRunEventStream'
import { useSelection } from './hooks/useSelection'
import { useSessionMessagesPoller } from './hooks/useSessionMessagesPoller'
import { useUnreadNotifications } from './hooks/useUnreadNotifications'

export function App() {
  const [state, setState] = useState<AppState>(empty)
  const [query, setQuery] = useState('')
  const [extraSessions, setExtraSessions] = useState<Record<string, ProviderSession[]>>({})
  const [newProject, setNewProject] = useState(false)
  const [settings, setSettings] = useState(false)
  const [archives, setArchives] = useState(false)
  const [projectToRemove, setProjectToRemove] = useState<Project | null>(null)
  const [removingProject, setRemovingProject] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const toggleSidebar = useCallback(() => setSidebarOpen((open) => !open), [])
  const closeSidebar = useCallback(() => setSidebarOpen(false), [])
  const [error, setError] = useState('')
  // Shared between the transcript watcher (which records when a turn
  // completion was announced) and the unread bookkeeping (which suppresses the
  // later session-stopped announcement for the same turn).
  const sessionCompletionNotifiedAt = useRef<Map<string, number>>(new Map())
  // Long-lived pollers and socket handlers are set up once and must not tear
  // down every time state changes, so they read this instead of closing over
  // the value directly.
  const stateRef = useLatest(state)
  const {
    unreadKeys,
    addUnread,
    clearUnread,
    readRun,
    readSession,
    rememberNotification,
    notifyRunEvent,
    noticeStatusChanges,
    reconcileUnread,
    notified,
  } = useUnreadNotifications({ stateRef, sessionCompletionNotifiedAt })
  const allSessions = useMemo(() => {
    const merged = new Map(
      [...state.settings.pinnedSessions, ...state.settings.archivedSessions, ...state.sessions].map(
        (item) => [sessionKey(item), item],
      ),
    )
    for (const items of Object.values(extraSessions))
      for (const item of items) merged.set(sessionKey(item), item)
    return [...merged.values()]
  }, [
    state.sessions,
    state.settings.pinnedSessions,
    state.settings.archivedSessions,
    extraSessions,
  ])
  // A new turn must be allowed to show the just-finished circle again, even
  // if the previous one was already checked. Session rows may be unmounted
  // (collapsed project), so this lives above the sidebar.
  useEffect(() => {
    for (const item of allSessions) {
      if (item.status === 'running') forgetSessionFinishSeen(sessionNotificationKey(item))
    }
  }, [allSessions])
  const {
    selectedId,
    setSelectedId,
    selectedSessionKey,
    setSelectedSessionKey,
    selectedAgentKey,
    setSelectedAgentKey,
    selectedDraftId,
    setSelectedDraftId,
    selectedProjectKey,
    setSelectedProjectKey,
    run,
    initialized,
    selectedRunRef,
    initializeSelection,
    clearSelectedRun,
    selectProject,
    selectRun,
    selectSession,
    selectDraft,
    selectAgent,
  } = useSelection({ state, setState, stateRef, allSessions })
  const { reload } = useAppStatePolling({
    setState,
    setExtraSessions,
    setError,
    reconcileUnread,
    noticeStatusChanges,
    initializeSelection,
    initialized,
    selectedRunRef,
  })
  const session =
    [
      ...state.sessions,
      ...Object.values(extraSessions).flat(),
      ...state.settings.pinnedSessions,
      ...state.settings.archivedSessions,
    ].find((item) => sessionKey(item) === selectedSessionKey) || null
  const selectedSessionNotificationKeyRef = useLatest(
    session ? sessionNotificationKey(session) : null,
  )
  const runId = run?.id
  const runHostId = run?.hostId
  const sessionHostId = session?.hostId
  const sessionProjectId = session?.projectId
  const sessionProviderId = session?.provider
  const sessionNativeId = session?.nativeSessionId
  const sessionStatus = session?.status
  const managedRunId = session?.managedRunId
  const sessionHostStatus = session
    ? state.hosts.find((item) => item.id === session.hostId)?.status
    : undefined
  const draft = state.drafts.find((item) => item.id === selectedDraftId) || null
  // Viewing something with the window focused counts as reading it. This re-runs
  // whenever the selected run or session is refreshed, not only when the
  // selection changes, so an alert that arrives while you are looking at the
  // thread clears itself instead of waiting for the next focus event.
  const readSelected = useCallback(() => {
    if (document.hidden || !document.hasFocus()) return
    if (run) readRun(run)
    if (session) readSession(session)
  }, [readRun, readSession, run, session])
  useEffect(() => {
    // Idempotent: `updateUnread` returns the same Set when nothing was unread,
    // so the common case bails out of the re-render, and when there is
    // something to clear the extra render is the point.
    readSelected()
    window.addEventListener('focus', readSelected)
    document.addEventListener('visibilitychange', readSelected)
    return () => {
      window.removeEventListener('focus', readSelected)
      document.removeEventListener('visibilitychange', readSelected)
    }
  }, [readSelected])
  const { events } = useRunEventStream({
    runId,
    runHostId,
    managedRunId,
    sessionHostId,
    stateRef,
    notifyRunEvent,
    reload,
  })
  const { sessionMessages, hasEarlier, loadingEarlier, loadEarlier } = useSessionMessagesPoller({
    selectedSessionKey,
    sessionHostId,
    sessionProjectId,
    sessionProviderId,
    sessionNativeId,
    sessionStatus,
    sessionHostStatus,
    setError,
  })
  useExternalTranscriptWatcher({
    sessions: state.sessions,
    stateRef,
    addUnread,
    clearUnread,
    rememberNotification,
    notified,
    selectedSessionNotificationKeyRef,
    sessionCompletionNotifiedAt,
  })
  useEffect(() => {
    if (!state.settings.notifications) return
    void prepareNotifications()
  }, [state.settings.notifications])
  useEffect(() => {
    applyTheme(state.settings.theme)
    rememberTheme(state.settings.theme)
    return watchSystemTheme(state.settings.theme)
  }, [state.settings.theme])
  const setTheme = async (theme: ThemePreference) => {
    const prior = state.settings
    setState((current) => ({ ...current, settings: { ...current.settings, theme } }))
    try {
      const saved = await api.updateSettings({ theme })
      setState((current) => ({ ...current, settings: saved }))
    } catch (cause) {
      setState((current) => ({ ...current, settings: prior }))
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  const archivedSessions = state.settings.archivedSessionKeys
    .map((key) => allSessions.find((item) => sessionKey(item) === key))
    .filter((item): item is ProviderSession => Boolean(item))
    .sort(recentFirst)
  const archivedRuns = state.settings.archivedRunKeys
    .map((key) => state.runs.find((item) => runRowKey(item) === key))
    .filter((item): item is Run => Boolean(item))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  const agents = useMemo(() => observedAgents(state), [state])
  const selectedAgent =
    agents.find(({ hostId, agent }) => `${hostId}:${agent.id}` === selectedAgentKey) || null
  const project = draft
    ? state.projects.find((item) => item.id === draft.projectId && item.hostId === draft.hostId)
    : session
      ? state.projects.find(
          (item) => item.id === session.projectId && item.hostId === session.hostId,
        )
      : run
        ? state.projects.find((item) => item.id === run.projectId && item.hostId === run.hostId)
        : selectedAgent?.project ||
          state.projects.find((item) => projectKey(item) === selectedProjectKey) ||
          state.projects[0]
  const host = project ? state.hosts.find((item) => item.id === project.hostId) : state.hosts[0]
  const provider = run
    ? state.providersByHost[run.hostId]?.find((item) => item.id === run.provider)
    : undefined
  const sessionProvider = session
    ? state.providersByHost[session.hostId]?.find((item) => item.id === session.provider)
    : undefined
  const newDraft = async (nextProject = project) => {
    if (!nextProject) return
    try {
      selectDraft(await api.createDraft({ hostId: nextProject.hostId, projectId: nextProject.id }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  const togglePin = async (nextSession: ProviderSession) => {
    const key = sessionKey(nextSession)
    const pinned = state.settings.pinnedSessionKeys
    const isPinned = pinned.includes(key)
    const pinnedSessionKeys = isPinned ? pinned.filter((item) => item !== key) : [...pinned, key]
    const pinnedSessions = isPinned
      ? state.settings.pinnedSessions.filter((item) => sessionKey(item) !== key)
      : [...state.settings.pinnedSessions.filter((item) => sessionKey(item) !== key), nextSession]
    const prior = state.settings
    setState((current) => ({
      ...current,
      settings: { ...current.settings, pinnedSessionKeys, pinnedSessions },
    }))
    try {
      const settings = await api.updateSettings({ pinnedSessionKeys, pinnedSessions })
      setState((current) => ({ ...current, settings }))
    } catch (cause) {
      setState((current) => ({ ...current, settings: prior }))
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  const toggleArchive = async (nextSession: ProviderSession) => {
    const key = sessionKey(nextSession)
    const archived = state.settings.archivedSessionKeys
    const isArchived = archived.includes(key)
    const archivedSessionKeys = isArchived
      ? archived.filter((item) => item !== key)
      : [...archived, key]
    const archivedSnapshots = isArchived
      ? state.settings.archivedSessions.filter((item) => sessionKey(item) !== key)
      : [...state.settings.archivedSessions.filter((item) => sessionKey(item) !== key), nextSession]
    const pinnedSessionKeys = isArchived
      ? state.settings.pinnedSessionKeys
      : state.settings.pinnedSessionKeys.filter((item) => item !== key)
    const pinnedSessions = isArchived
      ? state.settings.pinnedSessions
      : state.settings.pinnedSessions.filter((item) => sessionKey(item) !== key)
    const prior = state.settings
    const nextSettings = {
      ...prior,
      archivedSessionKeys,
      archivedSessions: archivedSnapshots,
      pinnedSessionKeys,
      pinnedSessions,
    }
    setState((current) => ({ ...current, settings: nextSettings }))
    if (!isArchived) {
      // Archiving dismisses the conversation, its unread badge included; the
      // reconciler would drop the key on the next poll anyway, but the bell
      // should not keep counting for those seconds.
      readSession(nextSession)
      if (selectedSessionKey === key) setSelectedSessionKey(null)
    }
    try {
      const saved = await api.updateSettings({
        archivedSessionKeys,
        archivedSessions: archivedSnapshots,
        pinnedSessionKeys,
        pinnedSessions,
      })
      setState((current) => ({ ...current, settings: saved }))
    } catch (cause) {
      setState((current) => ({ ...current, settings: prior }))
      if (!isArchived && selectedSessionKey === key) setSelectedSessionKey(key)
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  // Managed runs get the same archive affordance as provider sessions. A run
  // that never produced a matching provider session — a failed or interrupted
  // one, most often — is listed indefinitely, so without this there is no way
  // to clear it out of a project.
  const toggleArchiveRun = async (nextRun: Run) => {
    const key = runRowKey(nextRun)
    const archived = state.settings.archivedRunKeys
    const isArchived = archived.includes(key)
    const archivedRunKeys = isArchived
      ? archived.filter((item) => item !== key)
      : [...archived, key]
    const prior = state.settings
    const nextSettings = { ...prior, archivedRunKeys }
    setState((current) => ({ ...current, settings: nextSettings }))
    if (!isArchived) readRun(nextRun)
    const deselect = !isArchived && selectedId === nextRun.id
    if (deselect) setSelectedId(null)
    try {
      const saved = await api.updateSettings({ archivedRunKeys })
      setState((current) => ({ ...current, settings: saved }))
    } catch (cause) {
      setState((current) => ({ ...current, settings: prior }))
      if (deselect) setSelectedId(nextRun.id)
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  const toggleHideAgent = async (hostId: string, agent: DiscoveredAgent) => {
    const key = hiddenAgentKey(hostId, agent)
    const hidden = state.settings.hiddenAgentKeys
    const isHidden = hidden.includes(key)
    const hiddenAgentKeys = isHidden ? hidden.filter((item) => item !== key) : [...hidden, key]
    const prior = state.settings
    setState((current) => ({ ...current, settings: { ...current.settings, hiddenAgentKeys } }))
    if (!isHidden && selectedAgentKey === `${hostId}:${agent.id}`) setSelectedAgentKey(null)
    try {
      const saved = await api.updateSettings({ hiddenAgentKeys })
      setState((current) => ({ ...current, settings: saved }))
    } catch (cause) {
      setState((current) => ({ ...current, settings: prior }))
      if (!isHidden && selectedAgentKey === `${hostId}:${agent.id}`)
        setSelectedAgentKey(`${hostId}:${agent.id}`)
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  const controlAgent = async (
    hostId: string,
    agent: DiscoveredAgent,
    action: 'interrupt' | 'terminate',
  ) => {
    try {
      await api.controlDiscoveredAgent(hostId, agent.pid, action)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  const archiveProjectSessions = async (nextProject: Project) => {
    const projectSessions = allSessions.filter(
      (item) =>
        item.hostId === nextProject.hostId &&
        item.projectId === nextProject.id &&
        !state.settings.archivedSessionKeys.includes(sessionKey(item)),
    )
    if (!projectSessions.length) return
    const keysToArchive = new Set(projectSessions.map(sessionKey))
    const prior = state.settings
    const archivedSessionKeys = [...new Set([...prior.archivedSessionKeys, ...keysToArchive])]
    const archivedSessions = [
      ...new Map(
        [...prior.archivedSessions, ...projectSessions].map((item) => [sessionKey(item), item]),
      ).values(),
    ]
    const pinnedSessionKeys = prior.pinnedSessionKeys.filter((key) => !keysToArchive.has(key))
    const pinnedSessions = prior.pinnedSessions.filter(
      (item) => !keysToArchive.has(sessionKey(item)),
    )
    const nextSettings = {
      ...prior,
      archivedSessionKeys,
      archivedSessions,
      pinnedSessionKeys,
      pinnedSessions,
    }
    setState((current) => ({ ...current, settings: nextSettings }))
    if (selectedSessionKey && keysToArchive.has(selectedSessionKey)) setSelectedSessionKey(null)
    try {
      const saved = await api.updateSettings({
        archivedSessionKeys,
        archivedSessions,
        pinnedSessionKeys,
        pinnedSessions,
      })
      setState((current) => ({ ...current, settings: saved }))
    } catch (cause) {
      setState((current) => ({ ...current, settings: prior }))
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  const removeProject = async (nextProject: Project) => {
    const key = projectKey(nextProject)
    setRemovingProject(true)
    setError('')
    try {
      await api.removeProject(nextProject.hostId, nextProject.id)
      setExtraSessions((current) => {
        const next = { ...current }
        delete next[key]
        return next
      })
      if (selectedProjectKey === key) {
        clearSelectedRun()
        setSelectedId(null)
        setSelectedSessionKey(null)
        setSelectedAgentKey(null)
        setSelectedDraftId(null)
        setSelectedProjectKey(null)
      }
      setProjectToRemove(null)
      await reload()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setRemovingProject(false)
    }
  }
  return (
    <div className="relative flex h-screen w-full overflow-hidden bg-canvas md:grid md:grid-cols-[344px_minmax(0,1fr)]">
      {/* Mobile backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-xs md:hidden"
          onClick={closeSidebar}
          aria-hidden="true"
        />
      )}
      {/* Sidebar sheet on mobile, fixed column on desktop */}
      <div
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex w-[300px] max-w-[85vw] flex-col transition-transform duration-200 ease-in-out md:static md:z-auto md:w-auto md:max-w-none md:translate-x-0',
          sidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0',
        )}
      >
        <Sidebar
          state={state}
          runs={state.runs}
          sessions={allSessions}
          agents={agents}
          unreadKeys={unreadKeys}
          selectedId={selectedId}
          selectedSessionKey={selectedSessionKey}
          selectedAgentKey={selectedAgentKey}
          selectedDraftId={selectedDraftId}
          selectedProjectKey={selectedProjectKey}
          query={query}
          onQuery={setQuery}
          onSelectRun={(next) => {
            closeSidebar()
            readRun(next)
            selectRun(next)
          }}
          onSelectSession={(next) => {
            closeSidebar()
            readSession(next)
            selectSession(next)
          }}
          onSelectDraft={(draft) => {
            closeSidebar()
            selectDraft(draft)
          }}
          onSelectAgent={(hostId, agent, project) => {
            closeSidebar()
            selectAgent(hostId, agent, project)
          }}
          onSelectProject={(project) => {
            closeSidebar()
            selectProject(project)
          }}
          onRemoveProject={setProjectToRemove}
          onArchiveProject={archiveProjectSessions}
          onTogglePin={togglePin}
          onToggleArchive={toggleArchive}
          onToggleArchiveRun={toggleArchiveRun}
          onHideAgent={toggleHideAgent}
          onControlAgent={controlAgent}
          onRefreshProject={async (project) => {
            try {
              const key = projectKey(project)
              const items = await api.refreshProjectSessions(project.hostId, project.id)
              setExtraSessions((current) => ({ ...current, [key]: items }))
              setState((current) => ({
                ...current,
                sessions: [
                  ...current.sessions.filter(
                    (session) =>
                      session.hostId !== project.hostId || session.projectId !== project.id,
                  ),
                  ...items,
                ].sort(recentFirst),
              }))
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : String(cause))
            }
          }}
          onShowMore={async (project, visibleLimit) => {
            const key = projectKey(project)
            try {
              const items = await api.projectSessions(project.hostId, project.id, visibleLimit + 1)
              setExtraSessions((current) => ({ ...current, [key]: items }))
              return true
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : String(cause))
              return false
            }
          }}
          onNewRun={() => {
            closeSidebar()
            void newDraft()
          }}
          onNewProject={() => {
            closeSidebar()
            setNewProject(true)
          }}
          onRegisterFolder={async (hostId, path) => {
            try {
              const name = path.split('/').filter(Boolean).at(-1) || path
              await api.createProject({ hostId, name, path })
              await reload()
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : String(cause))
            }
          }}
          onSettings={() => {
            closeSidebar()
            setSettings(true)
          }}
          onArchives={() => {
            closeSidebar()
            setArchives(true)
          }}
          onJumpToUnread={() => {
            closeSidebar()
            // The badge is only useful if it can point at the thing it counts.
            // Resolve the first unread key to its conversation and open it; keys
            // that resolve to nothing are stale, so drop them instead of leaving
            // a ghost badge nothing in the sidebar explains.
            const stale: string[] = []
            for (const key of unreadKeys) {
              const unreadSession = allSessions.find((item) => sessionNotificationKey(item) === key)
              if (unreadSession) {
                readSession(unreadSession)
                selectSession(unreadSession)
                if (stale.length) clearUnread(stale)
                return
              }
              const unreadRun = state.runs.find((item) => runNotificationKeys(item).includes(key))
              if (unreadRun) {
                readRun(unreadRun)
                selectRun(unreadRun)
                if (stale.length) clearUnread(stale)
                return
              }
              stale.push(key)
            }
            if (stale.length) clearUnread(stale)
            setArchives(true)
          }}
          onClose={closeSidebar}
        />
      </div>
      <section className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-canvas">
        {session ? (
          <SessionScreen
            key={`session:${sessionNotificationKey(session)}`}
            session={session}
            messages={sessionMessages[selectedSessionKey!] || []}
            messagesLoaded={Boolean(sessionMessages[selectedSessionKey!])}
            hasEarlier={hasEarlier}
            loadingEarlier={loadingEarlier}
            onLoadEarlier={loadEarlier}
            runEvents={session.managedRunId ? events[session.managedRunId] || [] : []}
            project={project}
            host={host}
            provider={sessionProvider}
            onStarted={(next) => {
              selectRun(next)
              void reload()
            }}
            onError={setError}
            onToggleSidebar={toggleSidebar}
          />
        ) : run ? (
          <RunScreen
            key={`run:${run.hostId}:${run.id}`}
            run={run}
            events={events[run.id] || []}
            project={project}
            host={host}
            provider={provider}
            onStarted={(next) => {
              selectRun(next)
              void reload()
            }}
            onError={setError}
            onToggleSidebar={toggleSidebar}
          />
        ) : selectedAgent ? (
          <ObservedScreen
            key={`agent:${selectedAgent.hostId}:${selectedAgent.agent.id}`}
            host={state.hosts.find((item) => item.id === selectedAgent.hostId)}
            project={selectedAgent.project}
            provider={state.providersByHost[selectedAgent.hostId]?.find(
              (item) => item.id === selectedAgent.agent.provider,
            )}
            agent={selectedAgent.agent}
            onStarted={(next) => {
              selectRun(next)
              void reload()
            }}
            onError={setError}
            onToggleSidebar={toggleSidebar}
          />
        ) : (
          <StartScreen
            key={draft?.id || (project ? projectKey(project) : 'empty')}
            state={state}
            draft={draft || undefined}
            project={project}
            host={host}
            onProject={() => setNewProject(true)}
            onStarted={(next) => {
              selectRun(next)
              void reload()
            }}
            onError={setError}
            onToggleSidebar={toggleSidebar}
          />
        )}
      </section>
      {error && (
        <div
          role="alert"
          className="fixed right-5 bottom-5 z-30 flex gap-3 rounded-lg border border-scarlet-600/60 bg-scarlet-950 px-3.5 py-3 text-scarlet-400"
        >
          {error}
          <button aria-label="Dismiss error" onClick={() => setError('')}>
            <X size={14} />
          </button>
        </div>
      )}
      {newProject && (
        <ProjectDialog
          hosts={state.hosts}
          onClose={() => setNewProject(false)}
          onCreated={async () => {
            setNewProject(false)
            await reload()
          }}
        />
      )}
      {settings && (
        <ConnectionsDialog
          hosts={state.hosts}
          theme={state.settings.theme}
          onThemeChange={setTheme}
          onClose={() => setSettings(false)}
          onChanged={reload}
        />
      )}
      {archives && (
        <ArchivedChatsDialog
          sessions={archivedSessions}
          archivedRuns={archivedRuns}
          runs={state.runs}
          unreadKeys={unreadKeys}
          projects={state.projects}
          hosts={state.hosts}
          onOpen={(next) => {
            readSession(next)
            selectSession(next)
            setArchives(false)
          }}
          onRestore={toggleArchive}
          onRestoreRun={toggleArchiveRun}
          onOpenRun={(next) => {
            readRun(next)
            selectRun(next)
            setArchives(false)
          }}
          onClose={() => setArchives(false)}
        />
      )}
      {projectToRemove && (
        <RemoveProjectDialog
          project={projectToRemove}
          busy={removingProject}
          onClose={() => {
            if (!removingProject) setProjectToRemove(null)
          }}
          onConfirm={() => void removeProject(projectToRemove)}
        />
      )}
    </div>
  )
}
