import { createContext, FormEvent, KeyboardEvent, type MouseEvent as ReactMouseEvent, useContext, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  Archive, Bell, Bot, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, Circle, Clock3, Copy, Eye, FileDiff, FileText, Folder, FolderGit2, FolderOpen, Home, ImageIcon, Info,
  GitBranch, Globe2, Laptop, MoreHorizontal, Plug, Plus, Radio, RefreshCw,
  ListPlus, Pencil, Pin, PinOff, Search, Send, Server, Settings2, ShieldAlert, Square, Terminal, Trash2, TreePine,
  WifiOff, X, Zap,
} from 'lucide-react'
import { api, gatewayOrigin } from './api'
import { harnessOrder, providerIcon, providerName, providerUi } from './providerRegistry'
import type { AppState, DiscoveredAgent, DraftSession, ExternalQueuedInput, FileContent, FileEntry, GitContext, Host, Project, Provider, ProviderSession, Run, RunEvent, SessionMessage } from './types'

const empty: AppState = { hosts: [], projects: [], runs: [], sessions: [], drafts: [], providersByHost: {}, discoveredAgentsByHost: {}, settings: { notifications: true, pinnedSessionKeys: [], pinnedSessions: [], archivedSessionKeys: [], archivedSessions: [] } }
const active = new Set(['queued', 'starting', 'running', 'waiting_for_input', 'interrupting'])
const markdownPlugins = [remarkGfm]
const environmentContextPattern = /<environment_context>[\s\S]*?<\/environment_context>/gi
const logoUrl = new URL('../logo.png', import.meta.url).href
const FilePreviewContext = createContext<((href: string) => void) | null>(null)

