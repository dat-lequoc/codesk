import { RemoveProjectDialog } from './features/dialogs/RemoveProjectDialog'
import { RunScreen } from './features/screens/RunScreen'
import { ArchivedChatsDialog } from './features/dialogs/ArchivedChatsDialog'
import { ConnectionsDialog } from './features/dialogs/ConnectionsDialog'
import { ProjectDialog } from './features/dialogs/ProjectDialog'
import { ObservedScreen } from './features/screens/ObservedScreen'
import { SessionScreen } from './features/screens/SessionScreen'
import { StartScreen } from './features/screens/StartScreen'
import { Sidebar } from './features/sidebar/Sidebar'
import { useEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { api, gatewayOrigin } from './api'
import type {
  AppState,
  DiscoveredAgent,
  DraftSession,
  Project,
  ProviderSession,
  Run,
  RunEvent,
  SessionMessage,
} from './types'
import { empty, normalizeState, observedAgents } from './lib/app-state'
import {
  active,
  externalCompletionSettleMs,
  mergeEvents,
  mergeSessionMessages,
  notificationEventKinds,
  terminalRunStatuses,
  terminalStatusByEventKind,
  transcriptTurnOpen,
} from './lib/events'
import type { ExternalTranscriptWatch } from './lib/events'
import {
  projectKey,
  recentFirst,
  runEventNotificationKey,
  runNotificationKeys,
  runRowKey,
  sessionKey,
  sessionNotificationKey,
  terminalNotificationTag,
} from './lib/keys'
import {
  isTauriDesktop,
  notify,
  prepareNotifications,
  reconcileUnreadKeys,
} from './lib/notifications'
import { loadStringSet, saveStringSet } from './lib/storage'

export function App() {
  const [state, setState] = useState<AppState>(empty)
  const [events, setEvents] = useState<Record<string, RunEvent[]>>({})
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedSessionKey, setSelectedSessionKey] = useState<string | null>(null)
  const [sessionMessages, setSessionMessages] = useState<Record<string, SessionMessage[]>>({})
  const [selectedAgentKey, setSelectedAgentKey] = useState<string | null>(null)
  const [selectedDraftId, setSelectedDraftId] = useState<string | null>(null)
  const [selectedProjectKey, setSelectedProjectKey] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [extraSessions, setExtraSessions] = useState<Record<string, ProviderSession[]>>({})
  const [newProject, setNewProject] = useState(false)
  const [settings, setSettings] = useState(false)
  const [archives, setArchives] = useState(false)
  const [projectToRemove, setProjectToRemove] = useState<Project | null>(null)
  const [removingProject, setRemovingProject] = useState(false)
  const [error, setError] = useState('')
  const initialized = useRef(false)
  const selectedRunRef = useRef<Run | null>(null)
  const selectedSessionNotificationKeyRef = useRef<string | null>(null)
  const stateRef = useRef<AppState>(empty)
  const sessionMessagesRef = useRef<Record<string, SessionMessage[]>>({})
  const priorRunStatus = useRef<Map<string, Run['status']>>(new Map())
  const priorSessionStatus = useRef<Map<string, ProviderSession['status']>>(new Map())
  const externalTranscriptWatches = useRef<Map<string, ExternalTranscriptWatch>>(new Map())
  const sessionCompletionNotifiedAt = useRef<Map<string, number>>(new Map())
  const notified = useRef<Set<string>>(loadStringSet('codesk.notifications'))
  const [unreadKeys, setUnreadKeys] = useState<Set<string>>(() =>
    loadStringSet('codesk.unread-notifications:v1'),
  )
  useEffect(() => {
    if (!isTauriDesktop()) return
    void import('@tauri-apps/api/window')
      .then(({ getCurrentWindow }) =>
        getCurrentWindow().setBadgeCount(unreadKeys.size || undefined),
      )
      .catch(() => {})
  }, [unreadKeys.size])
  stateRef.current = state
  const updateUnread = (added: string[], removed: string[] = []) =>
    setUnreadKeys((current) => {
      const next = new Set(current)
      let changed = false
      for (const key of removed) changed = next.delete(key) || changed
      for (const key of added)
        if (!next.has(key)) {
          next.add(key)
          changed = true
        }
      if (!changed) return current
      saveStringSet('codesk.unread-notifications:v1', next)
      return next
    })
  const reconcileUnread = (snapshot: AppState) =>
    setUnreadKeys((current) => {
      const next = reconcileUnreadKeys(current, snapshot)
      if (next.size === current.size && [...next].every((key) => current.has(key))) return current
      saveStringSet('codesk.unread-notifications:v1', next)
      return next
    })
  const addUnread = (keys: string[]) => updateUnread(keys)
  const clearUnread = (keys: string[]) => updateUnread([], keys)
  const readRun = (run: Run) => clearUnread(runNotificationKeys(run))
  const readSession = (session: ProviderSession) =>
    clearUnread([
      sessionNotificationKey(session),
      ...stateRef.current.runs
        .filter(
          (run) =>
            run.hostId === session.hostId &&
            run.provider === session.provider &&
            run.sessionId === session.nativeSessionId,
        )
        .flatMap(runNotificationKeys),
    ])
  const markRunUnread = (runId: string) => {
    const run = stateRef.current.runs.find((item) => item.id === runId)
    const runKey = runEventNotificationKey(run?.hostId || 'unknown', runId)
    if (run?.sessionId)
      updateUnread([`session:${run.hostId}:${run.provider}:${run.sessionId}`], [runKey])
    else addUnread([runKey])
  }
  const notifyRunEvent = (event: RunEvent) => {
    if (!notificationEventKinds.has(event.kind)) return
    const run = stateRef.current.runs.find((item) => item.id === event.run_id)
    const terminalStatus = terminalStatusByEventKind.get(event.kind)
    const tag = terminalStatus
      ? terminalNotificationTag(event.run_id, terminalStatus)
      : event.event_id
    if (notified.current.has(tag)) return
    notified.current.add(tag)
    localStorage.setItem('codesk.notifications', JSON.stringify([...notified.current].slice(-500)))
    markRunUnread(event.run_id)
    if (!stateRef.current.settings.notifications) return
    const label =
      event.kind === 'input.required'
        ? 'Input required'
        : event.kind === 'approval.required'
          ? 'Approval required'
          : `Run ${terminalStatus || 'updated'}`
    void notify(
      `Codesk · ${label}`,
      String(event.payload.text || run?.title || 'Agent run updated'),
      tag,
    )
  }
  const initializeSelection = (next: AppState) => {
    const firstDraft = next.drafts[0]
    const firstSession = next.sessions[0] || next.settings.pinnedSessions[0]
    const firstRun = next.runs[0]
    selectedRunRef.current = !firstDraft && !firstSession ? firstRun || null : null
    if (firstDraft) setSelectedDraftId(firstDraft.id)
    else if (firstSession) setSelectedSessionKey(sessionKey(firstSession))
    else setSelectedId(firstRun?.id || null)
    const firstProject = firstDraft
      ? next.projects.find(
          (item) => item.id === firstDraft.projectId && item.hostId === firstDraft.hostId,
        )
      : firstSession
        ? next.projects.find(
            (item) => item.id === firstSession.projectId && item.hostId === firstSession.hostId,
          )
        : firstRun
          ? next.projects.find(
              (item) => item.id === firstRun.projectId && item.hostId === firstRun.hostId,
            )
          : next.projects[0]
    setSelectedProjectKey(firstProject ? projectKey(firstProject) : null)
    initialized.current = true
  }
  const reload = async () => {
    try {
      const next = normalizeState(await api.state())
      reconcileUnread(next)
      const selectedRun = selectedRunRef.current
      const refreshedRun = selectedRun && next.runs.find((item) => item.id === selectedRun.id)
      if (refreshedRun) selectedRunRef.current = refreshedRun
      else if (selectedRun)
        next.runs = [selectedRun, ...next.runs.filter((item) => item.id !== selectedRun.id)]
      setState(next)
      setExtraSessions((current) => {
        const refreshed = { ...current }
        for (const [key, items] of Object.entries(refreshed)) {
          const latest = new Map(
            next.sessions
              .filter((item) => `${item.hostId}:${item.projectId}` === key)
              .map((item) => [sessionKey(item), item]),
          )
          refreshed[key] = items.map((item) => latest.get(sessionKey(item)) || item)
        }
        return refreshed
      })
      setError('')
      if (!initialized.current) initializeSelection(next)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  useEffect(() => {
    let cancelled = false
    api
      .navigation()
      .then((value) => {
        if (cancelled || initialized.current) return
        const next = normalizeState(value)
        setState(next)
        reconcileUnread(next)
        if (
          next.projects.length ||
          next.drafts.length ||
          next.sessions.length ||
          next.runs.length ||
          next.settings.pinnedSessions.length
        )
          initializeSelection(next)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])
  useEffect(() => {
    let cancelled = false
    let timer = 0
    let loading = false
    const poll = async () => {
      if (cancelled || loading || document.hidden) return
      loading = true
      try {
        await reload()
      } finally {
        loading = false
      }
      if (!cancelled && !document.hidden) timer = window.setTimeout(poll, 15_000)
    }
    const visibility = () => {
      clearTimeout(timer)
      if (!document.hidden) void poll()
    }
    document.addEventListener('visibilitychange', visibility)
    void poll()
    return () => {
      cancelled = true
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [])
  const run = state.runs.find((item) => item.id === selectedId) || null
  const session =
    [
      ...state.sessions,
      ...Object.values(extraSessions).flat(),
      ...state.settings.pinnedSessions,
      ...state.settings.archivedSessions,
    ].find((item) => sessionKey(item) === selectedSessionKey) || null
  selectedSessionNotificationKeyRef.current = session ? sessionNotificationKey(session) : null
  const sessionHostStatus = session
    ? state.hosts.find((item) => item.id === session.hostId)?.status
    : undefined
  const draft = state.drafts.find((item) => item.id === selectedDraftId) || null
  useEffect(() => {
    const readSelected = () => {
      if (document.hidden || !document.hasFocus()) return
      if (run) readRun(run)
      if (session) readSession(session)
    }
    readSelected()
    window.addEventListener('focus', readSelected)
    document.addEventListener('visibilitychange', readSelected)
    return () => {
      window.removeEventListener('focus', readSelected)
      document.removeEventListener('visibilitychange', readSelected)
    }
  }, [run?.id, selectedSessionKey])
  useEffect(() => {
    if (!run || events[run.id]) return
    api
      .events(run.hostId, run.id)
      .then((items) => setEvents((current) => ({ ...current, [run.id]: items })))
      .catch(() => {})
  }, [run?.id])
  useEffect(() => {
    // A tmux session is rendered from its provider transcript, but Codesk's own
    // synthetic events (usage snapshots) live on the backing managed run.
    const runId = session?.managedRunId
    if (!session || !runId || events[runId]) return
    api
      .events(session.hostId, runId)
      .then((items) => setEvents((current) => ({ ...current, [runId]: items })))
      .catch(() => {})
  }, [session?.managedRunId, session?.hostId])
  useEffect(() => {
    if (!session || !selectedSessionKey || sessionHostStatus !== 'online') return
    let stopped = false
    let timer = 0
    let idleDelay = 2000
    const load = async () => {
      const prior = sessionMessagesRef.current[selectedSessionKey] || []
      const after = [...prior].reverse().find((item) => item.timestamp)?.timestamp
      try {
        const incoming = await api.sessionMessages(
          session.hostId,
          session.projectId,
          session.provider,
          session.nativeSessionId,
          after,
        )
        if (stopped || !incoming.length) return false
        setSessionMessages((current) => {
          const existing = current[selectedSessionKey] || []
          const next = mergeSessionMessages(existing, incoming)
          if (next === existing) return current
          const updated = { ...current, [selectedSessionKey]: next }
          sessionMessagesRef.current = updated
          return updated
        })
        return true
      } catch (cause) {
        if (!stopped) setError(cause instanceof Error ? cause.message : String(cause))
        return false
      }
    }
    const poll = async () => {
      if (stopped || document.hidden) return
      const changed = await load()
      if (stopped || document.hidden) return
      if (session.status === 'running' || changed) idleDelay = 2000
      else idleDelay = Math.min(15_000, idleDelay * 2)
      timer = window.setTimeout(poll, session.status === 'running' ? 2000 : idleDelay)
    }
    const visibility = () => {
      clearTimeout(timer)
      if (!document.hidden) {
        idleDelay = 2000
        void poll()
      }
    }
    document.addEventListener('visibilitychange', visibility)
    void poll()
    return () => {
      stopped = true
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [
    selectedSessionKey,
    session?.hostId,
    session?.projectId,
    session?.provider,
    session?.nativeSessionId,
    session?.status,
    sessionHostStatus,
  ])
  const liveExternalSessionSignature = state.sessions
    .filter((item) => item.pid)
    .map((item) => sessionNotificationKey(item))
    .sort()
    .join('|')
  useEffect(() => {
    let stopped = false
    let timer = 0
    let loading = false
    const pollSession = async (session: ProviderSession) => {
      const key = sessionNotificationKey(session)
      let watch = externalTranscriptWatches.current.get(key)
      if (!watch) {
        watch = { seen: new Set(), initialized: false, turnOpen: false }
        externalTranscriptWatches.current.set(key, watch)
      }
      try {
        const incoming = await api.sessionMessages(
          session.hostId,
          session.projectId,
          session.provider,
          session.nativeSessionId,
          watch.after,
        )
        if (stopped) return
        const latestTimestamp = incoming.reduce(
          (latest, message) => (message.timestamp > latest ? message.timestamp : latest),
          watch.after || '',
        )
        if (latestTimestamp) watch.after = latestTimestamp
        if (!watch.initialized) {
          watch.seen = new Set(incoming.map((message) => message.id))
          watch.turnOpen = transcriptTurnOpen(incoming, session.status)
          watch.initialized = true
          return
        }
        for (const message of incoming) {
          if (watch.seen.has(message.id)) continue
          watch.seen.add(message.id)
          if (message.kind !== 'turn_completed') {
            if (!watch.turnOpen || watch.pendingCompletion) clearUnread([key])
            watch.turnOpen = true
            watch.pendingCompletion = undefined
            sessionCompletionNotifiedAt.current.delete(key)
            continue
          }
          if (!watch.turnOpen) continue
          watch.turnOpen = false
          const tag = `session-turn:${session.hostId}:${session.provider}:${session.nativeSessionId}:${message.id}`
          if (!notified.current.has(tag))
            watch.pendingCompletion = { messageId: message.id, detectedAt: Date.now() }
        }
        const pending = watch.pendingCompletion
        if (
          pending &&
          !watch.turnOpen &&
          session.status !== 'running' &&
          Date.now() - pending.detectedAt >= externalCompletionSettleMs
        ) {
          watch.pendingCompletion = undefined
          const tag = `session-turn:${session.hostId}:${session.provider}:${session.nativeSessionId}:${pending.messageId}`
          if (!notified.current.has(tag)) {
            notified.current.add(tag)
            localStorage.setItem(
              'codesk.notifications',
              JSON.stringify([...notified.current].slice(-500)),
            )
            sessionCompletionNotifiedAt.current.set(key, Date.now())
            const activelyViewing =
              !document.hidden &&
              document.hasFocus() &&
              selectedSessionNotificationKeyRef.current === key
            if (!activelyViewing) {
              addUnread([key])
              if (stateRef.current.settings.notifications)
                void notify('Codesk · Turn completed', session.title, tag)
            }
          }
        }
      } catch {}
    }
    const poll = async () => {
      if (stopped || loading) return
      loading = true
      const snapshot = stateRef.current
      const managedSessions = new Set(
        snapshot.runs.flatMap((run) =>
          run.sessionId ? [`${run.hostId}:${run.provider}:${run.sessionId}`] : [],
        ),
      )
      const sessions = snapshot.sessions.filter(
        (session) =>
          session.pid &&
          snapshot.hosts.find((host) => host.id === session.hostId)?.status === 'online' &&
          !managedSessions.has(`${session.hostId}:${session.provider}:${session.nativeSessionId}`),
      )
      const activeKeys = new Set(sessions.map(sessionNotificationKey))
      for (const key of externalTranscriptWatches.current.keys())
        if (!activeKeys.has(key)) externalTranscriptWatches.current.delete(key)
      await Promise.all(sessions.map(pollSession))
      loading = false
      if (stopped) return
      const needsFastPoll = sessions.some((session) => {
        const watch = externalTranscriptWatches.current.get(sessionNotificationKey(session))
        return watch?.turnOpen || watch?.pendingCompletion
      })
      timer = window.setTimeout(poll, needsFastPoll ? 3_000 : 15_000)
    }
    void poll()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [liveExternalSessionSignature])
  useEffect(() => {
    const origin = gatewayOrigin
      ? gatewayOrigin.replace('http://', 'ws://').replace('https://', 'wss://')
      : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`
    let ws: WebSocket | null = null
    let stopped = false
    let retry = 500
    const replay = async () => {
      const snapshot = await api.state()
      await Promise.all(
        snapshot.runs.map(async (item) => {
          const incoming = await api.events(item.hostId, item.id)
          setEvents((current) => ({
            ...current,
            [item.id]: mergeEvents(current[item.id] || [], incoming),
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
            void reload()
          notifyRunEvent(event)
        } else if (
          envelope.type.startsWith('host.') ||
          envelope.type.startsWith('draft.') ||
          envelope.type === 'settings.updated' ||
          envelope.type === 'state.updated'
        )
          void reload()
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
      ws?.close()
    }
  }, [])
  useEffect(() => {
    if (!state.settings.notifications) return
    void prepareNotifications()
  }, [state.settings.notifications])
  useEffect(() => {
    for (const run of state.runs) {
      const prior = priorRunStatus.current.get(run.id)
      if (prior && active.has(prior) && terminalRunStatuses.has(run.status)) {
        const tag = terminalNotificationTag(run.id, run.status)
        if (!notified.current.has(tag)) {
          notified.current.add(tag)
          localStorage.setItem(
            'codesk.notifications',
            JSON.stringify([...notified.current].slice(-500)),
          )
          markRunUnread(run.id)
          if (state.settings.notifications)
            void notify(`Codesk · Run ${run.status}`, run.title, tag)
        }
      }
      priorRunStatus.current.set(run.id, run.status)
    }
  }, [state.runs, state.settings.notifications])
  useEffect(() => {
    for (const session of state.sessions) {
      const key = `${session.hostId}:${session.id}`
      const prior = priorSessionStatus.current.get(key)
      const notificationKey = sessionNotificationKey(session)
      const managed = state.runs.some(
        (run) =>
          run.hostId === session.hostId &&
          run.provider === session.provider &&
          run.sessionId === session.nativeSessionId,
      )
      if (session.status === 'running' && !managed) clearUnread([notificationKey])
      if (session.status === 'stopped' && prior === 'running') {
        const completionAt = sessionCompletionNotifiedAt.current.get(notificationKey) || 0
        if (Date.now() - completionAt >= 120_000) {
          addUnread([notificationKey])
          if (state.settings.notifications) {
            const tag = `session-stopped:${key}:${session.updatedAt}`
            if (!notified.current.has(tag)) {
              notified.current.add(tag)
              localStorage.setItem(
                'codesk.notifications',
                JSON.stringify([...notified.current].slice(-500)),
              )
              void notify('Codesk · Agent stopped', session.title, tag)
            }
          }
        }
      }
      priorSessionStatus.current.set(key, session.status)
    }
  }, [state.sessions, state.settings.notifications])
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
  const clearSelectedRun = () => {
    selectedRunRef.current = null
  }
  const selectProject = (next: Project) => {
    clearSelectedRun()
    setSelectedProjectKey(projectKey(next))
    setSelectedId(null)
    setSelectedSessionKey(null)
    setSelectedAgentKey(null)
    setSelectedDraftId(null)
  }
  const selectRun = (next: Run) => {
    selectedRunRef.current = next
    setState((current) => ({
      ...current,
      runs: [next, ...current.runs.filter((item) => item.id !== next.id)],
    }))
    setSelectedId(next.id)
    setSelectedSessionKey(null)
    setSelectedAgentKey(null)
    setSelectedDraftId(null)
    setSelectedProjectKey(`${next.hostId}:${next.projectId}`)
  }
  const selectSession = (next: ProviderSession) => {
    const activeRun = state.runs.find(
      (item) =>
        item.hostId === next.hostId &&
        item.projectId === next.projectId &&
        item.provider === next.provider &&
        item.sessionId === next.nativeSessionId &&
        active.has(item.status),
    )
    if (activeRun && activeRun.inputTransport !== 'tmux') {
      selectRun(activeRun)
      return
    }
    clearSelectedRun()
    setSelectedSessionKey(`${next.hostId}:${next.id}`)
    setSelectedId(null)
    setSelectedAgentKey(null)
    setSelectedDraftId(null)
    setSelectedProjectKey(`${next.hostId}:${next.projectId}`)
  }
  useEffect(() => {
    if (run?.inputTransport !== 'tmux' || !run.sessionId) return
    const matching = allSessions.find(
      (item) =>
        item.hostId === run.hostId &&
        item.projectId === run.projectId &&
        item.provider === run.provider &&
        item.nativeSessionId === run.sessionId,
    )
    if (matching) selectSession(matching)
  }, [run?.id, run?.inputTransport, run?.sessionId, allSessions])
  const selectDraft = (next: DraftSession) => {
    clearSelectedRun()
    setSelectedDraftId(next.id)
    setSelectedId(null)
    setSelectedSessionKey(null)
    setSelectedAgentKey(null)
    setSelectedProjectKey(`${next.hostId}:${next.projectId}`)
  }
  const selectAgent = (hostId: string, agent: DiscoveredAgent, nextProject?: Project) => {
    clearSelectedRun()
    setSelectedAgentKey(`${hostId}:${agent.id}`)
    setSelectedId(null)
    setSelectedSessionKey(null)
    setSelectedDraftId(null)
    if (nextProject) setSelectedProjectKey(projectKey(nextProject))
  }
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
    if (!isArchived && selectedSessionKey === key) setSelectedSessionKey(null)
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
    <div className="grid h-screen grid-cols-[344px_minmax(0,1fr)] bg-canvas">
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
          readRun(next)
          selectRun(next)
        }}
        onSelectSession={(next) => {
          readSession(next)
          selectSession(next)
        }}
        onSelectDraft={selectDraft}
        onSelectAgent={selectAgent}
        onSelectProject={selectProject}
        onRemoveProject={setProjectToRemove}
        onArchiveProject={archiveProjectSessions}
        onTogglePin={togglePin}
        onToggleArchive={toggleArchive}
        onToggleArchiveRun={toggleArchiveRun}
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
        onNewRun={() => void newDraft()}
        onNewProject={() => setNewProject(true)}
        onRegisterFolder={async (hostId, path) => {
          try {
            const name = path.split('/').filter(Boolean).at(-1) || path
            await api.createProject({ hostId, name, path })
            await reload()
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause))
          }
        }}
        onSettings={() => setSettings(true)}
        onArchives={() => setArchives(true)}
      />
      <section className="min-h-0 min-w-0 bg-canvas">
        {session ? (
          <SessionScreen
            key={`session:${sessionNotificationKey(session)}`}
            session={session}
            messages={sessionMessages[selectedSessionKey!] || []}
            runEvents={session.managedRunId ? events[session.managedRunId] || [] : []}
            project={project}
            host={host}
            provider={sessionProvider}
            onStarted={(next) => {
              selectRun(next)
              void reload()
            }}
            onError={setError}
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
          />
        )}
      </section>
      {error && (
        <div className="fixed right-5 bottom-5 z-30 flex gap-3 rounded-lg border border-scarlet-600/60 bg-scarlet-950 px-3.5 py-3 text-scarlet-400">
          {error}
          <button onClick={() => setError('')}>
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