const relative = (value?: string | null) => { if (!value) return ''; const seconds = Math.floor((Date.now() - new Date(value).getTime()) / 1000); return seconds < 60 ? 'now' : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 3600)}h` }
const isTauriDesktop = () => '__TAURI_INTERNALS__' in window
const prepareNotifications = async () => {
  if (isTauriDesktop()) {
    try {
      const { isPermissionGranted, requestPermission } = await import('@tauri-apps/plugin-notification')
      if (await isPermissionGranted()) return true
      return await requestPermission() === 'granted'
    } catch {}
  }
  if (!("Notification" in window)) return false
  if (Notification.permission === 'default') await Notification.requestPermission()
  return Notification.permission === 'granted'
}
const notify = async (title: string, body: string, tag: string) => {
  if (!await prepareNotifications()) return
  if (isTauriDesktop()) {
    try {
      const { sendNotification } = await import('@tauri-apps/plugin-notification')
      sendNotification({ title, body })
      return
    } catch {}
  }
  if ("Notification" in window && Notification.permission === 'granted') new Notification(title, { body, tag })
}
const projectKey = (project: Project) => `${project.hostId}:${project.id}`
const normalizedFolder = (value: string) => value.length > 1 ? value.replace(/\/+$/, '') : value
const projectForAgent = (projects: Project[], hostId: string, agent: DiscoveredAgent) => projects.find((project) => project.hostId === hostId && agent.cwd && normalizedFolder(agent.cwd) === normalizedFolder(project.path))
const observedAgents = (state: AppState) => {
  const sessions = new Map<string, { hostId: string; agent: DiscoveredAgent; project?: Project }>()
  const indexedSessions = [...state.sessions, ...state.settings.pinnedSessions, ...state.settings.archivedSessions]
  for (const [hostId, agents] of Object.entries(state.discoveredAgentsByHost || {})) for (const agent of agents) {
    if (agent.managed_run_id || /codex-code-mode-host|app-server(?:\s|$)/.test(agent.command)) continue
    if (agent.native_session_id && indexedSessions.some((session) => session.hostId === hostId && session.provider === agent.provider && session.nativeSessionId === agent.native_session_id)) continue
    const key = `${hostId}:${agent.process_group_id || agent.pid}`
    if (!sessions.has(key)) sessions.set(key, { hostId, agent, project: projectForAgent(state.projects, hostId, agent) })
  }
  return [...sessions.values()]
}
const projectItemPageSize = 5
function SidebarHarness({ provider }: { provider: Provider['id'] }) { const label = providerName(provider); return <span className={`sidebar-harness provider-${provider}`} title={label} aria-label={label}>{providerIcon(provider)}</span> }
const sessionKey = (session: Pick<ProviderSession, 'hostId' | 'id'>) => `${session.hostId}:${session.id}`
const recentFirst = (left: ProviderSession, right: ProviderSession) => right.sortAt.localeCompare(left.sortAt) || Number(right.status === 'running') - Number(left.status === 'running')
const runEventNotificationKey = (_hostId: string, runId: string) => `run:${runId}`
const sessionNotificationKey = (session: Pick<ProviderSession, 'hostId' | 'provider' | 'nativeSessionId'>) => `session:${session.hostId}:${session.provider}:${session.nativeSessionId}`
const runNotificationKeys = (run: Pick<Run, 'hostId' | 'id' | 'provider' | 'sessionId'>) => [runEventNotificationKey(run.hostId, run.id), ...(run.sessionId ? [`session:${run.hostId}:${run.provider}:${run.sessionId}`] : [])]
const reconcileUnreadKeys = (current: Set<string>, state: AppState) => {
  const sessions = [...state.sessions, ...state.settings.pinnedSessions, ...state.settings.archivedSessions]
  const validSessionKeys = new Set(sessions.map(sessionNotificationKey))
  const runsByKey = new Map(state.runs.map((run) => [runEventNotificationKey(run.hostId, run.id), run]))
  for (const run of state.runs) if (run.sessionId) validSessionKeys.add(`session:${run.hostId}:${run.provider}:${run.sessionId}`)
  const next = new Set<string>()
  for (const key of current) {
    if (validSessionKeys.has(key)) { next.add(key); continue }
    const run = runsByKey.get(key)
    if (!run) continue
    next.add(run.sessionId ? `session:${run.hostId}:${run.provider}:${run.sessionId}` : key)
  }
  return next
}
const notificationEventKinds = new Set(['run.completed', 'run.failed', 'run.interrupted', 'run.killed', 'run.orphaned', 'input.required', 'approval.required'])
const terminalRunStatuses = new Set<Run['status']>(['completed', 'failed', 'interrupted', 'killed', 'orphaned'])
const terminalStatusByEventKind = new Map<string, Run['status']>([...terminalRunStatuses].map((status) => [`run.${status}`, status]))
const terminalNotificationTag = (runId: string, status: Run['status']) => `run-status:${runId}:${status}`
const draftTitle = (draft: DraftSession) => { const text = draft.prompt?.trim().replace(/\s+/g, ' ') || ''; return text.length > 46 ? `${text.slice(0, 45)}…` : text }
const pathLike = (value: string) => { const query = value.trim(); return query.startsWith('/') || query.startsWith('~') || query.includes('/') }
const mergeEvents = (prior: RunEvent[], incoming: RunEvent[]) => {
  const merged = new Map(prior.map((event) => [event.event_id, event]))
  for (const event of incoming) merged.set(event.event_id, event)
  return [...merged.values()].sort((left, right) => left.run_sequence - right.run_sequence)
}
const mergeSessionMessages = (prior: SessionMessage[], incoming: SessionMessage[]) => {
  if (!incoming.length) return prior
  const incomingById = new Map(incoming.map((item) => [item.id, item]))
  const priorIds = new Set(prior.map((item) => item.id))
  const next = prior.map((item) => {
    const replacement = incomingById.get(item.id)
    if (!replacement) return item
    const unchanged = item.timestamp === replacement.timestamp && item.role === replacement.role && item.text === replacement.text && item.kind === replacement.kind && item.duration_ms === replacement.duration_ms && JSON.stringify(item.meta) === JSON.stringify(replacement.meta)
    return unchanged ? item : replacement
  })
  for (const item of incoming) if (!priorIds.has(item.id)) next.push(item)
  return next.length === prior.length && next.every((item, index) => item === prior[index]) ? prior : next
}
type ExternalTranscriptWatch = { seen: Set<string>; after?: string; initialized: boolean; turnOpen: boolean; pendingCompletion?: { messageId: string; detectedAt: number } }
const externalCompletionSettleMs = 12_000
const transcriptTurnOpen = (messages: SessionMessage[], sessionStatus: ProviderSession['status']) => {
  let lastActivity = -1; let lastCompletion = -1
  messages.forEach((message, index) => { if (message.kind === 'turn_completed') lastCompletion = index; else lastActivity = index })
  return lastActivity > lastCompletion || (lastCompletion < 0 && sessionStatus === 'running')
}
const coalesceStreamEvents = (events: RunEvent[]) => {
  const result: RunEvent[] = []
  for (const event of events) {
    const itemId = typeof event.payload.item_id === 'string' ? event.payload.item_id : ''
    const stream = itemId && ['assistant.message', 'reasoning.message', 'tool.output'].includes(event.kind)
    const prior = result.at(-1)
    if (stream && prior?.kind === event.kind && prior.channel === event.channel && prior.payload.item_id === itemId) {
      const replacePayload = event.kind === 'tool.output' || event.kind === 'file.change'
      const finalItem = event.provider_event_type === 'codex.item/completed'
      const nextText = replacePayload || finalItem ? String(event.payload.text || prior.payload.text || '') : `${String(prior.payload.text || '')}${String(event.payload.text || '')}`
      result[result.length - 1] = { ...prior, ...event, payload: { ...prior.payload, ...event.payload, text: nextText } }
    } else result.push(event)
  }
  return result
}
const currentBranchEvents = (events: RunEvent[]) => {
  let rewindIndex = -1
  for (let index = events.length - 1; index >= 0; index--) if (events[index].kind === 'thread.session' && (events[index].raw_payload as { action?: string })?.action === 'rewind') { rewindIndex = index; break }
  if (rewindIndex < 0) return events
  const lastTurnId = typeof events[rewindIndex].payload.last_turn_id === 'string' ? events[rewindIndex].payload.last_turn_id : null
  if (!lastTurnId) return events.slice(rewindIndex)
  let prefixEnd = -1
  for (let index = 0; index < rewindIndex; index++) if (events[index].payload.turn_id === lastTurnId) prefixEnd = index
  return [...events.slice(0, prefixEnd + 1), ...events.slice(rewindIndex)]
}
const pendingQueue = (events: RunEvent[]) => {
  const queued = new Map<string, { id: string; message: string; error?: string }>()
  for (const event of events) {
    const id = typeof event.payload.queue_id === 'string' ? event.payload.queue_id : ''
    if (!id) continue
    if (event.kind === 'queue.added' || event.kind === 'queue.failed') { const raw = event.raw_payload as { error?: { message?: string } }; queued.set(id, { id, message: String(event.payload.text || ''), error: event.kind === 'queue.failed' ? raw?.error?.message || 'Failed to start' : undefined }) }
    else if (event.kind === 'queue.started' || event.kind === 'queue.removed') queued.delete(id)
  }
  return [...queued.values()]
}
const folderMatchScore = (entry: FileEntry, rawQuery: string) => {
  const query = rawQuery.trim().toLowerCase(); const name = entry.name.toLowerCase(); const fullPath = entry.path.toLowerCase()
  if (!query) return 0
  if (name === query) return 0
  if (name.startsWith(query)) return 1
  if (name.includes(query)) return 2
  if (fullPath.includes(query)) return 3
  let cursor = 0
  for (const character of name) if (character === query[cursor]) cursor += 1
  return cursor === query.length ? 4 : Number.POSITIVE_INFINITY
}
const loadStringSet = (key: string) => {
  try { const value = JSON.parse(localStorage.getItem(key) || '[]'); return new Set<string>(Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []) }
  catch { return new Set<string>() }
}
const loadExpandedProjects = () => { const current = loadStringSet('codesk.expanded-projects:v1'); return current.size ? current : loadStringSet('codesk.expanded-projects') }
const saveStringSet = (key: string, value: Set<string>) => { try { localStorage.setItem(key, JSON.stringify([...value])) } catch {} }
const composerDraftStorageKey = 'codesk.composer-drafts:v1'
const loadComposerDrafts = () => {
  try { const value = JSON.parse(localStorage.getItem(composerDraftStorageKey) || '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, string> : {} }
  catch { return {} }
}
const loadComposerDraft = (key: string) => loadComposerDrafts()[key] || ''
const saveComposerDraft = (key: string, value: string) => {
  try {
    const drafts = loadComposerDrafts()
    if (value) drafts[key] = value; else delete drafts[key]
    localStorage.setItem(composerDraftStorageKey, JSON.stringify(drafts))
  } catch {}
}
function usePersistentComposerDraft(key: string) {
  const [value, setValueState] = useState(() => loadComposerDraft(key))
  const setValue = (next: string | ((current: string) => string)) => setValueState((current) => {
    const resolved = typeof next === 'function' ? next(current) : next
    saveComposerDraft(key, resolved)
    return resolved
  })
  return [value, setValue] as const
}
const normalizeState = (value: AppState) => ({ ...value, drafts: value.drafts || [], settings: { notifications: value.settings?.notifications ?? true, pinnedSessionKeys: value.settings?.pinnedSessionKeys || [], pinnedSessions: value.settings?.pinnedSessions || [], archivedSessionKeys: value.settings?.archivedSessionKeys || [], archivedSessions: value.settings?.archivedSessions || [] } })
const conversationText = (value: string) => {
  const hadContext = environmentContextPattern.test(value)
  environmentContextPattern.lastIndex = 0
  return { text: value.replace(environmentContextPattern, '').trim(), hadContext }
}
const durationLabel = (durationMs: number) => {
  const seconds = Math.max(0, Math.round(durationMs / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60); const remainder = seconds % 60
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`
}

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
  const [unreadKeys, setUnreadKeys] = useState<Set<string>>(() => loadStringSet('codesk.unread-notifications:v1'))
  useEffect(() => {
    if (!isTauriDesktop()) return
    void import('@tauri-apps/api/window')
      .then(({ getCurrentWindow }) => getCurrentWindow().setBadgeCount(unreadKeys.size || undefined))
      .catch(() => {})
  }, [unreadKeys.size])
  stateRef.current = state
  const updateUnread = (added: string[], removed: string[] = []) => setUnreadKeys((current) => {
    const next = new Set(current); let changed = false
    for (const key of removed) changed = next.delete(key) || changed
    for (const key of added) if (!next.has(key)) { next.add(key); changed = true }
    if (!changed) return current
    saveStringSet('codesk.unread-notifications:v1', next)
    return next
  })
  const reconcileUnread = (snapshot: AppState) => setUnreadKeys((current) => {
    const next = reconcileUnreadKeys(current, snapshot)
    if (next.size === current.size && [...next].every((key) => current.has(key))) return current
    saveStringSet('codesk.unread-notifications:v1', next)
    return next
  })
  const addUnread = (keys: string[]) => updateUnread(keys)
  const clearUnread = (keys: string[]) => updateUnread([], keys)
  const readRun = (run: Run) => clearUnread(runNotificationKeys(run))
  const readSession = (session: ProviderSession) => clearUnread([sessionNotificationKey(session), ...stateRef.current.runs.filter((run) => run.hostId === session.hostId && run.provider === session.provider && run.sessionId === session.nativeSessionId).flatMap(runNotificationKeys)])
  const markRunUnread = (runId: string) => {
    const run = stateRef.current.runs.find((item) => item.id === runId)
    const runKey = runEventNotificationKey(run?.hostId || 'unknown', runId)
    if (run?.sessionId) updateUnread([`session:${run.hostId}:${run.provider}:${run.sessionId}`], [runKey])
    else addUnread([runKey])
  }
  const notifyRunEvent = (event: RunEvent) => {
    if (!notificationEventKinds.has(event.kind)) return
    const run = stateRef.current.runs.find((item) => item.id === event.run_id)
    const terminalStatus = terminalStatusByEventKind.get(event.kind)
    const tag = terminalStatus ? terminalNotificationTag(event.run_id, terminalStatus) : event.event_id
    if (notified.current.has(tag)) return
    notified.current.add(tag); localStorage.setItem('codesk.notifications', JSON.stringify([...notified.current].slice(-500)))
    markRunUnread(event.run_id)
    if (!stateRef.current.settings.notifications) return
    const label = event.kind === 'input.required' ? 'Input required' : event.kind === 'approval.required' ? 'Approval required' : `Run ${terminalStatus || 'updated'}`
    void notify(`Codesk · ${label}`, String(event.payload.text || run?.title || 'Agent run updated'), tag)
  }
  const initializeSelection = (next: AppState) => {
    const firstDraft = next.drafts[0]; const firstSession = next.sessions[0] || next.settings.pinnedSessions[0]; const firstRun = next.runs[0]
    selectedRunRef.current = !firstDraft && !firstSession ? firstRun || null : null
    if (firstDraft) setSelectedDraftId(firstDraft.id); else if (firstSession) setSelectedSessionKey(sessionKey(firstSession)); else setSelectedId(firstRun?.id || null)
    const firstProject = firstDraft ? next.projects.find((item) => item.id === firstDraft.projectId && item.hostId === firstDraft.hostId) : firstSession ? next.projects.find((item) => item.id === firstSession.projectId && item.hostId === firstSession.hostId) : firstRun ? next.projects.find((item) => item.id === firstRun.projectId && item.hostId === firstRun.hostId) : next.projects[0]
    setSelectedProjectKey(firstProject ? projectKey(firstProject) : null); initialized.current = true
  }
  const reload = async () => { try { const next = normalizeState(await api.state()); reconcileUnread(next); const selectedRun = selectedRunRef.current; const refreshedRun = selectedRun && next.runs.find((item) => item.id === selectedRun.id); if (refreshedRun) selectedRunRef.current = refreshedRun; else if (selectedRun) next.runs = [selectedRun, ...next.runs.filter((item) => item.id !== selectedRun.id)]; setState(next); setExtraSessions((current) => { const refreshed = { ...current }; for (const [key, items] of Object.entries(refreshed)) { const latest = new Map(next.sessions.filter((item) => `${item.hostId}:${item.projectId}` === key).map((item) => [sessionKey(item), item])); refreshed[key] = items.map((item) => latest.get(sessionKey(item)) || item) } return refreshed }); setError(''); if (!initialized.current) initializeSelection(next) } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } }
  useEffect(() => { let cancelled = false; api.navigation().then((value) => { if (cancelled || initialized.current) return; const next = normalizeState(value); setState(next); reconcileUnread(next); if (next.projects.length || next.drafts.length || next.sessions.length || next.runs.length || next.settings.pinnedSessions.length) initializeSelection(next) }).catch(() => {}); return () => { cancelled = true } }, [])
  useEffect(() => {
    let cancelled = false; let timer = 0; let loading = false
    const poll = async () => {
      if (cancelled || loading || document.hidden) return
      loading = true
      try { await reload() } finally { loading = false }
      if (!cancelled && !document.hidden) timer = window.setTimeout(poll, 15_000)
    }
    const visibility = () => { clearTimeout(timer); if (!document.hidden) void poll() }
    document.addEventListener('visibilitychange', visibility)
    void poll()
    return () => { cancelled = true; clearTimeout(timer); document.removeEventListener('visibilitychange', visibility) }
  }, [])
  const run = state.runs.find((item) => item.id === selectedId) || null
  const session = [...state.sessions, ...Object.values(extraSessions).flat(), ...state.settings.pinnedSessions, ...state.settings.archivedSessions].find((item) => sessionKey(item) === selectedSessionKey) || null
  selectedSessionNotificationKeyRef.current = session ? sessionNotificationKey(session) : null
  const sessionHostStatus = session ? state.hosts.find((item) => item.id === session.hostId)?.status : undefined
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
    return () => { window.removeEventListener('focus', readSelected); document.removeEventListener('visibilitychange', readSelected) }
  }, [run?.id, selectedSessionKey])
  useEffect(() => { if (!run || events[run.id]) return; api.events(run.hostId, run.id).then((items) => setEvents((current) => ({ ...current, [run.id]: items }))).catch(() => {}) }, [run?.id])
  useEffect(() => {
    if (!session || !selectedSessionKey || sessionHostStatus !== 'online') return
    let stopped = false
    let timer = 0
    let idleDelay = 2000
    const load = async () => {
      const prior = sessionMessagesRef.current[selectedSessionKey] || []
      const after = [...prior].reverse().find((item) => item.timestamp)?.timestamp
      try {
        const incoming = await api.sessionMessages(session.hostId, session.projectId, session.provider, session.nativeSessionId, after)
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
    const visibility = () => { clearTimeout(timer); if (!document.hidden) { idleDelay = 2000; void poll() } }
    document.addEventListener('visibilitychange', visibility)
    void poll()
    return () => { stopped = true; clearTimeout(timer); document.removeEventListener('visibilitychange', visibility) }
  }, [selectedSessionKey, session?.hostId, session?.projectId, session?.provider, session?.nativeSessionId, session?.status, sessionHostStatus])
  const liveExternalSessionSignature = state.sessions.filter((item) => item.pid).map((item) => sessionNotificationKey(item)).sort().join('|')
  useEffect(() => {
    let stopped = false; let timer = 0; let loading = false
    const pollSession = async (session: ProviderSession) => {
      const key = sessionNotificationKey(session)
      let watch = externalTranscriptWatches.current.get(key)
      if (!watch) {
        watch = { seen: new Set(), initialized: false, turnOpen: false }
        externalTranscriptWatches.current.set(key, watch)
      }
      try {
        const incoming = await api.sessionMessages(session.hostId, session.projectId, session.provider, session.nativeSessionId, watch.after)
        if (stopped) return
        const latestTimestamp = incoming.reduce((latest, message) => message.timestamp > latest ? message.timestamp : latest, watch.after || '')
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
          if (!notified.current.has(tag)) watch.pendingCompletion = { messageId: message.id, detectedAt: Date.now() }
        }
        const pending = watch.pendingCompletion
        if (pending && !watch.turnOpen && session.status !== 'running' && Date.now() - pending.detectedAt >= externalCompletionSettleMs) {
          watch.pendingCompletion = undefined
          const tag = `session-turn:${session.hostId}:${session.provider}:${session.nativeSessionId}:${pending.messageId}`
          if (!notified.current.has(tag)) {
            notified.current.add(tag); localStorage.setItem('codesk.notifications', JSON.stringify([...notified.current].slice(-500)))
            sessionCompletionNotifiedAt.current.set(key, Date.now())
            const activelyViewing = !document.hidden && document.hasFocus() && selectedSessionNotificationKeyRef.current === key
            if (!activelyViewing) {
              addUnread([key])
              if (stateRef.current.settings.notifications) void notify('Codesk · Turn completed', session.title, tag)
            }
          }
        }
      } catch {}
    }
    const poll = async () => {
      if (stopped || loading) return
      loading = true
      const snapshot = stateRef.current
      const managedSessions = new Set(snapshot.runs.flatMap((run) => run.sessionId ? [`${run.hostId}:${run.provider}:${run.sessionId}`] : []))
      const sessions = snapshot.sessions.filter((session) => session.pid && snapshot.hosts.find((host) => host.id === session.hostId)?.status === 'online' && !managedSessions.has(`${session.hostId}:${session.provider}:${session.nativeSessionId}`))
      const activeKeys = new Set(sessions.map(sessionNotificationKey))
      for (const key of externalTranscriptWatches.current.keys()) if (!activeKeys.has(key)) externalTranscriptWatches.current.delete(key)
      await Promise.all(sessions.map(pollSession))
      loading = false
      if (stopped) return
      const needsFastPoll = sessions.some((session) => { const watch = externalTranscriptWatches.current.get(sessionNotificationKey(session)); return watch?.turnOpen || watch?.pendingCompletion })
      timer = window.setTimeout(poll, needsFastPoll ? 3_000 : 15_000)
    }
    void poll()
    return () => { stopped = true; clearTimeout(timer) }
  }, [liveExternalSessionSignature])
  useEffect(() => {
    const origin = gatewayOrigin ? gatewayOrigin.replace('http://', 'ws://').replace('https://', 'wss://') : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`
    let ws: WebSocket | null = null; let stopped = false; let retry = 500
    const replay = async () => { const snapshot = await api.state(); await Promise.all(snapshot.runs.map(async (item) => { const incoming = await api.events(item.hostId, item.id); setEvents((current) => ({ ...current, [item.id]: mergeEvents(current[item.id] || [], incoming) })) })) }
    const connect = () => { if (stopped) return; ws = new WebSocket(`${origin}/ws`); ws.onopen = () => { retry = 500; void reload(); void replay().catch(() => {}) }; ws.onmessage = (message) => { const envelope = JSON.parse(message.data); if (envelope.type === 'daemon.event') { const event = envelope.payload.event as RunEvent; setEvents((current) => { const prior = current[event.run_id] || []; return prior.some((item) => item.event_id === event.event_id) ? current : { ...current, [event.run_id]: [...prior, event].sort((a, b) => a.run_sequence - b.run_sequence) } }); if (event.kind.startsWith('run.') || event.kind.startsWith('control.') || event.kind.startsWith('turn.') || event.kind.startsWith('thread.') || event.kind.startsWith('queue.')) void reload(); notifyRunEvent(event) } else if (envelope.type.startsWith('host.') || envelope.type.startsWith('draft.') || envelope.type === 'settings.updated' || envelope.type === 'state.updated') void reload() }; ws.onclose = () => { if (!stopped) { window.setTimeout(connect, retry); retry = Math.min(10000, retry * 1.8) } }; ws.onerror = () => ws?.close() }
    connect(); return () => { stopped = true; ws?.close() }
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
          notified.current.add(tag); localStorage.setItem('codesk.notifications', JSON.stringify([...notified.current].slice(-500)))
          markRunUnread(run.id)
          if (state.settings.notifications) void notify(`Codesk · Run ${run.status}`, run.title, tag)
        }
      }
      priorRunStatus.current.set(run.id, run.status)
    }
  }, [state.runs, state.settings.notifications])
  useEffect(() => {
    for (const session of state.sessions) {
      const key = `${session.hostId}:${session.id}`; const prior = priorSessionStatus.current.get(key)
      const notificationKey = sessionNotificationKey(session)
      const managed = state.runs.some((run) => run.hostId === session.hostId && run.provider === session.provider && run.sessionId === session.nativeSessionId)
      if (session.status === 'running' && !managed) clearUnread([notificationKey])
      if (session.status === 'stopped' && prior === 'running') {
        const completionAt = sessionCompletionNotifiedAt.current.get(notificationKey) || 0
        if (Date.now() - completionAt >= 120_000) {
          addUnread([notificationKey])
          if (state.settings.notifications) {
            const tag = `session-stopped:${key}:${session.updatedAt}`
            if (!notified.current.has(tag)) { notified.current.add(tag); localStorage.setItem('codesk.notifications', JSON.stringify([...notified.current].slice(-500))); void notify('Codesk · Agent stopped', session.title, tag) }
          }
        }
      }
      priorSessionStatus.current.set(key, session.status)
    }
  }, [state.sessions, state.settings.notifications])
  const allSessions = useMemo(() => {
    const merged = new Map([...state.settings.pinnedSessions, ...state.settings.archivedSessions, ...state.sessions].map((item) => [sessionKey(item), item]))
    for (const items of Object.values(extraSessions)) for (const item of items) merged.set(sessionKey(item), item)
    return [...merged.values()]
  }, [state.sessions, state.settings.pinnedSessions, state.settings.archivedSessions, extraSessions])
  const archivedSessions = state.settings.archivedSessionKeys.map((key) => allSessions.find((item) => sessionKey(item) === key)).filter((item): item is ProviderSession => Boolean(item)).sort(recentFirst)
  const agents = useMemo(() => observedAgents(state), [state])
  const selectedAgent = agents.find(({ hostId, agent }) => `${hostId}:${agent.id}` === selectedAgentKey) || null
  const project = draft ? state.projects.find((item) => item.id === draft.projectId && item.hostId === draft.hostId) : session ? state.projects.find((item) => item.id === session.projectId && item.hostId === session.hostId) : run ? state.projects.find((item) => item.id === run.projectId && item.hostId === run.hostId) : selectedAgent?.project || state.projects.find((item) => projectKey(item) === selectedProjectKey) || state.projects[0]
  const host = project ? state.hosts.find((item) => item.id === project.hostId) : state.hosts[0]
  const provider = run ? state.providersByHost[run.hostId]?.find((item) => item.id === run.provider) : undefined
  const sessionProvider = session ? state.providersByHost[session.hostId]?.find((item) => item.id === session.provider) : undefined
  const clearSelectedRun = () => { selectedRunRef.current = null }
  const selectProject = (next: Project) => { clearSelectedRun(); setSelectedProjectKey(projectKey(next)); setSelectedId(null); setSelectedSessionKey(null); setSelectedAgentKey(null); setSelectedDraftId(null) }
  const selectRun = (next: Run) => { selectedRunRef.current = next; setState((current) => ({ ...current, runs: [next, ...current.runs.filter((item) => item.id !== next.id)] })); setSelectedId(next.id); setSelectedSessionKey(null); setSelectedAgentKey(null); setSelectedDraftId(null); setSelectedProjectKey(`${next.hostId}:${next.projectId}`) }
  const selectSession = (next: ProviderSession) => {
    const activeRun = state.runs.find((item) => item.hostId === next.hostId && item.projectId === next.projectId && item.provider === next.provider && item.sessionId === next.nativeSessionId && active.has(item.status))
    if (activeRun && activeRun.inputTransport !== 'tmux') { selectRun(activeRun); return }
    clearSelectedRun(); setSelectedSessionKey(`${next.hostId}:${next.id}`); setSelectedId(null); setSelectedAgentKey(null); setSelectedDraftId(null); setSelectedProjectKey(`${next.hostId}:${next.projectId}`)
  }
  useEffect(() => {
    if (run?.inputTransport !== 'tmux' || !run.sessionId) return
    const matching = allSessions.find((item) => item.hostId === run.hostId && item.projectId === run.projectId && item.provider === run.provider && item.nativeSessionId === run.sessionId)
    if (matching) selectSession(matching)
  }, [run?.id, run?.inputTransport, run?.sessionId, allSessions])
  const selectDraft = (next: DraftSession) => { clearSelectedRun(); setSelectedDraftId(next.id); setSelectedId(null); setSelectedSessionKey(null); setSelectedAgentKey(null); setSelectedProjectKey(`${next.hostId}:${next.projectId}`) }
  const selectAgent = (hostId: string, agent: DiscoveredAgent, nextProject?: Project) => { clearSelectedRun(); setSelectedAgentKey(`${hostId}:${agent.id}`); setSelectedId(null); setSelectedSessionKey(null); setSelectedDraftId(null); if (nextProject) setSelectedProjectKey(projectKey(nextProject)) }
  const newDraft = async (nextProject = project) => { if (!nextProject) return; try { selectDraft(await api.createDraft({ hostId: nextProject.hostId, projectId: nextProject.id })) } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } }
  const togglePin = async (nextSession: ProviderSession) => {
    const key = sessionKey(nextSession); const pinned = state.settings.pinnedSessionKeys; const isPinned = pinned.includes(key)
    const pinnedSessionKeys = isPinned ? pinned.filter((item) => item !== key) : [...pinned, key]
    const pinnedSessions = isPinned ? state.settings.pinnedSessions.filter((item) => sessionKey(item) !== key) : [...state.settings.pinnedSessions.filter((item) => sessionKey(item) !== key), nextSession]
    const prior = state.settings
    setState((current) => ({ ...current, settings: { ...current.settings, pinnedSessionKeys, pinnedSessions } }))
    try { const settings = await api.updateSettings({ pinnedSessionKeys, pinnedSessions }); setState((current) => ({ ...current, settings })) }
    catch (cause) { setState((current) => ({ ...current, settings: prior })); setError(cause instanceof Error ? cause.message : String(cause)) }
  }
  const toggleArchive = async (nextSession: ProviderSession) => {
    const key = sessionKey(nextSession); const archived = state.settings.archivedSessionKeys; const isArchived = archived.includes(key)
    const archivedSessionKeys = isArchived ? archived.filter((item) => item !== key) : [...archived, key]
    const archivedSnapshots = isArchived ? state.settings.archivedSessions.filter((item) => sessionKey(item) !== key) : [...state.settings.archivedSessions.filter((item) => sessionKey(item) !== key), nextSession]
    const pinnedSessionKeys = isArchived ? state.settings.pinnedSessionKeys : state.settings.pinnedSessionKeys.filter((item) => item !== key)
    const pinnedSessions = isArchived ? state.settings.pinnedSessions : state.settings.pinnedSessions.filter((item) => sessionKey(item) !== key)
    const prior = state.settings; const nextSettings = { ...prior, archivedSessionKeys, archivedSessions: archivedSnapshots, pinnedSessionKeys, pinnedSessions }
    setState((current) => ({ ...current, settings: nextSettings }))
    if (!isArchived && selectedSessionKey === key) setSelectedSessionKey(null)
    try { const saved = await api.updateSettings({ archivedSessionKeys, archivedSessions: archivedSnapshots, pinnedSessionKeys, pinnedSessions }); setState((current) => ({ ...current, settings: saved })) }
    catch (cause) { setState((current) => ({ ...current, settings: prior })); if (!isArchived && selectedSessionKey === key) setSelectedSessionKey(key); setError(cause instanceof Error ? cause.message : String(cause)) }
  }
  const archiveProjectSessions = async (nextProject: Project) => {
    const projectSessions = allSessions.filter((item) => item.hostId === nextProject.hostId && item.projectId === nextProject.id && !state.settings.archivedSessionKeys.includes(sessionKey(item)))
    if (!projectSessions.length) return
    const keysToArchive = new Set(projectSessions.map(sessionKey))
    const prior = state.settings
    const archivedSessionKeys = [...new Set([...prior.archivedSessionKeys, ...keysToArchive])]
    const archivedSessions = [...new Map([...prior.archivedSessions, ...projectSessions].map((item) => [sessionKey(item), item])).values()]
    const pinnedSessionKeys = prior.pinnedSessionKeys.filter((key) => !keysToArchive.has(key))
    const pinnedSessions = prior.pinnedSessions.filter((item) => !keysToArchive.has(sessionKey(item)))
    const nextSettings = { ...prior, archivedSessionKeys, archivedSessions, pinnedSessionKeys, pinnedSessions }
    setState((current) => ({ ...current, settings: nextSettings }))
    if (selectedSessionKey && keysToArchive.has(selectedSessionKey)) setSelectedSessionKey(null)
    try { const saved = await api.updateSettings({ archivedSessionKeys, archivedSessions, pinnedSessionKeys, pinnedSessions }); setState((current) => ({ ...current, settings: saved })) }
    catch (cause) { setState((current) => ({ ...current, settings: prior })); setError(cause instanceof Error ? cause.message : String(cause)) }
  }
  const removeProject = async (nextProject: Project) => {
    const key = projectKey(nextProject)
    setRemovingProject(true)
    setError('')
    try {
      await api.removeProject(nextProject.hostId, nextProject.id)
      setExtraSessions((current) => { const next = { ...current }; delete next[key]; return next })
        if (selectedProjectKey === key) { clearSelectedRun(); setSelectedId(null); setSelectedSessionKey(null); setSelectedAgentKey(null); setSelectedDraftId(null); setSelectedProjectKey(null) }
      setProjectToRemove(null)
      await reload()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setRemovingProject(false) }
  }
  return <div className="codex-shell">
    <Sidebar state={state} runs={state.runs} sessions={allSessions} agents={agents} unreadKeys={unreadKeys} selectedId={selectedId} selectedSessionKey={selectedSessionKey} selectedAgentKey={selectedAgentKey} selectedDraftId={selectedDraftId} selectedProjectKey={selectedProjectKey} query={query} onQuery={setQuery} onSelectRun={(next) => { readRun(next); selectRun(next) }} onSelectSession={(next) => { readSession(next); selectSession(next) }} onSelectDraft={selectDraft} onSelectAgent={selectAgent} onSelectProject={selectProject} onRemoveProject={setProjectToRemove} onArchiveProject={archiveProjectSessions} onTogglePin={togglePin} onToggleArchive={toggleArchive} onRefreshProject={async (project) => { try { const key = projectKey(project); const items = await api.refreshProjectSessions(project.hostId, project.id); setExtraSessions((current) => ({ ...current, [key]: items })); setState((current) => ({ ...current, sessions: [...current.sessions.filter((session) => session.hostId !== project.hostId || session.projectId !== project.id), ...items].sort(recentFirst) })) } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } }} onShowMore={async (project, visibleLimit) => { const key = projectKey(project); try { const items = await api.projectSessions(project.hostId, project.id, visibleLimit + 1); setExtraSessions((current) => ({ ...current, [key]: items })); return true } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return false } }} onNewRun={() => void newDraft()} onNewProject={() => setNewProject(true)} onSettings={() => setSettings(true)} onArchives={() => setArchives(true)} />
    <section className="codex-main">
      {session ? <SessionScreen key={`session:${sessionNotificationKey(session)}`} session={session} messages={sessionMessages[selectedSessionKey!] || []} project={project} host={host} provider={sessionProvider} onStarted={(next) => { selectRun(next); void reload() }} onError={setError} /> : run ? <RunScreen key={`run:${run.hostId}:${run.id}`} run={run} events={events[run.id] || []} project={project} host={host} provider={provider} onStarted={(next) => { selectRun(next); void reload() }} onError={setError} /> : selectedAgent ? <ObservedScreen key={`agent:${selectedAgent.hostId}:${selectedAgent.agent.id}`} host={state.hosts.find((item) => item.id === selectedAgent.hostId)} project={selectedAgent.project} provider={state.providersByHost[selectedAgent.hostId]?.find((item) => item.id === selectedAgent.agent.provider)} agent={selectedAgent.agent} onStarted={(next) => { selectRun(next); void reload() }} onError={setError} /> : <StartScreen key={draft?.id || (project ? projectKey(project) : 'empty')} state={state} draft={draft || undefined} project={project} host={host} onProject={() => setNewProject(true)} onStarted={(next) => { selectRun(next); void reload() }} onError={setError} />}
    </section>
    {error && <div className="toast-error">{error}<button onClick={() => setError('')}><X size={14} /></button></div>}
    {newProject && <ProjectDialog hosts={state.hosts} onClose={() => setNewProject(false)} onCreated={async () => { setNewProject(false); await reload() }} />}
    {settings && <ConnectionsDialog hosts={state.hosts} onClose={() => setSettings(false)} onChanged={reload} />}
    {archives && <ArchivedChatsDialog sessions={archivedSessions} runs={state.runs} unreadKeys={unreadKeys} projects={state.projects} hosts={state.hosts} onOpen={(next) => { readSession(next); selectSession(next); setArchives(false) }} onRestore={toggleArchive} onClose={() => setArchives(false)} />}
    {projectToRemove && <RemoveProjectDialog project={projectToRemove} busy={removingProject} onClose={() => { if (!removingProject) setProjectToRemove(null) }} onConfirm={() => void removeProject(projectToRemove)} />}
  </div>
}

function Sidebar({ state, runs, sessions, agents, unreadKeys, selectedId, selectedSessionKey, selectedAgentKey, selectedDraftId, selectedProjectKey, query, onQuery, onSelectRun, onSelectSession, onSelectDraft, onSelectAgent, onSelectProject, onRemoveProject, onArchiveProject, onTogglePin, onToggleArchive, onRefreshProject, onShowMore, onNewRun, onNewProject, onSettings, onArchives }: {
  state: AppState; runs: Run[]; sessions: ProviderSession[]; agents: ReturnType<typeof observedAgents>
  unreadKeys: Set<string>
  selectedId: string | null; selectedSessionKey: string | null; selectedAgentKey: string | null; selectedDraftId: string | null; selectedProjectKey: string | null
  query: string; onQuery: (value: string) => void; onSelectRun: (run: Run) => void; onSelectSession: (session: ProviderSession) => void; onSelectDraft: (draft: DraftSession) => void
  onSelectAgent: (hostId: string, agent: DiscoveredAgent, project?: Project) => void; onSelectProject: (project: Project) => void; onRemoveProject: (project: Project) => void; onArchiveProject: (project: Project) => Promise<void>; onTogglePin: (session: ProviderSession) => Promise<void>; onToggleArchive: (session: ProviderSession) => Promise<void>; onRefreshProject: (project: Project) => Promise<void>
  onShowMore: (project: Project, visibleLimit: number) => Promise<boolean>; onNewRun: () => void; onNewProject: () => void; onSettings: () => void; onArchives: () => void
}) {
  const [expanded, setExpanded] = useState<Set<string>>(loadExpandedProjects)
  const [projectItemLimits, setProjectItemLimits] = useState<Map<string, number>>(() => new Map())
  const [searchOpen, setSearchOpen] = useState(Boolean(query))
  const [refreshingProjects, setRefreshingProjects] = useState<Set<string>>(() => new Set())
  const [projectMenu, setProjectMenu] = useState<{ project: Project; top: number; left: number; canArchive: boolean } | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const projectMenuRef = useRef<HTMLDivElement>(null)
  const preSearchScroll = useRef(0)
  const restoreSearchScroll = useRef(false)
  const searchScrollCaptured = useRef(false)
  const queryRef = useRef(query)
  queryRef.current = query
  const onNewRunRef = useRef(onNewRun)
  onNewRunRef.current = onNewRun
  const needle = query.trim().toLowerCase()
  const hasUnreadSession = (session: ProviderSession) => unreadKeys.has(sessionNotificationKey(session)) || runs.some((run) => run.hostId === session.hostId && run.provider === session.provider && run.sessionId === session.nativeSessionId && runNotificationKeys(run).some((key) => unreadKeys.has(key)))
  const hasUnreadRun = (run: Run) => runNotificationKeys(run).some((key) => unreadKeys.has(key))
  const unreadCount = unreadKeys.size
  const pinnedKeys = state.settings.pinnedSessionKeys
  const archivedKeys = new Set(state.settings.archivedSessionKeys)
  const pinnedSessions = pinnedKeys.map((key) => sessions.find((session) => sessionKey(session) === key)).filter((session): session is ProviderSession => Boolean(session)).filter((session) => !archivedKeys.has(sessionKey(session))).filter((session) => {
    if (!needle) return true
    const project = state.projects.find((item) => item.id === session.projectId && item.hostId === session.hostId); const host = state.hosts.find((item) => item.id === session.hostId)
    return `${session.title} ${session.provider} ${project?.name || ''} ${host?.name || ''}`.toLowerCase().includes(needle)
  })
  useEffect(() => {
    if (!selectedProjectKey) return
    setExpanded((current) => { if (current.has(selectedProjectKey)) return current; const next = new Set(current).add(selectedProjectKey); saveStringSet('codesk.expanded-projects:v1', next); return next })
  }, [selectedProjectKey])
  useEffect(() => {
    const target = [...(scroller.current?.querySelectorAll<HTMLElement>('[data-session-key]') || [])].find((item) => item.dataset.sessionKey === selectedSessionKey)
    target?.scrollIntoView({ block: 'nearest' })
  }, [selectedSessionKey])
  useEffect(() => { const element = scroller.current; if (!element) return; try { element.scrollTop = Number(localStorage.getItem('codesk.navigation-scroll:v1') || 0) } catch {} }, [])
  useEffect(() => {
    if (query || !restoreSearchScroll.current) return
    restoreSearchScroll.current = false
    const restore = () => { const element = scroller.current; if (!element) return; element.scrollTop = preSearchScroll.current; try { localStorage.setItem('codesk.navigation-scroll:v1', String(preSearchScroll.current)) } catch {} }
    restore()
    const timer = window.setTimeout(restore, 0)
    searchScrollCaptured.current = false
    return () => clearTimeout(timer)
  }, [query])
  useEffect(() => {
    const shortcuts = (event: globalThis.KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return
      if (event.key.toLowerCase() === 'k') { event.preventDefault(); if (!queryRef.current && !searchScrollCaptured.current) { preSearchScroll.current = scroller.current?.scrollTop || 0; searchScrollCaptured.current = true } setSearchOpen(true); window.setTimeout(() => searchInput.current?.focus(), 0) }
      if (event.key.toLowerCase() === 'n') { event.preventDefault(); onNewRunRef.current() }
    }
    document.addEventListener('keydown', shortcuts)
    return () => document.removeEventListener('keydown', shortcuts)
  }, [])
  useEffect(() => {
    if (!projectMenu) return
    const close = (event: PointerEvent) => { if (!projectMenuRef.current?.contains(event.target as Node)) setProjectMenu(null) }
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') setProjectMenu(null) }
    const resize = () => setProjectMenu(null)
    document.addEventListener('pointerdown', close, true)
    document.addEventListener('keydown', escape)
    window.addEventListener('resize', resize)
    return () => { document.removeEventListener('pointerdown', close, true); document.removeEventListener('keydown', escape); window.removeEventListener('resize', resize) }
  }, [projectMenu])
  const toggle = (key: string) => setExpanded((current) => { const next = new Set(current); next.has(key) ? next.delete(key) : next.add(key); saveStringSet('codesk.expanded-projects:v1', next); return next })
  const createProjectDraft = async (project: Project) => { const key = projectKey(project); if (!expanded.has(key)) toggle(key); onSelectDraft(await api.createDraft({ hostId: project.hostId, projectId: project.id })) }
  const openProjectMenu = (event: ReactMouseEvent<HTMLElement>, project: Project, canArchive: boolean) => {
    event.preventDefault(); event.stopPropagation()
    const rect = event.currentTarget.getBoundingClientRect(); const width = 226; const height = 126
    setProjectMenu({ project, canArchive, left: Math.max(10, Math.min(window.innerWidth - width - 10, rect.right - width)), top: Math.max(10, Math.min(window.innerHeight - height - 10, rect.bottom + 5)) })
  }
  const expandSessions = async (project: Project) => {
    const key = projectKey(project)
    const nextLimit = (projectItemLimits.get(key) || projectItemPageSize) + projectItemPageSize
    if (await onShowMore(project, nextLimit)) setProjectItemLimits((current) => new Map(current).set(key, nextLimit))
  }
  const refreshProject = async (project: Project) => {
    const key = projectKey(project)
    if (refreshingProjects.has(key)) return
    setRefreshingProjects((current) => new Set(current).add(key))
    setExpanded((current) => { if (current.has(key)) return current; const next = new Set(current).add(key); saveStringSet('codesk.expanded-projects:v1', next); return next })
    try { await onRefreshProject(project) }
    finally { setRefreshingProjects((current) => { const next = new Set(current); next.delete(key); return next }) }
  }
  const updateQuery = (value: string) => {
    if (!query && value && !searchScrollCaptured.current) { preSearchScroll.current = scroller.current?.scrollTop || 0; searchScrollCaptured.current = true }
    const restore = Boolean(query && !value)
    if (restore) restoreSearchScroll.current = true
    onQuery(value)
  }
  const openSearch = () => { setSearchOpen(true); window.setTimeout(() => searchInput.current?.focus(), 0) }
  let visibleProjectCount = 0
  return <aside className="codex-sidebar">
    <div className="sidebar-top"><img className="app-logo" src={logoUrl} alt="" /><strong>Codesk</strong><ChevronDown size={14} /><span /><button title="Search conversations" onClick={openSearch}><Search size={17} /></button><button className="notifications-button" title={unreadCount ? `${unreadCount} unread agent updates` : 'Notifications'} aria-label={unreadCount ? `${unreadCount} unread agent updates` : 'Notifications'}><Bell size={17} />{unreadCount > 0 && <i className="notifications-badge">{unreadCount > 9 ? '9+' : unreadCount}</i>}</button></div>
    <button className="side-action" onClick={onNewRun}><Plus size={17} />New chat</button>
    <button className="side-action"><GitBranch size={17} />Pull requests</button>
    <button className="side-action"><Clock3 size={17} />Scheduled</button>
    <button className="side-action"><Plug size={17} />Plugins</button>
    <div className="navigation-scroller" ref={scroller} onScroll={(event) => { setProjectMenu(null); if (needle || restoreSearchScroll.current) return; try { localStorage.setItem('codesk.navigation-scroll:v1', String(event.currentTarget.scrollTop)) } catch {} }}>
      <div className={`navigation-search ${searchOpen || query ? 'open' : ''}`} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node) && !query) setSearchOpen(false) }}><Search size={13} /><input ref={searchInput} aria-label="Search projects and conversations" value={query} onPointerDown={() => { if (!query && !searchScrollCaptured.current) { preSearchScroll.current = scroller.current?.scrollTop || 0; searchScrollCaptured.current = true } }} onFocus={() => { setSearchOpen(true); if (!query && !searchScrollCaptured.current) { preSearchScroll.current = scroller.current?.scrollTop || 0; searchScrollCaptured.current = true } }} onChange={(event) => updateQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') { updateQuery(''); setSearchOpen(false); event.currentTarget.blur() } }} placeholder="Search" />{query && <button title="Clear search" onClick={() => updateQuery('')}><X size={12} /></button>}</div>
      {pinnedSessions.length > 0 && <section className="pinned-section" aria-label="Pinned conversations"><div className="side-heading"><span>Pinned</span></div>{pinnedSessions.map((session) => {
        const key = sessionKey(session); const project = state.projects.find((item) => item.id === session.projectId && item.hostId === session.hostId); const host = state.hosts.find((item) => item.id === session.hostId)
        return <div className="pinned-row" key={key}><button data-session-key={key} className={`pinned-session ${key === selectedSessionKey ? 'selected' : ''}`} title={`${providerName(session.provider)} · ${project?.name || session.cwd} · ${host?.name || session.hostId}`} onClick={() => onSelectSession(session)} onContextMenu={(event) => { event.preventDefault(); void onTogglePin(session) }}><Pin size={12} /><span><strong><SidebarHarness provider={session.provider} />{hasUnreadSession(session) && <i className="sidebar-unread-dot" title="Unread agent update" aria-label="Unread agent update" />}<span>{session.title}</span></strong><small>{project?.name || 'Unknown project'} · {host?.name || session.hostId}</small></span></button><button className="session-pin" title="Unpin conversation" onClick={() => void onTogglePin(session)}><PinOff size={12} /></button></div>
      })}</section>}
      <section className="projects-section" aria-label="Projects"><div className="side-heading"><span>Projects</span><button title="Add project" onClick={onNewProject}><Plus size={15} /></button></div><div className="project-tree" role="tree">{state.projects.map((project) => {
        const key = projectKey(project); const host = state.hosts.find((item) => item.id === project.hostId); const refreshing = refreshingProjects.has(key)
        const allProjectDrafts = state.drafts.filter((draft) => draft.projectId === project.id && draft.hostId === project.hostId && draft.prompt?.trim())
        const providerProjectSessions = sessions.filter((session) => session.projectId === project.id && session.hostId === project.hostId)
        const allProjectSessions = providerProjectSessions.filter((session) => !archivedKeys.has(sessionKey(session))).sort(recentFirst)
        const allProjectRuns = runs.filter((run) => run.projectId === project.id && run.hostId === project.hostId && (run.id === selectedId || !providerProjectSessions.some((session) => session.nativeSessionId === run.sessionId)))
        const projectUnread = allProjectSessions.some(hasUnreadSession) || allProjectRuns.some(hasUnreadRun)
        const allProjectAgents = agents.filter((item) => item.project && projectKey(item.project) === key && !providerProjectSessions.some((session) => session.provider === item.agent.provider && session.status === 'running'))
        const projectMatches = `${project.name} ${project.path} ${host?.name || ''}`.toLowerCase().includes(needle)
        const projectDrafts = !needle || projectMatches ? allProjectDrafts : allProjectDrafts.filter((draft) => `${draftTitle(draft)} draft`.toLowerCase().includes(needle))
        const matchingSessions = !needle || projectMatches ? allProjectSessions : allProjectSessions.filter((session) => `${session.title} ${session.provider}`.toLowerCase().includes(needle))
        const projectRuns = !needle || projectMatches ? allProjectRuns : allProjectRuns.filter((run) => `${run.title} ${run.prompt} ${run.provider}`.toLowerCase().includes(needle))
        const projectAgents = !needle || projectMatches ? allProjectAgents : allProjectAgents.filter(({ agent }) => `${providerName(agent.provider)} ${agent.cwd || ''}`.toLowerCase().includes(needle))
        if (needle && !projectMatches && !projectDrafts.length && !matchingSessions.length && !projectRuns.length && !projectAgents.length) return null
        visibleProjectCount += 1
        const open = needle ? true : expanded.has(key)
        const totalProjectItems = projectDrafts.length + matchingSessions.length + projectRuns.length + projectAgents.length
        const itemLimit = needle ? totalProjectItems : projectItemLimits.get(key) || projectItemPageSize
        const unreadProjectSessions = matchingSessions.filter(hasUnreadSession)
        const unreadProjectRuns = projectRuns.filter(hasUnreadRun)
        const readProjectSessions = matchingSessions.filter((session) => !hasUnreadSession(session))
        const readProjectRuns = projectRuns.filter((run) => !hasUnreadRun(run))
        let slotsRemaining = itemLimit
        const visibleUnreadSessions = unreadProjectSessions.slice(0, slotsRemaining); slotsRemaining -= visibleUnreadSessions.length
        const visibleUnreadRuns = unreadProjectRuns.slice(0, slotsRemaining); slotsRemaining -= visibleUnreadRuns.length
        const visibleProjectDrafts = projectDrafts.slice(0, slotsRemaining); slotsRemaining -= visibleProjectDrafts.length
        const visibleReadSessions = readProjectSessions.slice(0, slotsRemaining); slotsRemaining -= visibleReadSessions.length
        const visibleReadRuns = readProjectRuns.slice(0, slotsRemaining); slotsRemaining -= visibleReadRuns.length
        const visibleProjectAgents = projectAgents.slice(0, slotsRemaining)
        const visibleProjectSessions = [...visibleUnreadSessions, ...visibleReadSessions]
        const visibleProjectRuns = [...visibleUnreadRuns, ...visibleReadRuns]
        const runningCount = allProjectSessions.filter((session) => session.status === 'running').length
        const projectOnlySelected = selectedProjectKey === key && !selectedId && !selectedSessionKey && !selectedAgentKey && !selectedDraftId
        return <div className={`project-group host-${host?.status || 'offline'}`} key={key} role="treeitem" aria-expanded={open}>
          <div className={`project-row ${projectOnlySelected ? 'selected' : ''} ${projectMenu?.project.id === project.id && projectMenu.project.hostId === project.hostId ? 'menu-open' : ''}`} onContextMenu={(event) => openProjectMenu(event, project, allProjectSessions.length > 0)}><button className="project-chevron" aria-label={`${open ? 'Collapse' : 'Expand'} ${project.name}`} onClick={() => toggle(key)}>{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</button><button className="project-main" onClick={() => onSelectProject(project)}><FolderGit2 size={14} /><strong>{project.name}</strong></button>{projectUnread && <i className="project-unread-dot" title="Unread agent update" aria-label="Unread agent update" />}{runningCount > 0 && <span className="project-running-count"><Radio size={9} />{runningCount}</span>}<button className={`project-refresh-trigger ${refreshing ? 'refreshing' : ''}`} aria-label={`Refresh sessions for ${project.name}`} title={`Refresh sessions for ${project.name}`} disabled={refreshing || host?.status !== 'online'} onClick={(event) => { event.stopPropagation(); void refreshProject(project) }}><RefreshCw className={refreshing ? 'spin' : ''} size={13} /></button><button className="project-menu-trigger" aria-label={`Project actions for ${project.name}`} aria-controls="project-actions-menu" aria-expanded={projectMenu?.project.id === project.id && projectMenu.project.hostId === project.hostId} title={`Project actions for ${project.name}`} onClick={(event) => openProjectMenu(event, project, allProjectSessions.length > 0)}><MoreHorizontal size={14} /></button><span className="project-host-tag">{host?.name || project.hostId}</span><i className={host?.status} title={host?.status || 'offline'} /></div>
          {open && <div className="project-sessions" role="group">
            {visibleProjectDrafts.map((draft) => <button key={draft.id} className={`project-session draft ${draft.id === selectedDraftId ? 'selected' : ''}`} onClick={() => onSelectDraft(draft)}><span className="recent-status"><Pencil size={10} /></span><span className="sidebar-session-title"><SidebarHarness provider={draft.provider} /><span>{draftTitle(draft)}</span></span><small className="sidebar-session-meta">{relative(draft.updatedAt)}</small></button>)}
            {visibleProjectSessions.map((session) => { const sessionId = sessionKey(session); const pinned = pinnedKeys.includes(sessionId); const unread = hasUnreadSession(session); return <div className="project-session-row" key={sessionId}><button data-session-key={sessionId} className={`project-session ${session.status} ${unread ? 'unread' : ''} ${sessionId === selectedSessionKey ? 'selected' : ''}`} title={`${providerName(session.provider)} · ${session.title}`} onClick={() => onSelectSession(session)} onContextMenu={(event) => { event.preventDefault(); void onTogglePin(session) }}><span className="recent-status">{unread ? <i className="sidebar-unread-dot" title="Unread agent update" aria-label="Unread agent update" /> : session.status === 'running' ? <Radio size={11} /> : session.status === 'stopped' ? <Circle className="stopped-dot" size={7} fill="currentColor" /> : null}</span><span className="sidebar-session-title"><SidebarHarness provider={session.provider} /><span>{session.title}</span></span>{session.status === 'running' ? <small className="running-label sidebar-session-meta"><b>Running</b></small> : <small className="sidebar-session-meta">{relative(session.updatedAt)}</small>}</button><button className="session-archive" title="Archive conversation" onClick={() => void onToggleArchive(session)}><Archive size={12} /></button><button className={`session-pin ${pinned ? 'pinned' : ''}`} title={pinned ? 'Unpin conversation' : 'Pin conversation'} onClick={() => void onTogglePin(session)}>{pinned ? <PinOff size={12} /> : <Pin size={12} />}</button></div> })}
            {visibleProjectRuns.map((run) => { const unread = hasUnreadRun(run); return <button key={`${run.hostId}:${run.id}`} className={`project-session ${unread ? 'unread' : ''} ${run.id === selectedId ? 'selected' : ''}`} title={`${providerName(run.provider)} · ${run.title}`} onClick={() => onSelectRun(run)}><span className="recent-status">{unread ? <i className="sidebar-unread-dot" title="Unread agent update" aria-label="Unread agent update" /> : active.has(run.status) ? <Radio size={11} /> : <Circle size={7} fill="currentColor" />}</span><span className="sidebar-session-title"><SidebarHarness provider={run.provider} /><span>{run.title}</span></span><small className="sidebar-session-meta">{relative(run.createdAt)}</small></button> })}
            {visibleProjectAgents.map(({ hostId, agent }) => <button key={`${hostId}:${agent.id}`} className={`project-session observed ${`${hostId}:${agent.id}` === selectedAgentKey ? 'selected' : ''}`} onClick={() => onSelectAgent(hostId, agent, project)}><span className="recent-status"><Radio size={11} /></span><span className="sidebar-session-title"><SidebarHarness provider={agent.provider} /><span>Observed session</span></span><small>observed</small></button>)}
            {!needle && totalProjectItems > itemLimit && <button className="project-show-more" onClick={() => void expandSessions(project)}>Show more</button>}
            {totalProjectItems === 0 && <div className="project-empty">No chats</div>}
          </div>}
        </div>
      })}{needle && visibleProjectCount === 0 && <div className="navigation-empty">No matching projects or conversations</div>}</div></section>
    </div>
    {projectMenu && <div id="project-actions-menu" ref={projectMenuRef} className="project-actions-menu" role="group" aria-label={`Actions for ${projectMenu.project.name}`} style={{ top: projectMenu.top, left: projectMenu.left }}><button type="button" onClick={() => { const next = projectMenu.project; setProjectMenu(null); void createProjectDraft(next) }}><Plus size={15} /><span>New chat</span></button><button type="button" disabled={!projectMenu.canArchive} onClick={() => { const next = projectMenu.project; setProjectMenu(null); void onArchiveProject(next) }}><Archive size={15} /><span>Archive chats</span></button><div className="project-actions-divider" role="separator" /><button type="button" className="danger" onClick={() => { const next = projectMenu.project; setProjectMenu(null); onRemoveProject(next) }}><Trash2 size={15} /><span>Remove project</span></button></div>}
    <div className="side-bottom"><button onClick={onSettings}><Settings2 size={17} /><span>Gateway / Settings</span></button><button onClick={onArchives}><Archive size={17} /><span>Archived chats</span>{state.settings.archivedSessionKeys.length > 0 && <small>{state.settings.archivedSessionKeys.length}</small>}</button></div>
  </aside>
}

function ArchivedChatsDialog({ sessions, runs, unreadKeys, projects, hosts, onOpen, onRestore, onClose }: { sessions: ProviderSession[]; runs: Run[]; unreadKeys: Set<string>; projects: Project[]; hosts: Host[]; onOpen: (session: ProviderSession) => void; onRestore: (session: ProviderSession) => Promise<void>; onClose: () => void }) {
  const hasUnread = (session: ProviderSession) => unreadKeys.has(sessionNotificationKey(session)) || runs.some((run) => run.hostId === session.hostId && run.provider === session.provider && run.sessionId === session.nativeSessionId && runNotificationKeys(run).some((key) => unreadKeys.has(key)))
  return <div className="dialog-backdrop"><div className="codex-dialog archived-dialog"><header><div><h2>Archived chats</h2><p>Archived conversations stay available without cluttering project navigation.</p></div><button title="Close" onClick={onClose}><X size={19} /></button></header><div className="archived-list">{sessions.length ? sessions.map((session) => { const project = projects.find((item) => item.id === session.projectId && item.hostId === session.hostId); const host = hosts.find((item) => item.id === session.hostId); return <div className="archived-row" key={sessionKey(session)}><button className="archived-main" onClick={() => onOpen(session)}><Archive size={14} /><span><strong>{hasUnread(session) && <i className="sidebar-unread-dot" title="Unread agent update" aria-label="Unread agent update" />}<span>{session.title}</span></strong><small>{project?.name || session.cwd} · {host?.name || session.hostId} · {relative(session.updatedAt)}</small></span></button><button className="archived-restore" onClick={() => void onRestore(session)}>Unarchive</button></div> }) : <div className="archived-empty"><Archive size={24} /><strong>No archived chats</strong><span>Use the archive button beside a project conversation to move it here.</span></div>}</div></div></div>
}

function RemoveProjectDialog({ project, busy, onClose, onConfirm }: { project: Project; busy: boolean; onClose: () => void; onConfirm: () => void }) {
  return <Dialog title={`Remove ${project.name}?`} subtitle="This only removes the project from Codesk." onClose={onClose}><div className="remove-project-dialog"><div className="remove-project-summary"><Trash2 size={19} /><span><strong>{project.path}</strong><small>The folder and its files will not be deleted. Re-adding it later restores its Codesk history.</small></span></div><footer><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button type="button" className="dialog-danger" disabled={busy} onClick={onConfirm}>{busy ? <><RefreshCw className="spin" size={14} />Removing…</> : <><Trash2 size={14} />Remove project</>}</button></footer></div></Dialog>
}

function ComposerFrame({ className, onSubmit, children }: { className: string; onSubmit: (event: FormEvent) => void; children: React.ReactNode }) { return <form className={className} onSubmit={onSubmit}>{children}</form> }
function ComposerInput(props: React.ComponentProps<'textarea'>) { return <textarea {...props} /> }
function ComposerFooter({ className, children }: { className?: string; children: React.ReactNode }) { return <div className={className}>{children}</div> }

function StartScreen({ state, draft, project, host, onProject, onStarted, onError }: { state: AppState; draft?: DraftSession; project?: Project; host?: Host; onProject: () => void; onStarted: (run: Run) => void; onError: (message: string) => void }) {
  const [prompt, setPrompt] = useState(draft?.prompt || ''); const [provider, setProvider] = useState(draft?.provider || 'codex'); const [workspace, setWorkspace] = useState<'current_checkout' | 'managed_worktree'>(draft?.workspaceMode || 'current_checkout'); const [busy, setBusy] = useState(false); const [gitContext, setGitContext] = useState<GitContext | null>(null)
  const submitting = useRef(false); const started = useRef(false)
  const providers = project ? state.providersByHost[project.hostId] || [] : []
  const harnesses = useMemo(() => providers.filter((item) => item.id !== 'shell').sort((left, right) => harnessOrder.indexOf(left.id) - harnessOrder.indexOf(right.id)), [providers])
  const selectedHarness = harnesses.find((item) => item.id === provider)
  useEffect(() => { if (selectedHarness?.available) return; const first = harnesses.find((item) => item.available); if (first) setProvider(first.id) }, [harnesses, selectedHarness?.available])
  useEffect(() => { if (!draft || started.current) return; const timer = window.setTimeout(() => { void api.updateDraft(draft.id, { prompt, provider, workspaceMode: workspace }).catch((cause) => { if (!submitting.current && !started.current) onError(cause instanceof Error ? cause.message : String(cause)) }) }, 250); return () => clearTimeout(timer) }, [draft?.id, prompt, provider, workspace, onError])
  useEffect(() => { let cancelled = false; setGitContext(null); if (project && host?.status === 'online') api.projectContext(project.hostId, project.id).then((value) => { if (!cancelled) setGitContext(value) }).catch(() => {}); return () => { cancelled = true } }, [project?.hostId, project?.id, host?.status])
  const canSubmit = Boolean(project && host?.status === 'online' && selectedHarness?.available && prompt.trim())
  const submit = async (event: FormEvent) => { event.preventDefault(); if (!project || !canSubmit || submitting.current) return; submitting.current = true; setBusy(true); try { const input = { hostId: project.hostId, project_id: project.id, provider, prompt, workspace_mode: workspace, base_ref: 'HEAD' }; const next = draft ? await api.startDraft(draft.id, input) : await api.createRun(input); started.current = true; onStarted(next) } catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)) } finally { submitting.current = false; setBusy(false) } }
  return <div className="start-screen">
    <div className="start-center"><img className="start-logo" src={logoUrl} alt="Codesk" /><h1>{project ? `What should we work on in ${project.name}?` : 'Add a project to get started'}</h1>{project && <div className="starter-cards"><button onClick={() => setPrompt('Explore and explain this codebase')}><Search size={17} /><span>Explore and<br />understand code</span></button><button onClick={() => setPrompt('Build a new feature for this project')}><Zap size={17} /><span>Build a new feature,<br />app, or tool</span></button><button onClick={() => setPrompt('Review the code and suggest improvements')}><RefreshCw size={17} /><span>Review code and<br />suggest changes</span></button><button onClick={() => setPrompt('Find and fix issues and failures')}><ShieldAlert size={17} /><span>Fix issues and failures</span></button></div>}</div>
    {project ? <ComposerFrame className="codex-composer" onSubmit={submit}>
      <div className="composer-context"><button type="button"><FolderGit2 size={15} />{project.name}</button><button type="button">{host?.type === 'ssh' ? <Globe2 size={15} /> : <Laptop size={15} />}{host?.type === 'ssh' ? 'Remote' : 'Local'}</button><button type="button" title={gitContext?.detached ? 'Detached HEAD' : gitContext?.dirty ? 'Working tree has changes' : gitContext?.available ? 'Current Git branch' : 'This folder is not a Git repository'}><GitBranch size={15} />{gitContext ? gitContext.available ? gitContext.branch : 'No Git repository' : host?.status === 'online' ? 'Loading branch' : 'Unavailable'}{gitContext?.dirty ? ' *' : ''}</button><span /><strong>{host?.name}<i className={host?.status} /></strong></div>
      <div className="harness-picker"><span>Start with</span><div className="harness-options" role="radiogroup" aria-label="Choose a harness">{harnesses.map((item) => <button type="button" role="radio" aria-checked={provider === item.id} className={`harness-option ${provider === item.id ? 'selected' : ''}`} key={item.id} disabled={!item.available} title={item.available ? `Start this chat with ${item.name}` : `${item.name} is not installed on ${host?.name || 'this host'}`} onClick={() => setProvider(item.id)}>{providerIcon(item.id)}<span>{item.name}</span><i className={item.available ? 'available' : ''} /></button>)}</div></div>
      <ComposerInput value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={selectedHarness ? `Ask ${selectedHarness.name} to do anything` : 'Choose a harness to get started'} />
      <ComposerFooter className="composer-footer"><button type="button" className="plus"><Plus size={18} /></button><button type="button" className={`access ${workspace === 'managed_worktree' ? 'worktree' : ''}`} onClick={() => setWorkspace((value) => value === 'current_checkout' ? 'managed_worktree' : 'current_checkout')}>{workspace === 'managed_worktree' ? <TreePine size={15} /> : <ShieldAlert size={15} />}{workspace === 'managed_worktree' ? 'New worktree' : 'Current checkout'}</button><span /><small className="selected-harness-label">{selectedHarness && providerIcon(selectedHarness.id)}{selectedHarness?.name || 'No harness available'}</small><button className="send" disabled={busy || !canSubmit} title={host?.status !== 'online' ? 'Execution host is offline' : !selectedHarness?.available ? 'Choose an installed harness' : 'Start chat'}>{busy ? <RefreshCw className="spin" size={17} /> : <Send size={17} />}</button></ComposerFooter>
    </ComposerFrame> : <button className="add-project-cta" onClick={onProject}><Plus size={17} />Add project</button>}
  </div>
}

type TimelineItem = RunEvent | { type: 'activity'; id: string; events: RunEvent[] }
const isActivityGroup = (item: TimelineItem): item is Extract<TimelineItem, { type: 'activity' }> => 'type' in item && item.type === 'activity'
const isActivityEvent = (event: RunEvent) => ['reasoning.message', 'tool.output', 'file.change'].includes(event.kind)
const timelineItems = (events: RunEvent[]) => {
  const items: TimelineItem[] = []; let group: RunEvent[] = []
  const flush = () => { if (!group.length) return; items.push({ type: 'activity', id: `activity:${group[0].event_id}`, events: group }); group = [] }
  for (const event of events) { if (isActivityEvent(event)) group.push(event); else { flush(); items.push(event) } }
  flush(); return items
}
const turnDurations = (events: RunEvent[]) => {
  const starts = new Map<string, number>(); const durations = new Map<string, number>()
  for (const event of events) {
    const turnId = typeof event.payload.turn_id === 'string' ? event.payload.turn_id : ''
    if (!turnId) continue
    if (event.kind === 'turn.started') starts.set(turnId, new Date(event.timestamp).getTime())
    if (event.kind === 'turn.completed' && starts.has(turnId)) durations.set(event.event_id, new Date(event.timestamp).getTime() - starts.get(turnId)!)
  }
  return durations
}
const externalHrefPattern = /^[a-z][a-z\d+.-]*:/i
const linkedFilePath = (href: string, cwd: string) => {
  let value = href
  if (value.startsWith('file://')) { try { value = new URL(value).pathname } catch {} }
  else value = value.split(/[?#]/, 1)[0]
  try { value = decodeURIComponent(value) } catch {}
  value = value.replace(/:(\d+)(?::\d+)?$/, '')
  if (value.startsWith('/')) return value
  return `${cwd.replace(/\/$/, '')}/${value.replace(/^\.\//, '')}`
}
type FilePreviewState = { requestedPath: string; file?: FileContent; error?: string }
function useFilePreview(hostId: string, cwd: string) {
  const [preview, setPreview] = useState<FilePreviewState | null>(null)
  useEffect(() => { setPreview(null) }, [hostId, cwd])
  const open = (href: string) => {
    const path = linkedFilePath(href, cwd)
    setPreview({ requestedPath: path })
    void api.file(hostId, path).then((file) => setPreview({ requestedPath: path, file })).catch((cause) => setPreview({ requestedPath: path, error: cause instanceof Error ? cause.message : String(cause) }))
  }
  return { preview, open, close: () => setPreview(null) }
}
function MarkdownContent({ text, className = '' }: { text: string; className?: string }) {
  const openFile = useContext(FilePreviewContext)
  return <div className={`markdown-content ${className}`}><ReactMarkdown remarkPlugins={markdownPlugins} components={{ a: ({ href = '', children, ...props }) => {
    const isAnchor = href.startsWith('#'); const isExternal = externalHrefPattern.test(href) && !href.startsWith('file:')
    if (!isAnchor && !isExternal && openFile) return <a {...props} href={href} onClick={(event) => { event.preventDefault(); openFile(href) }}>{children}</a>
    return <a {...props} href={href} target={isExternal ? '_blank' : undefined} rel={isExternal ? 'noreferrer' : undefined}>{children}</a>
  } }}>{text}</ReactMarkdown></div>
}
function FilePreviewPanel({ state, onClose }: { state: FilePreviewState; onClose: () => void }) {
  const isImage = Boolean(state.file?.data_url)
  return <aside className="file-preview-panel"><header>{isImage ? <ImageIcon size={15} /> : <FileText size={15} />}<span><strong>{state.file?.name || state.requestedPath.split('/').pop()}</strong><small title={state.file?.path || state.requestedPath}>{state.file?.path || state.requestedPath}</small></span><button title="Close file preview" onClick={onClose}><X size={16} /></button></header>{state.error ? <div className="file-preview-state"><ShieldAlert size={20} /><strong>Could not preview this file</strong><span>{state.error}</span></div> : state.file ? isImage ? <div className="file-preview-image"><img src={state.file.data_url} alt={state.file.name} /></div> : <><pre>{state.file.content}</pre>{state.file.truncated && <footer>Preview limited to the first 2 MB of {Math.ceil(state.file.size / 1024).toLocaleString()} KB.</footer>}</> : <div className="file-preview-state"><RefreshCw className="spin" size={18} /><span>Loading file from host…</span></div>}</aside>
}
function ConversationMessage({ role, text, className = '', children }: { role: 'user' | 'assistant'; text: string; className?: string; children?: React.ReactNode }) {
  const content = conversationText(text)
  if (!content.text && content.hadContext) return <div className="context-note"><Info size={13} />Environment context attached</div>
  if (role === 'user') return <div className={`user-message ${className}`}><MarkdownContent text={content.text} />{children}</div>
  return <MarkdownContent text={content.text} className={`assistant-message ${className}`} />
}
type FileChange = { path?: string; kind?: string; diff?: string }
type ActivityStatus = 'running' | 'completed' | 'failed'
type ActivityEntry = {
  id: string
  correlationId?: string
  type: 'tool' | 'files'
  label: string
  status: ActivityStatus
  input?: unknown
  output?: unknown
  changes: FileChange[]
  timestamp: string
  raw: unknown
}
type ActivityLedgerItem = { type: 'reasoning'; id: string; text: string } | { type: 'entry'; entry: ActivityEntry }
const diffCounts = (diff = '') => diff.split('\n').reduce((counts, line) => {
  if (line.startsWith('+') && !line.startsWith('+++')) counts.additions += 1
  if (line.startsWith('-') && !line.startsWith('---')) counts.deletions += 1
  return counts
}, { additions: 0, deletions: 0 })
const changePath = (run: Run, path = '') => path.startsWith('/') ? path : `${run.cwd.replace(/\/$/, '')}/${path}`

function FileChangeCard({ changes = [], text, run }: { changes?: FileChange[]; text: string; run: Run }) {
  const [showAll, setShowAll] = useState(false); const [reviewing, setReviewing] = useState(false)
  const stats = changes.reduce((total, change) => { const next = diffCounts(change.diff); total.additions += next.additions; total.deletions += next.deletions; return total }, { additions: 0, deletions: 0 })
  if (!changes.length && text) { const fallback = diffCounts(text); stats.additions = fallback.additions; stats.deletions = fallback.deletions }
  const visible = showAll ? changes : changes.slice(0, 4); const hidden = Math.max(0, changes.length - visible.length)
  const reviewText = changes.map((change) => change.diff ? `${change.path || 'Unknown file'}\n${change.diff}` : '').filter(Boolean).join('\n\n') || text
  const label = changes.length ? `Edited ${changes.length} file${changes.length === 1 ? '' : 's'}` : 'File changes'
  return <section className="file-change-card">
    <header><span className="file-change-icon"><FileDiff size={15} /></span><div className="file-change-title"><strong>{label}</strong>{(stats.additions > 0 || stats.deletions > 0) && <small><b>+{stats.additions}</b><i>-{stats.deletions}</i></small>}</div><span />{reviewText && <button className={reviewing ? 'active' : ''} onClick={() => setReviewing((value) => !value)}><Eye size={13} />{reviewing ? 'Hide diff' : 'Review'}</button>}</header>
    {visible.length > 0 && <div className="file-change-list">{visible.map((change, index) => { const counts = diffCounts(change.diff); return <div className="file-change-row" key={`${change.path || 'file'}:${index}`}><code title={change.path}>{change.path || 'Unknown file'}</code><small>{counts.additions > 0 && <b>+{counts.additions}</b>}{counts.deletions > 0 && <i>-{counts.deletions}</i>}</small><button title="Copy path" onClick={() => void navigator.clipboard.writeText(change.path || '')}><Copy size={12} /></button><button title="Open file" onClick={() => void api.openPath(run.hostId, changePath(run, change.path))}><FolderOpen size={12} /></button></div> })}</div>}
    {hidden > 0 && <button className="file-change-more" onClick={() => setShowAll(true)}>Show {hidden} more file{hidden === 1 ? '' : 's'}<ChevronDown size={13} /></button>}
    {showAll && changes.length > 4 && <button className="file-change-more" onClick={() => setShowAll(false)}>Show fewer<ChevronDown className="up" size={13} /></button>}
    {reviewing && reviewText && <pre className="file-change-review">{reviewText}</pre>}
    {!changes.length && text && !reviewing && <pre>{text}</pre>}
  </section>
}

const activityText = (value: unknown) => {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}
const compactActivityValue = (value: unknown, limit = 150) => {
  if (value === undefined || value === null || value === '') return ''
  const text = activityText(value).replace(/\s+/g, ' ').trim()
  if (text.length <= limit) return text
  return `${text.slice(0, Math.max(1, limit - 1)).trimEnd()}…`
}
const wrappedExecCommand = (value: unknown) => {
  if (typeof value !== 'string' || !value.includes('tools.exec_command')) return ''
  const match = value.match(/tools\.exec_command\(\s*\{\s*cmd\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/s)
  if (!match) return ''
  const literal = match[1]
  let command = literal.slice(1, -1)
  if (literal.startsWith('"')) {
    try { command = JSON.parse(literal) as string } catch {}
  } else command = command.replace(/\\(['\\`])/g, '$1').replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t')
  command = compactActivityValue(command, 600)
  if (!command) return ''
  return /^\/bin\/zsh\s+-lc\b/.test(command) ? command : `/bin/zsh -lc ${command}`
}
const activityCommandValue = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const record = value as Record<string, unknown>
  return record.command ?? record.cmd ?? record.argv ?? record.args ?? record.path ?? record.paths
}
const activityFileSummary = (entry: ActivityEntry) => {
  if (entry.type === 'files') {
    const paths = entry.changes.map((change) => change.path).filter(Boolean).slice(0, 3) as string[]
    const hidden = Math.max(0, entry.changes.filter((change) => change.path).length - paths.length)
    const stats = entry.changes.reduce((total, change) => {
      const counts = diffCounts(change.diff)
      total.additions += counts.additions
      total.deletions += counts.deletions
      return total
    }, { additions: 0, deletions: 0 })
    const pathText = paths.join(' · ')
    const countText = `${stats.additions > 0 ? `+${stats.additions}` : ''}${stats.deletions > 0 ? `${stats.additions > 0 ? ' ' : ''}-${stats.deletions}` : ''}`
    return [pathText || (entry.changes.length ? `${entry.changes.length} changed paths` : ''), hidden > 0 ? `+${hidden} more` : '', countText].filter(Boolean).join('  ')
  }
  return ''
}
const activityRowLabel = (entry: ActivityEntry) => {
  if (entry.type === 'files') return [entry.label, activityFileSummary(entry)].filter(Boolean).join(' · ')
  return wrappedExecCommand(entry.input) || compactActivityValue(activityCommandValue(entry.input), 600) || compactActivityValue(entry.label, 600) || 'Tool activity'
}
const isWrappedExecEntry = (entry: ActivityEntry) => Boolean(wrappedExecCommand(entry.input))
const mergeWrappedExecEntry = (items: ActivityLedgerItem[], entry: ActivityEntry) => {
  if (entry.type !== 'tool' || isWrappedExecEntry(entry)) return false
  const label = activityRowLabel(entry)
  for (let index = items.length - 1; index >= 0; index--) {
    const candidate = items[index]
    if (candidate.type === 'reasoning') break
    if (candidate.entry.type === 'tool' && isWrappedExecEntry(candidate.entry) && activityRowLabel(candidate.entry) === label) {
      items[index] = { type: 'entry', entry: mergeActivityEntries(candidate.entry, entry) }
      return true
    }
  }
  return false
}
const activityStatus = (value: unknown, failed = false): ActivityStatus => {
  const status = String(value || '').toLowerCase()
  if (failed || ['failed', 'error', 'errored', 'cancelled'].includes(status)) return 'failed'
  if (['in_progress', 'running', 'pending', 'started'].includes(status)) return 'running'
  return 'completed'
}
const liveActivityEntry = (event: RunEvent): ActivityEntry | null => {
  if (event.kind === 'reasoning.message') return null
  const raw = event.raw_payload as { method?: string; params?: { command?: unknown; item?: { type?: string; command?: unknown; changes?: FileChange[] }; update?: { title?: string; kind?: string; status?: string } } }
  const method = raw?.method || ''
  const item = raw?.params?.item
  const payloadChanges = Array.isArray(event.payload.changes) ? event.payload.changes as FileChange[] : []
  const changes = payloadChanges.length ? payloadChanges : item?.changes || []
  const files = event.kind === 'file.change' || method.includes('fileChange') || item?.type === 'fileChange' || changes.length > 0
  const text = String(event.payload.text || '')
  const command = event.payload.tool_title ?? event.payload.tool_name ?? raw?.params?.update?.title ?? raw?.params?.command ?? item?.command
  const label = files ? changes.length ? `Edited ${changes.length} file${changes.length === 1 ? '' : 's'}` : 'File changes' : activityText(command) || (event.kind === 'tool.output' ? 'Tool output' : event.kind.replaceAll('.', ' '))
  const status = event.payload.tool_status ?? raw?.params?.update?.status
  const input = event.payload.raw_input ?? event.payload.input ?? (!files && command !== undefined ? command : undefined)
  const rawOutput = event.payload.raw_output ?? event.payload.output
  const output = rawOutput !== undefined ? rawOutput : text && text !== label && text !== activityText(command) ? text : undefined
  const correlationId = typeof event.payload.item_id === 'string' ? event.payload.item_id : undefined
  return {
    id: `run:${event.run_id}:${correlationId || event.event_id}`,
    correlationId,
    type: files ? 'files' : 'tool',
    label,
    status: activityStatus(status, event.channel === 'stderr' || event.kind === 'run.error'),
    input,
    output,
    changes,
    timestamp: event.timestamp,
    raw: { kind: event.kind, provider_event_type: event.provider_event_type, channel: event.channel, payload: event.payload, provider_payload: event.raw_payload },
  }
}
const liveActivityItems = (events: RunEvent[]): ActivityLedgerItem[] => {
  const items: ActivityLedgerItem[] = []
  for (const event of events) {
    if (event.kind === 'reasoning.message') { items.push({ type: 'reasoning', id: event.event_id, text: String(event.payload.text || '') }); continue }
    const entry = liveActivityEntry(event)
    if (!entry) continue
    if (event.kind === 'tool.output' && entry.label === 'Tool output') {
      let match = -1
      for (let index = items.length - 1; index >= 0; index--) {
        const candidate = items[index]
        if (candidate.type === 'reasoning') break
        if (candidate.entry.type === 'tool' && (candidate.entry.correlationId === entry.correlationId || index === items.length - 1)) { match = index; break }
      }
      if (match >= 0) {
        const candidate = items[match]
        if (candidate.type === 'entry') { items[match] = { type: 'entry', entry: mergeActivityEntries(candidate.entry, entry) }; continue }
      }
      continue
    }
    if (mergeWrappedExecEntry(items, entry)) continue
    items.push({ type: 'entry', entry })
  }
  return items
}

const historicalActivityEntry = (message: SessionMessage): ActivityEntry => {
  const meta = message.meta || {}
  const changes = meta.changes || []
  const files = message.kind === 'file_change' || changes.length > 0
  const output = meta.output !== undefined ? meta.output : message.text || undefined
  const input = meta.input !== undefined ? meta.input : meta.command
  const correlationId = meta.call_id || message.id
  return {
    id: `history:${correlationId}`,
    correlationId,
    type: files ? 'files' : 'tool',
    label: files ? changes.length ? `Edited ${changes.length} file${changes.length === 1 ? '' : 's'}` : 'File changes' : activityText(meta.display || meta.tool || meta.command) || 'Tool output',
    status: activityStatus(meta.status),
    input,
    output,
    changes,
    timestamp: message.timestamp,
    raw: { id: message.id, kind: message.kind, text: message.text, meta: message.meta },
  }
}
const mergeActivityEntries = (prior: ActivityEntry, next: ActivityEntry): ActivityEntry => ({
  ...prior,
  type: prior.type === 'files' || next.type === 'files' ? 'files' : 'tool',
  label: prior.label === 'Tool output' ? next.label : prior.label,
  status: next.status,
  input: prior.input ?? next.input,
  output: next.output ?? prior.output,
  changes: next.changes.length ? next.changes : prior.changes,
  timestamp: next.timestamp || prior.timestamp,
  raw: [prior.raw, next.raw],
})
const historicalActivityItems = (messages: SessionMessage[]): ActivityLedgerItem[] => {
  const items: ActivityLedgerItem[] = []
  for (const message of messages) {
    if (message.kind === 'reasoning') { items.push({ type: 'reasoning', id: message.id, text: message.text }); continue }
    const entry = historicalActivityEntry(message)
    let match = -1
    if (message.kind === 'tool_output') {
      for (let index = items.length - 1; index >= 0; index--) {
        const candidate = items[index]
        if (candidate.type === 'reasoning') break
        if (candidate.entry.type === 'tool' && (candidate.entry.correlationId === entry.correlationId || index === items.length - 1)) { match = index; break }
      }
    }
    if (match >= 0) {
      const candidate = items[match]
      if (candidate.type === 'entry') items[match] = { type: 'entry', entry: mergeActivityEntries(candidate.entry, entry) }
    } else if (message.kind !== 'tool_output' && !mergeWrappedExecEntry(items, entry)) items.push({ type: 'entry', entry })
  }
  return items
}
function ActivityRow({ entry, selected, onSelect }: { entry: ActivityEntry; selected: boolean; onSelect: (entry: ActivityEntry) => void }) {
  const label = activityRowLabel(entry)
  const accessibleLabel = `${entry.type === 'files' ? 'Files' : 'Tool'}: ${label} · ${entry.status}`
  return <button className={`activity-row ${entry.status} ${selected ? 'selected' : ''}`} aria-pressed={selected} aria-label={accessibleLabel} onClick={() => onSelect(entry)} title={label}><span className={`activity-row-icon ${entry.type}`}>{entry.type === 'files' ? <FileDiff size={14} /> : <Terminal size={14} />}</span><code className="activity-row-command">{label}</code></button>
}
function ActivityLedger({ items, selectedId, onSelect }: { items: ActivityLedgerItem[]; selectedId: string | null; onSelect: (entry: ActivityEntry) => void }) {
  return <div className="activity-ledger">{items.map((item) => item.type === 'reasoning' ? <div className="reasoning-summary" key={item.id}><Bot size={13} /><MarkdownContent text={item.text} /></div> : <ActivityRow entry={item.entry} selected={selectedId === item.entry.id} onSelect={onSelect} key={item.entry.id} />)}</div>
}
function ActivityInspectorPanel({ entry, hostId, cwd, onClose }: { entry: ActivityEntry; hostId: string; cwd: string; onClose: () => void }) {
  const [tab, setTab] = useState<'details' | 'raw'>('details')
  useEffect(() => setTab('details'), [entry.id])
  const input = activityText(entry.input)
  const output = activityText(entry.output)
  const raw = activityText(entry.raw)
  const hasDetails = Boolean(input || output || entry.changes.length)
  return <aside className="file-preview-panel activity-inspector-panel"><header>{entry.type === 'files' ? <FileDiff size={15} /> : <Terminal size={15} />}<span><strong>{entry.label}</strong><small>{entry.type === 'files' ? 'File changes' : 'Tool call'} · {entry.status}</small></span><button title="Close activity inspector" onClick={onClose}><X size={16} /></button></header><nav className="activity-inspector-tabs"><button className={tab === 'details' ? 'active' : ''} onClick={() => setTab('details')}>Details</button><button className={tab === 'raw' ? 'active' : ''} onClick={() => setTab('raw')}>Raw</button></nav>{tab === 'raw' ? <pre className="activity-inspector-raw">{raw}</pre> : <div className="activity-inspector-details">{!hasDetails && <div className="activity-inspector-empty"><Info size={18} /><span>This tool did not provide additional details.</span></div>}{input && <section><header>Input</header><pre>{input}</pre></section>}{output && <section><header>{entry.status === 'failed' ? 'Error output' : 'Output'}</header><pre>{output}</pre></section>}{entry.changes.length > 0 && <section><header>Changed files</header><div className="activity-inspector-files">{entry.changes.map((change, index) => { const counts = diffCounts(change.diff); const path = change.path || 'Unknown file'; const resolved = path.startsWith('/') ? path : `${cwd.replace(/\/$/, '')}/${path}`; return <div key={`${path}:${index}`}><FileText size={13} /><code title={path}>{path}</code><small>{counts.additions > 0 && <b>+{counts.additions}</b>}{counts.deletions > 0 && <i>-{counts.deletions}</i>}</small>{change.path && <><button title="Copy path" onClick={() => void navigator.clipboard.writeText(path)}><Copy size={12} /></button><button title="Open file" onClick={() => void api.openPath(hostId, resolved)}><FolderOpen size={12} /></button></>}</div> })}</div></section>}</div>}</aside>
}

function ToolActivityGroup({ events, selectedId, onSelect }: { events: RunEvent[]; selectedId: string | null; onSelect: (entry: ActivityEntry) => void }) {
  return <ActivityLedger items={liveActivityItems(events)} selectedId={selectedId} onSelect={onSelect} />
}

type HistoricalTimelineItem = SessionMessage | { type: 'activity'; id: string; messages: SessionMessage[] }
const isHistoricalActivity = (item: HistoricalTimelineItem): item is Extract<HistoricalTimelineItem, { type: 'activity' }> => 'type' in item && item.type === 'activity'
const historicalActivityKinds = new Set(['reasoning', 'tool', 'tool_output', 'file_change'])
const normalizeHistoricalActivityMessages = (messages: SessionMessage[]) => {
  const normalized: SessionMessage[] = []
  for (const message of messages) {
    if (message.kind === 'tool_output') {
      let match = -1
      const callId = message.meta?.call_id
      for (let index = normalized.length - 1; index >= 0; index--) {
        const prior = normalized[index]
        if (prior.role === 'user' || prior.kind === 'turn_completed') break
        if ((prior.kind === 'tool' || prior.kind === 'file_change') && (!callId || prior.meta?.call_id === callId)) { match = index; break }
      }
      if (match >= 0) {
        const prior = normalized[match]
        normalized[match] = {
          ...prior,
          text: prior.text || message.text,
          meta: { ...prior.meta, output: message.meta?.output ?? (message.text || prior.meta?.output), status: message.meta?.status || prior.meta?.status, raw: [prior.meta?.raw, message.meta?.raw].filter(Boolean) },
        }
        continue
      }
    }
    normalized.push(message)
  }
  return normalized
}
const historicalTimelineItems = (messages: SessionMessage[]) => {
  const items: HistoricalTimelineItem[] = []; let activity: SessionMessage[] = []
  const flush = () => { if (!activity.length) return; items.push({ type: 'activity', id: `history-activity:${activity[0].id}`, messages: activity }); activity = [] }
  for (const message of normalizeHistoricalActivityMessages(messages)) {
    if (historicalActivityKinds.has(message.kind || '')) activity.push(message)
    else { flush(); items.push(message) }
  }
  flush(); return items
}
function HistoricalActivityGroup({ messages, selectedId, onSelect }: { messages: SessionMessage[]; selectedId: string | null; onSelect: (entry: ActivityEntry) => void }) {
  return <ActivityLedger items={historicalActivityItems(messages)} selectedId={selectedId} onSelect={onSelect} />
}
function HistoricalOperationalEvent({ message, session }: { message: SessionMessage; session: ProviderSession }) {
  const meta = message.meta || {}
  if (message.kind === 'reasoning') return <div className="reasoning-summary"><Bot size={13} /><MarkdownContent text={message.text} /></div>
  if (message.kind === 'file_change') {
    const changes = meta.changes || []
    return <section className="file-change-card historical-file-change"><header><span className="file-change-icon"><FileDiff size={15} /></span><div className="file-change-title"><strong>Edited {changes.length || 1} file{changes.length === 1 ? '' : 's'}</strong></div><span /></header>{changes.length > 0 && <div className="file-change-list">{changes.map((change, index) => <div className="file-change-row" key={`${change.path || 'file'}:${index}`}><code title={change.path}>{change.path || 'Unknown file'}</code><button title="Open file" onClick={() => change.path && void api.openPath(session.hostId, change.path.startsWith('/') ? change.path : `${session.cwd.replace(/\/$/, '')}/${change.path}`)}><FolderOpen size={12} /></button></div>)}</div>}</section>
  }
  if (message.kind === 'tool') {
    const command = meta.command || ''
    const label = meta.display || meta.tool || command || 'Tool activity'
    const output = activityText(message.text || meta.output)
    return <div className="command-row"><header><Terminal size={13} /><code>{activityText(label)}</code>{meta.status === 'failed' ? <ShieldAlert size={13} /> : <CheckCircle2 size={13} />}</header>{output && <pre>{output}</pre>}</div>
  }
  return <div className="tool-output"><code>{activityText(meta.tool) || 'Tool output'}</code>{message.text && <pre>{message.text}</pre>}</div>
}
function OperationalEvent({ event, run }: { event: RunEvent; run: Run }) {
  const raw = event.raw_payload as { method?: string; params?: { command?: string; item?: { type?: string; command?: string; changes?: Array<{ path?: string; kind?: string; diff?: string }> }; update?: { title?: string; kind?: string; status?: string } } }
  const text = String(event.payload.text || ''); const method = raw?.method || ''; const item = raw?.params?.item
  if (event.kind === 'reasoning.message') return <div className="reasoning-summary"><Bot size={13} /><MarkdownContent text={text} /></div>
  const payloadChanges = Array.isArray(event.payload.changes) ? event.payload.changes as Array<{ path?: string; kind?: string; diff?: string }> : []
  if (event.kind === 'file.change' || method.includes('fileChange') || item?.type === 'fileChange' || payloadChanges.length > 0) {
    return <FileChangeCard changes={payloadChanges.length ? payloadChanges : item?.changes} text={text} run={run} />
  }
  const command = String(event.payload.tool_title || raw?.params?.update?.title || raw?.params?.command || item?.command || (method.includes('commandExecution') ? text : ''))
  const toolStatus = String(event.payload.tool_status || raw?.params?.update?.status || '')
  if (command) return <div className={`command-row ${event.channel === 'stderr' || toolStatus === 'failed' ? 'failed' : ''}`}><header><Terminal size={13} /><code>{command}</code>{event.channel === 'stderr' || toolStatus === 'failed' ? <ShieldAlert size={13} /> : toolStatus === 'in_progress' ? <Clock3 size={13} /> : <CheckCircle2 size={13} />}</header>{text && text !== command && <pre>{text}</pre>}</div>
  return <div className={`tool-output ${event.channel === 'stderr' ? 'failed' : ''}`}><code>{event.kind.replaceAll('.', ' ')}</code>{text && <pre>{text}</pre>}</div>
}

function UsageCard({ event }: { event: RunEvent }) {
  const agy = event.provider_event_type?.startsWith('agy.') || event.payload.thinking_tokens !== undefined
  if (agy) {
    const input = Number(event.payload.input_tokens)
    const output = Number(event.payload.output_tokens)
    const thinking = Number(event.payload.thinking_tokens)
    const cacheRead = Number(event.payload.cache_read_tokens)
    const total = Number(event.payload.total_tokens)
    const duration = Number(event.payload.duration_seconds)
    const modelTokens = Number.isFinite(total) ? total : [input, output].filter(Number.isFinite).reduce((sum, value) => sum + value, 0)
    return <section className="usage-card"><header>{providerIcon('agy', 14)}<strong>Antigravity usage</strong><span>Turn result</span></header><div className="usage-grid"><div><small>Tokens</small><b>{modelTokens.toLocaleString()} total tokens</b><em>{Number.isFinite(output) ? output.toLocaleString() : 0} output · {Number.isFinite(thinking) ? thinking.toLocaleString() : 0} thinking</em></div><div><small>Cache & time</small><b>{Number.isFinite(cacheRead) ? cacheRead.toLocaleString() : 0} cached tokens</b>{Number.isFinite(duration) && <em>{duration.toFixed(2)} seconds</em>}</div></div></section>
  }
  const dsh = event.provider_event_type?.startsWith('dsh.') || event.payload.context_window !== undefined
  if (dsh) {
    const context = Number(event.payload.context_usage_percentage)
    const pressure = Number(event.payload.pressure_tokens)
    const projected = Number(event.payload.projected_tokens)
    const contextWindow = Number(event.payload.context_window)
    const input = Number(event.payload.uncached_input_tokens)
    const output = Number(event.payload.output_tokens)
    const cacheRead = Number(event.payload.cache_read_tokens)
    const cacheWrite = Number(event.payload.cache_write_tokens)
    const tokenTotal = [input, output].filter(Number.isFinite).reduce((total, value) => total + value, 0)
    const cacheTotal = [cacheRead, cacheWrite].filter(Number.isFinite).reduce((total, value) => total + value, 0)
    return <section className="usage-card"><header>{providerIcon('dsh', 14)}<strong>DeepSeek Harness usage</strong><span>Session snapshot</span></header><div className="usage-grid"><div><small>Context</small><b>{Number.isFinite(context) ? `${context.toFixed(2)}%` : 'Unavailable'}</b>{contextWindow > 0 && <em>{(projected || pressure).toLocaleString()} / {contextWindow.toLocaleString()} tokens</em>}</div><div><small>Tokens</small><b>{tokenTotal.toLocaleString()} model tokens</b><em>{cacheTotal.toLocaleString()} cached tokens</em></div></div></section>
  }
  const context = Number(event.payload.context_usage_percentage)
  const size = Number(event.payload.context_size)
  const used = Number(event.payload.context_usage_percentage)
  const metering = Array.isArray(event.payload.metering_usage) ? event.payload.metering_usage as Array<{ value?: number; unit?: string; unitPlural?: string }> : []
  const credits = metering.map((item) => `${Number(item.value || 0).toFixed(3)} ${item.unitPlural || item.unit || 'credits'}`).join(' + ')
  return <section className="usage-card"><header>{providerIcon('kiro', 14)}<strong>Kiro usage</strong><span>Session snapshot</span></header><div className="usage-grid"><div><small>Context</small><b>{Number.isFinite(context) ? `${context.toFixed(1)}%` : 'Unavailable'}</b>{size > 0 && <em>{size.toLocaleString()} tokens</em>}</div><div><small>Metering</small><b>{credits || 'No credit data yet'}</b>{used > 0 && <em>{used.toFixed(1)}% context used</em>}</div></div></section>
}

function EnvironmentPopover({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) { return <aside className="environment-popover"><header><span>{title}</span><button title="Close environment inspector" onClick={onClose}><X size={14} /></button></header>{children}</aside> }
function EnvironmentRow({ icon, label, value }: { icon: React.ReactNode; label: string; value?: React.ReactNode }) { return <div className="environment-row">{icon}<span>{label}</span><strong>{value || 'Unknown'}</strong></div> }
function TmuxDetails({ name, command }: { name?: string | null; command?: string | null }) {
  if (!name && !command) return null
  return <div className="tmux-details">{name && <div><Terminal size={14} /><span>tmux</span><strong>{name}</strong></div>}{command && <div><Copy size={14} /><span>Access</span><code title={command}>{command}</code><button type="button" title="Copy tmux access command" onClick={() => void navigator.clipboard.writeText(command)}><Copy size={13} /></button></div>}</div>
}

function VirtualTimeline<T>({ items, scrollRef, itemKey, renderItem, before }: { items: T[]; scrollRef: React.RefObject<HTMLDivElement | null>; itemKey: (item: T) => string; renderItem: (item: T) => React.ReactNode; before?: React.ReactNode }) {
  const enabled = items.length > 40
  const virtualizer = useVirtualizer({
    count: items.length,
    enabled,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => itemKey(items[index]),
    estimateSize: () => 110,
    overscan: 8,
  })
  if (!enabled) return <div className="thread-column">{before}{items.map((item) => <div className="timeline-row" key={itemKey(item)}>{renderItem(item)}</div>)}</div>
  return <><div className="thread-column">{before}</div><div className="thread-column virtual-timeline" style={{ height: virtualizer.getTotalSize() }}>{virtualizer.getVirtualItems().map((row) => { const item = items[row.index]; return <div className="virtual-timeline-row" data-index={row.index} key={row.key} ref={virtualizer.measureElement} style={{ transform: `translateY(${row.start}px)` }}>{renderItem(item)}</div> })}</div></>
}

function RunScreen({ run, events, project, host, provider, onStarted, onError }: { run: Run; events: RunEvent[]; project?: Project; host?: Host; provider?: Provider; onStarted: (run: Run) => void; onError: (message: string) => void }) {
  const [message, setMessage] = usePersistentComposerDraft(`run:${run.hostId}:${run.id}`); const [sending, setSending] = useState(false); const [rewind, setRewind] = useState<{ turnId: string; lastTurnId: string | null; text: string } | null>(null); const [showEnvironment, setShowEnvironment] = useState(false); const [selectedActivityId, setSelectedActivityId] = useState<string | null>(null); const [workspaceLabel, setWorkspaceLabel] = useState(run.worktreeId ? 'Managed worktree' : 'Current checkout'); const scroll = useRef<HTMLDivElement>(null); const following = useRef(true); const lastEscape = useRef(0); const submitting = useRef(false)
  const filePreview = useFilePreview(run.hostId, run.cwd)
  useEffect(() => { if (following.current) requestAnimationFrame(() => scroll.current?.scrollTo({ top: scroll.current.scrollHeight })) }, [events.length])
  useEffect(() => { let cancelled = false; if (run.worktreeId) api.worktreeStatus(run.hostId, run.worktreeId).then((status) => { if (!cancelled) setWorkspaceLabel(status.worktree.branch || 'Managed worktree') }).catch(() => {}); else if (project && host?.status === 'online') api.projectContext(project.hostId, project.id).then((context) => { if (!cancelled) setWorkspaceLabel(context.branch || 'Current checkout') }).catch(() => {}); return () => { cancelled = true } }, [run.hostId, run.worktreeId, project?.id, host?.status])
  const turnRunning = run.status === 'running'
  const ui = providerUi(run.provider)
  const tmuxRun = run.inputTransport === 'tmux'
  const queuedInput = tmuxRun || (provider?.queued_input ?? ui.queuedInput)
  const turnRewind = provider?.turn_rewind ?? ui.turnRewind
  const canUseAttachedSession = Boolean((tmuxRun || provider?.live_input) && active.has(run.status))
  const sendPrompt = async (mode: 'send' | 'fork' | 'queue' = 'send') => { const prompt = message.trim(); if (!prompt || submitting.current) return; submitting.current = true; setSending(true); try { if (mode === 'queue') await api.input(run.hostId, run.id, prompt, 'queue'); else if (mode === 'fork') onStarted(await api.resumeRun(run, prompt, true)); else if (rewind && canUseAttachedSession) await api.input(run.hostId, run.id, prompt, 'fork', rewind.lastTurnId); else if (canUseAttachedSession) await api.input(run.hostId, run.id, prompt); else if (run.sessionId && provider?.resume) onStarted(await api.resumeRun(run, prompt)); else return; setMessage(''); setRewind(null) } catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)) } finally { submitting.current = false; setSending(false) } }
  const send = (event: FormEvent) => { event.preventDefault(); void sendPrompt() }
  const queue = () => { void sendPrompt('queue') }
  const branchEvents = currentBranchEvents(events)
  const hasUserEvents = branchEvents.some((event) => event.kind === 'user.message')
  const displayEvents = coalesceStreamEvents(branchEvents)
  const displayItems = timelineItems(displayEvents)
  const activityEntries = displayItems.flatMap((item) => isActivityGroup(item) ? liveActivityItems(item.events).flatMap((activity) => activity.type === 'entry' ? [activity.entry] : []) : [])
  const selectedActivity = selectedActivityId ? activityEntries.find((entry) => entry.id === selectedActivityId) || null : null
  const durations = turnDurations(displayEvents)
  const queued = pendingQueue(branchEvents)
  const backtrackable = branchEvents.filter((event, index, all) => event.kind === 'user.message' && typeof event.payload.turn_id === 'string' && typeof event.payload.text === 'string' && all.findIndex((candidate) => candidate.kind === 'user.message' && candidate.payload.turn_id === event.payload.turn_id) === index)
  const backtrackableEventIds = new Set(backtrackable.map((event) => event.event_id))
  const resolvedRequests = new Set(branchEvents.filter((event) => (event.provider_event_type === 'codex.serverRequest/resolved' || event.kind === 'provider.response.submitted' || event.kind === 'provider.response') && (event.payload.request_id !== undefined || event.payload.rpc_id !== undefined)).map((event) => String(event.payload.request_id ?? event.payload.rpc_id)))
  useEffect(() => { submitting.current = false; setSending(false); setSelectedActivityId(null); filePreview.close() }, [run.id])
  useEffect(() => { if (selectedActivityId && !selectedActivity) setSelectedActivityId(null) }, [selectedActivityId, selectedActivity])
  const openFile = (href: string) => { setSelectedActivityId(null); filePreview.open(href) }
  const selectActivity = (entry: ActivityEntry) => { filePreview.close(); setShowEnvironment(false); setSelectedActivityId(entry.id) }
  const selectRewind = (turnId: string, text: string) => { const index = backtrackable.findIndex((event) => event.payload.turn_id === turnId); if (index < 0) return; setRewind({ turnId, lastTurnId: index > 0 ? String(backtrackable[index - 1].payload.turn_id) : null, text }); setMessage(text) }
  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (tmuxRun && event.key === 'Tab') { event.preventDefault(); void sendPrompt('queue'); return }
    if (tmuxRun && event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendPrompt(); return }
    if (event.key !== 'Escape') { lastEscape.current = 0; return }
    if (run.status !== 'waiting_for_input' || queued.length || (!rewind && message)) return
    event.preventDefault()
    const now = Date.now()
    if (!rewind && now - lastEscape.current > 900) { lastEscape.current = now; return }
    lastEscape.current = now
    const current = rewind ? backtrackable.findIndex((item) => item.payload.turn_id === rewind.turnId) : backtrackable.length
    const selected = backtrackable[Math.max(0, current - 1)]
    if (selected) selectRewind(selected.payload.turn_id as string, String(selected.payload.text))
  }
  return <FilePreviewContext.Provider value={openFile}><div className={`thread-screen ${showEnvironment ? 'environment-open' : ''} ${filePreview.preview || selectedActivity ? 'file-preview-open' : ''}`}>
    <header className="thread-header"><FolderGit2 size={16} /><strong>{run.title}</strong><button title="Thread actions"><MoreHorizontal size={18} /></button><span /><button className="open-in">Open in <ChevronDown size={14} /></button><button className={`environment-toggle ${showEnvironment ? 'active' : ''}`} onClick={() => setShowEnvironment((value) => !value)}><Info size={15} />Environment</button></header>
    <div className="thread-scroll" ref={scroll} onScroll={() => { const element = scroll.current; if (element) following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100 }}><VirtualTimeline items={displayItems} scrollRef={scroll} itemKey={(item) => isActivityGroup(item) ? item.id : item.event_id} before={!hasUserEvents ? <ConversationMessage role="user" text={run.prompt} /> : undefined} renderItem={(item) => isActivityGroup(item) ? <ToolActivityGroup events={item.events} selectedId={selectedActivityId} onSelect={selectActivity} /> : <ThreadEvent event={item} run={run} durationMs={durations.get(item.event_id)} resolved={item.payload.rpc_id !== undefined && resolvedRequests.has(String(item.payload.rpc_id))} canRewind={Boolean(provider?.fork) && turnRewind && run.status === 'waiting_for_input' && queued.length === 0 && backtrackableEventIds.has(item.event_id)} onRewind={selectRewind} />} /></div>
    {showEnvironment && <EnvironmentPopover title="Environment" onClose={() => setShowEnvironment(false)}><EnvironmentRow icon={<Terminal size={16} />} label="Provider" value={provider?.name || run.provider} /><EnvironmentRow icon={host?.type === 'ssh' ? <Globe2 size={16} /> : <Laptop size={16} />} label="Location" value={host?.name} /><EnvironmentRow icon={<FolderGit2 size={16} />} label="Project" value={project?.name} /><EnvironmentRow icon={<GitBranch size={16} />} label="Workspace" value={workspaceLabel} /><EnvironmentRow icon={<Folder size={16} />} label="Path" value={run.cwd} /><TmuxDetails name={run.tmuxName} command={run.tmuxAccessCommand} /><div className="environment-actions"><button onClick={() => api.openPath(run.hostId, run.cwd)}>Open folder</button>{run.worktreeId && !active.has(run.status) && <><button onClick={async () => { const status = await api.worktreeStatus(run.hostId, run.worktreeId!); alert(`${status.summary}\n\n${status.diff_stat}`) }}>Inspect changes</button><button className="danger" onClick={async () => { const status = await api.worktreeStatus(run.hostId, run.worktreeId!); if (confirm(status.dirty ? 'This worktree has uncommitted changes. Force remove it?' : 'Remove this managed worktree?')) await api.removeWorktree(run.hostId, run.worktreeId!, status.dirty) }}>Remove worktree</button></>}</div>{host?.status !== 'online' && <p><WifiOff size={13} />Viewer reconnecting; run remains on host.</p>}</EnvironmentPopover>}
    {selectedActivity && <ActivityInspectorPanel entry={selectedActivity} hostId={run.hostId} cwd={run.cwd} onClose={() => setSelectedActivityId(null)} />}
    {!selectedActivity && filePreview.preview && <FilePreviewPanel state={filePreview.preview} onClose={filePreview.close} />}
    <ComposerFrame className={`thread-composer ${rewind ? 'rewinding' : ''}`} onSubmit={send}>{queued.length > 0 && <div className="queue-panel"><header><ListPlus size={13} /><strong>{queued.length} queued</strong>{run.status === 'waiting_for_input' && !tmuxRun && <button type="button" onClick={() => api.startQueued(run.hostId, run.id)}>Run next</button>}</header>{queued.map((item) => <div key={item.id}><span title={item.error || item.message}>{item.message}{item.error ? ' · failed to start' : ''}</span><button type="button" title="Remove queued prompt" onClick={() => api.removeQueued(run.hostId, run.id, item.id)}><X size={12} /></button></div>)}</div>}{rewind && <div className="rewind-banner"><Pencil size={13} />Editing previous message · sending creates a branch<button type="button" title="Cancel editing previous message" onClick={() => { setRewind(null); setMessage('') }}><X size={13} /></button></div>}<ComposerInput disabled={sending || (active.has(run.status) ? !canUseAttachedSession : !(run.sessionId && provider?.resume))} value={message} onChange={(event) => setMessage(event.target.value)} onKeyDown={handleComposerKeyDown} placeholder={tmuxRun ? 'Steer now · Tab queues after this turn' : active.has(run.status) ? (run.status === 'waiting_for_input' ? queued.length ? 'Run or remove queued prompts before editing history' : 'Continue this thread · edit a message above or press Esc Esc' : ui.activeInput === 'queue' ? `Queue for after this ${providerName(run.provider)} turn` : provider?.live_input ? 'Steer this turn' : 'Live steering is not available for this provider') : (run.sessionId && provider?.resume ? 'Continue this session' : 'This provider session cannot be resumed')} /><ComposerFooter><button type="button"><Plus size={18} /></button>{turnRunning && <button type="button" className="interrupt" onClick={() => api.controlRun(run.hostId, run.id, 'interrupt')}><Square size={14} />Interrupt</button>}{queuedInput && turnRunning && <button type="button" className="queue" disabled={!message.trim() || sending} onClick={queue}><ListPlus size={14} />Queue</button>}{tmuxRun && <span className="delivery-mode"><Send size={13} />Enter · Steer</span>}{ui.closeAttached && run.status === 'waiting_for_input' && <button type="button" className="interrupt" onClick={() => confirm(`Close this attached ${providerName(run.provider)} session?`) && api.controlRun(run.hostId, run.id, 'terminate')}><Square size={14} />Close</button>}{run.status === 'interrupting' && <><button type="button" className="interrupt" onClick={() => api.controlRun(run.hostId, run.id, 'terminate')}>Terminate</button><button type="button" className="interrupt" onClick={() => confirm('Force kill the full process group?') && api.controlRun(run.hostId, run.id, 'kill')}>Kill</button></>}<span /><small>{tmuxRun ? run.tmuxName : run.model || provider?.name}</small>{!active.has(run.status) && run.sessionId && provider?.fork && <button type="button" disabled={sending || !message.trim()} onClick={() => void sendPrompt('fork')}>Fork</button>}<button className="send" disabled={sending || !message.trim() || (active.has(run.status) ? !canUseAttachedSession : !(run.sessionId && provider?.resume))}>{sending ? <RefreshCw className="spin" size={15} /> : rewind ? <GitBranch size={16} /> : <Send size={17} />}</button></ComposerFooter></ComposerFrame>
  </div></FilePreviewContext.Provider>
}

function SessionScreen({ session, messages, project, host, provider, onStarted, onError }: { session: ProviderSession; messages: SessionMessage[]; project?: Project; host?: Host; provider?: Provider; onStarted: (run: Run) => void; onError: (message: string) => void }) {
  const scroll = useRef<HTMLDivElement>(null); const following = useRef(true); const [showEnvironment, setShowEnvironment] = useState(false); const [selectedActivityId, setSelectedActivityId] = useState<string | null>(null); const [message, setMessage] = usePersistentComposerDraft(`session:${session.hostId}:${session.provider}:${session.nativeSessionId}`); const [busy, setBusy] = useState(false); const [controlBusy, setControlBusy] = useState<'adopt' | 'move' | null>(null); const [moving, setMoving] = useState(false); const [queued, setQueued] = useState<ExternalQueuedInput[]>([])
  const submitting = useRef(false)
  const adoptedRun = useRef<string | null>(null)
  const filePreview = useFilePreview(session.hostId, session.cwd)
  const timeline = useMemo(() => historicalTimelineItems(messages), [messages])
  const activityEntries = timeline.flatMap((item) => isHistoricalActivity(item) ? historicalActivityItems(item.messages).flatMap((activity) => activity.type === 'entry' ? [activity.entry] : []) : [])
  const selectedActivity = selectedActivityId ? activityEntries.find((entry) => entry.id === selectedActivityId) || null : null
  const attached = Boolean(session.pid)
  const queuePid = session.pid || queued[0]?.pid
  const canUseAttachedSession = attached && host?.status === 'online' && session.inputTransport === 'tmux' && session.tmuxControlled === true
  const canResume = !attached && session.status !== 'running' && host?.status === 'online' && provider?.available === true && provider.resume
  const canSend = canUseAttachedSession || canResume
  const submitMessage = async (mode: 'steer' | 'queue' = 'steer') => {
    const prompt = message.trim()
    if (!prompt || !canSend || submitting.current) return
    submitting.current = true
    setBusy(true)
    try {
      if (canUseAttachedSession) {
        const result = await api.externalSessionInput(session, prompt, mode)
        if (result.queued) setQueued((items) => [...items.filter((item) => item.id !== result.queued!.id), result.queued!])
        setMessage('')
        if (result.run) onStarted(result.run)
      } else {
        const run = await api.resumeSession(session, prompt)
        setMessage('')
        onStarted(run)
      }
    }
    catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)) }
    finally { submitting.current = false; setBusy(false) }
  }
  const continueSession = (event: FormEvent) => { event.preventDefault(); void submitMessage() }
  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Tab' && canUseAttachedSession) {
      event.preventDefault()
      void submitMessage('queue')
      return
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void submitMessage()
    }
  }
  useEffect(() => { submitting.current = false; adoptedRun.current = null; setBusy(false); setControlBusy(null); setMoving(false); setQueued([]); setSelectedActivityId(null); filePreview.close() }, [session.hostId, session.id])
  useEffect(() => { if (selectedActivityId && !selectedActivity) setSelectedActivityId(null) }, [selectedActivityId, selectedActivity])
  useEffect(() => {
    if (!session.pid || !canUseAttachedSession || host?.status !== 'online') return
    let cancelled = false
    api.externalSessionQueue(session.hostId, session.pid).then((items) => {
      if (cancelled) return
      const started = items.find((item) => item.status === 'started' && item.run)
      if (started?.run && adoptedRun.current !== started.run.id) {
        adoptedRun.current = started.run.id
        void api.removeExternalQueued(session.hostId, session.pid!, started.id).catch(() => {})
        onStarted(started.run)
        return
      }
      setQueued(items)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [session.hostId, session.pid, host?.status, canUseAttachedSession])
  useEffect(() => {
    if (!queuePid || queued.length === 0 || host?.status !== 'online') return
    let stopped = false; let timer = 0
    const poll = async () => {
      if (stopped || document.hidden) return
      try {
        const items = await api.externalSessionQueue(session.hostId, queuePid)
        if (stopped) return
        const started = items.find((item) => item.status === 'started' && item.run)
        if (started?.run && adoptedRun.current !== started.run.id) {
          adoptedRun.current = started.run.id
          void api.removeExternalQueued(session.hostId, queuePid, started.id).catch(() => {})
          onStarted(started.run)
          return
        }
        setQueued(items)
      } catch {}
      if (!stopped && !document.hidden) timer = window.setTimeout(poll, 1000)
    }
    const visibility = () => { clearTimeout(timer); if (!document.hidden) void poll() }
    document.addEventListener('visibilitychange', visibility); timer = window.setTimeout(poll, 1000)
    return () => { stopped = true; clearTimeout(timer); document.removeEventListener('visibilitychange', visibility) }
  }, [session.hostId, queuePid, host?.status, queued.length > 0])
  useEffect(() => { if (following.current) requestAnimationFrame(() => scroll.current?.scrollTo({ top: scroll.current.scrollHeight })) }, [messages.length])
  useEffect(() => {
    const element = scroll.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (!following.current) return
      requestAnimationFrame(() => element.scrollTo({ top: element.scrollHeight }))
    })
    for (const child of element.children) observer.observe(child)
    return () => observer.disconnect()
  }, [session.hostId, session.id, timeline.length])
  const openFile = (href: string) => { setSelectedActivityId(null); filePreview.open(href) }
  const selectActivity = (entry: ActivityEntry) => { filePreview.close(); setShowEnvironment(false); setSelectedActivityId(entry.id) }
  return <FilePreviewContext.Provider value={openFile}><div className={`thread-screen provider-thread ${showEnvironment ? 'environment-open' : ''} ${filePreview.preview || selectedActivity ? 'file-preview-open' : ''}`}>
    <header className="thread-header">{providerIcon(session.provider)}<strong>{session.title}</strong>{session.status === 'running' && <span className="observed-badge"><Radio size={11} />Running</span>}<span /><button title="Thread actions"><MoreHorizontal size={18} /></button><button className={`environment-toggle ${showEnvironment ? 'active' : ''}`} onClick={() => setShowEnvironment((value) => !value)}><Info size={15} />Environment</button></header>
    <div className={`thread-scroll history-scroll ${canSend ? 'continuable' : ''}`} ref={scroll} onScroll={() => { const element = scroll.current; if (element) following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100 }}>{messages.length ? <VirtualTimeline items={timeline} scrollRef={scroll} itemKey={(item) => isHistoricalActivity(item) ? item.id : item.id} renderItem={(item) => isHistoricalActivity(item) ? <HistoricalActivityGroup messages={item.messages} selectedId={selectedActivityId} onSelect={selectActivity} /> : item.kind === 'turn_completed' ? <div className="turn-boundary"><span />{item.duration_ms !== undefined ? `Worked for ${durationLabel(item.duration_ms)}` : 'Turn completed'}<span /></div> : <ConversationMessage role={item.role} text={item.text} />} /> : <div className="thread-column">{host?.status !== 'online' ? <div className="thread-empty-state"><WifiOff size={20} /><strong>{host?.name || 'This host'} is offline</strong><p>The project and conversation remain in navigation. Messages will load when the host reconnects.</p></div> : <div className="thread-status"><RefreshCw className="spin" size={13} />Loading conversation</div>}</div>}</div>
    {showEnvironment && <EnvironmentPopover title="Environment" onClose={() => setShowEnvironment(false)}><EnvironmentRow icon={providerIcon(session.provider)} label="Provider" value={providerName(session.provider)} /><EnvironmentRow icon={host?.type === 'ssh' ? <Globe2 size={16} /> : <Laptop size={16} />} label="Location" value={host?.name} /><EnvironmentRow icon={<FolderGit2 size={16} />} label="Project" value={project?.name} /><TmuxDetails name={session.tmuxName} command={session.tmuxAccessCommand} /></EnvironmentPopover>}
    {selectedActivity && <ActivityInspectorPanel entry={selectedActivity} hostId={session.hostId} cwd={session.cwd} onClose={() => setSelectedActivityId(null)} />}
    {!selectedActivity && filePreview.preview && <FilePreviewPanel state={filePreview.preview} onClose={filePreview.close} />}
    {attached && !canUseAttachedSession && host?.status === 'online' && <div className="tmux-control-notice"><div><Terminal size={16} /><span><strong>{session.tmuxName ? 'tmux session detected' : moving ? 'Moving to tmux' : 'Terminal session'}</strong><small>{session.tmuxName ? 'Enable control to steer now or queue the next turn.' : moving ? 'Codesk will switch after the active turn becomes idle.' : 'Move this session to tmux to enable safe Steer and Queue input.'}</small></span></div><TmuxDetails name={session.tmuxName} command={session.tmuxAccessCommand} /><button type="button" disabled={Boolean(controlBusy) || moving} onClick={async () => { if (!session.pid) return; const action = session.tmuxName ? 'adopt' : 'move'; setControlBusy(action); try { if (action === 'adopt') await api.adoptExternalTmux(session); else { await api.moveExternalToTmux(session); setMoving(true) } } catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)) } finally { setControlBusy(null) } }}>{controlBusy ? <RefreshCw className="spin" size={14} /> : session.tmuxName ? <Plug size={14} /> : <Terminal size={14} />}{session.tmuxName ? 'Enable control' : moving ? 'Waiting for idle' : 'Move to tmux'}</button></div>}
    {canSend ? <ComposerFrame className="thread-composer history-composer" onSubmit={continueSession}>{queued.length > 0 && <div className="queue-panel"><header><ListPlus size={13} /><strong>{queued.filter((item) => item.status === 'queued' || item.status === 'sending').length} queued</strong></header>{queued.map((item) => <div key={item.id} className={item.status === 'failed' ? 'failed' : ''}><span title={item.error || item.message}>{item.message}{item.status === 'sending' ? ' · sending' : item.status === 'queued' ? ' · after this turn' : item.error ? ` · ${item.error}` : ''}</span>{queuePid && <button type="button" title="Remove queued prompt" onClick={async () => { await api.removeExternalQueued(session.hostId, queuePid, item.id); setQueued((items) => items.filter((candidate) => candidate.id !== item.id)) }}><X size={12} /></button>}</div>)}</div>}<ComposerInput autoFocus disabled={busy} value={message} onChange={(event) => setMessage(event.target.value)} onKeyDown={handleComposerKeyDown} placeholder={canUseAttachedSession ? `Steer this ${providerName(session.provider)} session` : `Continue this ${providerName(session.provider)} conversation`} /><ComposerFooter><button type="button"><Plus size={18} /></button>{canUseAttachedSession && <><span className="delivery-mode"><Send size={13} />Enter · Steer</span><span className="delivery-mode queue"><ListPlus size={13} />Tab · Queue</span></>}<span /><small>{canUseAttachedSession ? session.tmuxName : `Resume · ${provider?.name}`}</small><button className="send" disabled={!message.trim() || busy} title={canUseAttachedSession ? 'Steer now (Tab queues instead)' : 'Continue conversation'}>{busy ? <RefreshCw className="spin" size={15} /> : <Send size={17} />}</button></ComposerFooter></ComposerFrame> : !attached && <div className="history-notice"><Info size={14} /><span><strong>{host?.status !== 'online' ? 'Host offline' : provider && !provider.available ? `${provider.name} unavailable` : 'Continuation unavailable'}</strong>{host?.status !== 'online' ? 'Reconnect the host to continue this conversation.' : provider && !provider.available ? `Install or reconnect ${provider.name} on this host to continue.` : 'This provider does not expose a supported resume path for this session.'}</span></div>}
  </div></FilePreviewContext.Provider>
}

function ObservedScreen({ host, project, provider, agent, onStarted, onError }: { host?: Host; project?: Project; provider?: Provider; agent: DiscoveredAgent; onStarted: (run: Run) => void; onError: (message: string) => void }) {
  const [message, setMessage] = usePersistentComposerDraft(`agent:${host?.id || 'unknown'}:${agent.id}`); const [busy, setBusy] = useState(false); const [controlBusy, setControlBusy] = useState(false); const [moving, setMoving] = useState(false); const [queued, setQueued] = useState<ExternalQueuedInput[]>([])
  const controlled = Boolean(agent.tmux_controlled && agent.tmux_pane_id)
  const canContinue = Boolean(project && agent.native_session_id && controlled)
  const submit = async (delivery: 'steer' | 'queue' = 'steer') => {
    const prompt = message.trim(); if (!prompt || busy || host?.status !== 'online' || !project || !canContinue) return
    setBusy(true)
    try { const result = await api.externalAgentInput(host.id, project.id, agent.pid, agent.native_session_id, prompt, delivery); if (result.queued) setQueued((items) => [...items.filter((item) => item.id !== result.queued!.id), result.queued!]); setMessage(''); if (result.run) onStarted(result.run) }
    catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Tab' && controlled) { event.preventDefault(); void submit('queue'); return }
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit() }
  }
  useEffect(() => {
    if (!host || !agent.pid || !controlled || queued.length === 0 || host.status !== 'online') return
    let stopped = false; let timer = 0
    const poll = async () => {
      try {
        const items = await api.externalSessionQueue(host.id, agent.pid)
        if (stopped) return
        const started = items.find((item) => item.status === 'started' && item.run)
        if (started?.run) {
          void api.removeExternalQueued(host.id, agent.pid, started.id).catch(() => {})
          onStarted(started.run)
          return
        }
        setQueued(items)
      } catch {}
      if (!stopped) timer = window.setTimeout(poll, 1000)
    }
    timer = window.setTimeout(poll, 1000)
    return () => { stopped = true; clearTimeout(timer) }
  }, [host?.id, host?.status, agent.pid, queued.length > 0, controlled])
  return <div className="thread-screen observed-screen">
    <header className="thread-header">{providerIcon(agent.provider)}<strong>{providerName(agent.provider)} session</strong><span className="observed-badge"><Radio size={11} />Observed</span><span /><button><MoreHorizontal size={18} /></button></header>
    <div className="observed-content"><div className="observed-hero">{providerIcon(agent.provider)}<h1>{providerName(agent.provider)} is running</h1><p>{controlled ? 'Codesk can steer this tmux session directly and queue the next turn.' : agent.tmux_session_name ? 'Codesk found this tmux session. Enable control to send input safely.' : 'Move this terminal session to tmux after its active turn becomes idle.'}</p></div><TmuxDetails name={agent.tmux_session_name} command={agent.tmux_access_command} />{project && agent.native_session_id && !controlled && <button className="observed-tmux-action" type="button" disabled={controlBusy || moving} onClick={async () => { if (!host) return; setControlBusy(true); try { if (agent.tmux_session_name) await api.adoptExternalAgentTmux(host.id, project.id, agent.pid, agent.native_session_id); else { await api.moveExternalAgentToTmux(host.id, project.id, agent.pid, agent.native_session_id); setMoving(true) } } catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)) } finally { setControlBusy(false) } }}>{controlBusy ? <RefreshCw className="spin" size={14} /> : <Terminal size={14} />}{agent.tmux_session_name ? 'Enable control' : moving ? 'Waiting for idle' : 'Move to tmux'}</button>}</div>
    {canContinue && <ComposerFrame className="thread-composer history-composer" onSubmit={(event) => { event.preventDefault(); void submit() }}>{queued.length > 0 && <div className="queue-panel"><header><ListPlus size={13} /><strong>{queued.length} queued</strong></header>{queued.map((item) => <div key={item.id} className={item.status === 'failed' ? 'failed' : ''}><span title={item.error || item.message}>{item.message}{item.status === 'sending' ? ' · sending' : item.status === 'queued' ? ' · after this turn' : item.error ? ` · ${item.error}` : ''}</span></div>)}</div>}<ComposerInput autoFocus disabled={busy || host?.status !== 'online'} value={message} onChange={(event) => setMessage(event.target.value)} onKeyDown={keyDown} placeholder="Steer this session · Tab queues after this turn" /><ComposerFooter><button type="button"><Plus size={18} /></button><span className="delivery-mode"><Send size={13} />Enter · Steer</span><span className="delivery-mode queue"><ListPlus size={13} />Tab · Queue</span><span /><small>{agent.tmux_session_name}</small><button className="send" disabled={!message.trim() || busy || host?.status !== 'online'}>{busy ? <RefreshCw className="spin" size={15} /> : <Send size={17} />}</button></ComposerFooter></ComposerFrame>}
  </div>
}

function ThreadEvent({ event, run, durationMs, resolved, canRewind, onRewind }: { event: RunEvent; run: Run; durationMs?: number; resolved: boolean; canRewind: boolean; onRewind: (turnId: string, text: string) => void }) {
  const text = String(event.payload.text || '')
  const rpcId = event.payload.rpc_id
  const raw = event.raw_payload as { method?: string; params?: { permissions?: unknown; options?: Array<{ optionId?: string; name?: string; kind?: string }>; questions?: Array<{ id: string; question?: string; header?: string }> } }
  if (event.kind.startsWith('queue.')) return null
  if (event.kind === 'usage.updated') return <UsageCard event={event} />
  if (event.kind === 'commands.updated') return null
  if (event.kind === 'approval.required' && providerUi(run.provider).approvalMode === 'acp' && rpcId !== undefined && rpcId !== null) {
    const options = raw.params?.options || []
    return <div className={`request-card ${resolved ? 'resolved' : ''}`}><strong>{resolved ? 'Permission request resolved' : `${providerName(run.provider)} permission required`}</strong><p>{text}</p>{!resolved && <div>{options.map((option) => <button key={option.optionId} onClick={() => api.providerResponse(run.hostId, run.id, rpcId, { outcome: { outcome: 'selected', optionId: option.optionId } })}>{option.name || option.kind || option.optionId}</button>)}</div>}</div>
  }
  if (event.kind === 'approval.required' && rpcId !== undefined && rpcId !== null && raw?.method === 'item/permissions/requestApproval') return <div className={`request-card ${resolved ? 'resolved' : ''}`}><strong>{resolved ? 'Permission request resolved' : 'Additional permissions required'}</strong><p>{text}</p>{!resolved && <div><button onClick={() => api.providerResponse(run.hostId, run.id, rpcId, { permissions: raw.params?.permissions || {}, scope: 'turn' })}>Grant for turn</button><button onClick={() => api.providerResponse(run.hostId, run.id, rpcId, { permissions: raw.params?.permissions || {}, scope: 'session' })}>Grant for session</button><button className="decline" onClick={() => api.providerResponse(run.hostId, run.id, rpcId, { permissions: {} })}>Decline</button></div>}</div>
  if (event.kind === 'approval.required' && rpcId !== undefined && rpcId !== null) return <div className={`request-card ${resolved ? 'resolved' : ''}`}><strong>{resolved ? 'Approval resolved' : 'Approval required'}</strong><p>{text}</p>{!resolved && <div><button onClick={() => api.providerResponse(run.hostId, run.id, rpcId, { decision: 'accept' })}>Approve</button><button onClick={() => api.providerResponse(run.hostId, run.id, rpcId, { decision: 'acceptForSession' })}>Approve for session</button><button className="decline" onClick={() => api.providerResponse(run.hostId, run.id, rpcId, { decision: 'decline' })}>Decline</button></div>}</div>
  if (event.kind === 'input.required' && rpcId !== undefined && rpcId !== null) return <div className={`request-card ${resolved ? 'resolved' : ''}`}><strong>{resolved ? 'Input submitted' : `${providerName(run.provider)} needs input`}</strong><p>{text}</p>{!resolved && <div><button onClick={() => { const raw = event.raw_payload as { params?: { questions?: Array<{ id: string; question?: string; header?: string }> } }; const answers: Record<string, { answers: string[] }> = {}; for (const question of raw?.params?.questions || []) { const answer = prompt(question.question || question.header || `Answer ${run.provider}`); if (answer === null) return; answers[question.id] = { answers: [answer] } } void api.providerResponse(run.hostId, run.id, rpcId, { answers }) }}>Answer</button></div>}</div>
  if (event.kind === 'user.message') return <ConversationMessage role="user" text={text} className="rewindable">{canRewind && typeof event.payload.turn_id === 'string' && <button title="Edit this message and branch from here" onClick={() => onRewind(event.payload.turn_id as string, conversationText(text).text)}><Pencil size={12} />Edit from here</button>}</ConversationMessage>
  if (event.kind === 'turn.started') return null
  if (event.kind === 'turn.completed') return <div className="turn-boundary"><span />{durationMs !== undefined ? `Worked for ${durationLabel(durationMs)}` : 'Turn completed'}<span /></div>
  if (!text && !event.kind.startsWith('run.') && !event.kind.startsWith('control.') && !event.kind.startsWith('turn.') && !event.kind.startsWith('input.')) return null
  if (event.kind === 'assistant.message') return <ConversationMessage role="assistant" text={text} />
  if (event.kind === 'output' || event.kind.includes('message') || event.kind === 'tool.output') return <OperationalEvent event={event} run={run} />
  return <div className="thread-status"><span>{event.kind.replaceAll('.', ' ')}</span>{event.payload.exit_code !== undefined && <code>{String(event.payload.exit_code)}</code>}</div>
}

function Dialog({ title, subtitle, onClose, children }: { title: string; subtitle: string; onClose: () => void; children: React.ReactNode }) { return <div className="dialog-backdrop"><div className="codex-dialog"><header><div><h2>{title}</h2><p>{subtitle}</p></div><button onClick={onClose}><X size={18} /></button></header>{children}</div></div> }
function ProjectDialog({ hosts, onClose, onCreated }: { hosts: Host[]; onClose: () => void; onCreated: () => void }) {
  const online = hosts.filter((host) => host.status === 'online')
  const [hostId, setHost] = useState(online[0]?.id || '')
  const [input, setInput] = useState('')
  const [selectedPath, setSelectedPath] = useState('')
  const [currentPath, setCurrentPath] = useState('')
  const [parentPath, setParentPath] = useState<string | null>(null)
  const [homePath, setHomePath] = useState('')
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [highlighted, setHighlighted] = useState(0)
  const [busy, setBusy] = useState<'browse' | 'add' | ''>('')
  const [error, setError] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const selectedHost = online.find((host) => host.id === hostId)
  const isPathInput = pathLike(input)
  const filteredEntries = useMemo(() => {
    if (isPathInput) return entries
    return entries.map((entry) => ({ entry, score: folderMatchScore(entry, input) })).filter((item) => Number.isFinite(item.score)).sort((left, right) => left.score - right.score || left.entry.name.localeCompare(right.entry.name)).map((item) => item.entry)
  }, [entries, input, isPathInput])
  const browse = async (nextPath = currentPath) => {
    if (!hostId || busy === 'add') return
    setBusy('browse'); setError('')
    try {
      const listing = await api.files(hostId, nextPath)
      setCurrentPath(listing.current_path); setSelectedPath(listing.current_path); setInput(''); setHighlighted(0); setParentPath(listing.parent_path || null); setHomePath(listing.home_path); setEntries(listing.entries)
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy('') }
  }
  useEffect(() => { setEntries([]); setInput(''); setSelectedPath(''); setCurrentPath(''); setParentPath(null); setHomePath(''); setHighlighted(0); if (hostId) void browse('') }, [hostId])
  useEffect(() => { setHighlighted(0) }, [input])
  useEffect(() => { document.querySelector('.folder-entry.highlighted')?.scrollIntoView({ block: 'nearest' }) }, [highlighted])
  const segments = currentPath.split('/').filter(Boolean)
  const openInput = () => { const target = isPathInput ? input.trim() : filteredEntries[highlighted]?.path; if (target) void browse(target) }
  return <Dialog title="Add folder" subtitle="Choose a folder on this Mac or a connected host." onClose={onClose}><div className="folder-dialog" onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'l') { event.preventDefault(); searchRef.current?.focus() } }}>
    <div className="folder-hosts">{online.map((host) => <button type="button" className={host.id === hostId ? 'selected' : ''} key={host.id} onClick={() => setHost(host.id)}>{host.type === 'ssh' ? <Server size={16} /> : <Laptop size={16} />}<span><strong>{host.name}</strong><small>{host.type === 'ssh' ? host.sshAlias : 'This Mac'}</small></span><i className={host.status} /></button>)}</div>
    <div className="folder-toolbar"><button type="button" title="Parent folder" disabled={!parentPath || !!busy} onClick={() => parentPath && void browse(parentPath)}><ChevronLeft size={17} /></button><button type="button" title="Home folder" disabled={!homePath || !!busy} onClick={() => void browse(homePath)}><Home size={16} /></button><form onSubmit={(event) => { event.preventDefault(); openInput() }}><Search size={15} /><input ref={searchRef} aria-label="Search folders or enter a path" value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'ArrowDown') { event.preventDefault(); setHighlighted((value) => Math.min(filteredEntries.length - 1, value + 1)) } else if (event.key === 'ArrowUp') { event.preventDefault(); setHighlighted((value) => Math.max(0, value - 1)) } else if (event.key === 'Escape') { event.preventDefault(); setInput(''); setHighlighted(0) } else if (event.key === 'Tab' && !isPathInput && filteredEntries[highlighted]) { event.preventDefault(); setInput(filteredEntries[highlighted].name) } }} placeholder={selectedHost?.type === 'ssh' ? 'Search folders or enter /home/…' : 'Search folders or enter /Users/…'} /><button title={isPathInput ? 'Go to path' : 'Open highlighted folder'} disabled={(!input.trim() && !filteredEntries[highlighted]) || !!busy}><ChevronRight size={16} /></button></form><button type="button" title="Refresh" disabled={!!busy} onClick={() => void browse(currentPath)}><RefreshCw className={busy === 'browse' ? 'spin' : ''} size={15} /></button></div>
    <div className="folder-breadcrumb"><button type="button" onClick={() => void browse('/')}><span>/</span></button>{segments.map((segment, index) => { const segmentPath = `/${segments.slice(0, index + 1).join('/')}`; return <span key={segmentPath}><ChevronRight size={12} /><button type="button" onClick={() => void browse(segmentPath)}>{segment}</button></span> })}</div>
    <div className="folder-search-status"><span>{input.trim() && !isPathInput ? `${filteredEntries.length} matching folder${filteredEntries.length === 1 ? '' : 's'}` : `${entries.length} folder${entries.length === 1 ? '' : 's'}`}</span><small><kbd>↑</kbd><kbd>↓</kbd> choose <kbd>Enter</kbd> open <kbd>Tab</kbd> complete <kbd>Esc</kbd> clear</small></div>
    <div className="folder-list">{busy === 'browse' && !entries.length ? <div className="folder-state"><RefreshCw className="spin" size={16} />Loading folders</div> : filteredEntries.length ? filteredEntries.map((entry, index) => <div className={`folder-entry ${selectedPath === entry.path && currentPath !== entry.path ? 'selected' : ''} ${!isPathInput && index === highlighted ? 'highlighted' : ''}`} key={entry.path}><button type="button" className="folder-entry-main" onMouseEnter={() => setHighlighted(index)} onDoubleClick={() => void browse(entry.path)} onClick={() => setSelectedPath(entry.path)}><span className="folder-icon">{entry.is_git ? <FolderGit2 size={17} /> : <Folder size={17} />}</span><span><strong>{entry.name}</strong><small>{entry.path}</small></span>{entry.is_git && <em>Git repository</em>}</button><button type="button" className="folder-open" title={`Open ${entry.name}`} onClick={() => void browse(entry.path)}><ChevronRight size={15} /></button></div>) : <div className="folder-state">{input.trim() && !isPathInput ? <><Search size={18} /><strong>No matching folders</strong><span>Try another name or type a full path.</span></> : <><Folder size={18} /><strong>This folder is empty</strong><span>You can still add it as a project.</span></>}</div>}</div>
    <div className="folder-selection"><FolderGit2 size={16} /><span><small>Folder to add</small><strong>{selectedPath || currentPath || 'Choose a folder'}</strong></span>{selectedPath && currentPath && selectedPath !== currentPath && <button type="button" onClick={() => void browse(selectedPath)}>Open</button>}</div>
    {error && <p className="dialog-error">{error}</p>}<p className="folder-note">Codesk registers only the selected folder. Sessions from nested folders stay separate and are not included in this project.</p>
    <footer><button type="button" onClick={onClose}>Cancel</button><button type="button" className="dialog-primary" disabled={!selectedPath || !!busy} onClick={async () => { setBusy('add'); setError(''); try { const name = selectedPath.split('/').filter(Boolean).at(-1) || selectedPath; await api.createProject({ hostId, name, path: selectedPath }); onCreated() } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setBusy('') } }}>{busy === 'add' ? <><RefreshCw className="spin" size={14} />Adding…</> : 'Add folder'}</button></footer>
  </div></Dialog>
}
function ConnectionsDialog({ hosts, onClose, onChanged }: { hosts: Host[]; onClose: () => void; onChanged: () => void }) {
  const [name, setName] = useState(''); const [alias, setAlias] = useState(''); const [aliases, setAliases] = useState<string[]>([]); const [agents, setAgents] = useState<Record<string, DiscoveredAgent[]>>({}); const [busy, setBusy] = useState(''); const [error, setError] = useState('')
  useEffect(() => { api.sshAliases().then(setAliases).catch(() => {}) }, [])
  const inspectAgents = async (host: Host) => { setBusy(`agents:${host.id}`); setError(''); try { const found = await api.discoveredAgents(host.id); setAgents((current) => ({ ...current, [host.id]: found })) } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy('') } }
  return <Dialog title="Connections" subtitle="Local and SSH execution hosts" onClose={onClose}><div className="connection-list">{hosts.map((host) => <div className="connection-host" key={host.id}><div className="connection-row"><i className={host.status} /><span><strong>{host.name}</strong><small>{host.type === 'local' ? 'Local daemon' : host.sshAlias}{host.error ? ` · ${host.error}` : ''}</small></span><button title="Discover running agents" disabled={host.status !== 'online'} onClick={() => void inspectAgents(host)}><Radio size={15} /></button>{host.type === 'ssh' && <button title="Install or reconnect" onClick={async () => { setBusy(`host:${host.id}`); setError(''); try { await api.bootstrapHost(host.id); await onChanged() } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy('') } }}>{busy === `host:${host.id}` ? <RefreshCw className="spin" size={15} /> : <RefreshCw size={15} />}</button>}</div>{agents[host.id]?.map((agent) => <div className="discovered-agent" key={agent.id}>{providerIcon(agent.provider)}<span><strong>{agent.provider} · PID {agent.pid}</strong><small>{agent.cwd || agent.command}</small></span>{agent.managed_run_id ? <em>Managed</em> : <button onClick={() => api.controlDiscoveredAgent(host.id, agent.pid, 'interrupt')}><Square size={12} />Interrupt</button>}</div>)}</div>)}</div>{error && <p className="dialog-error">{error}</p>}<form className="connection-add" onSubmit={async (event) => { event.preventDefault(); setError(''); try { const host = await api.createHost({ name: name || alias, sshAlias: alias }); setName(''); setAlias(''); await onChanged(); try { await api.bootstrapHost(host.id); await onChanged() } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } }}><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Display name" /><input list="ssh-aliases" value={alias} onChange={(event) => setAlias(event.target.value)} placeholder="SSH alias" /><datalist id="ssh-aliases">{aliases.map((value) => <option key={value} value={value} />)}</datalist><button><Plus size={16} />Connect</button></form></Dialog>
}
