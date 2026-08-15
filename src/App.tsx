import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Archive, Bell, Bot, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, Circle, Clock3, Command, Cpu, FileDiff, Folder, FolderGit2, Home, Info,
  GitBranch, Globe2, Laptop, MoreHorizontal, Plug, Plus, Radio, RefreshCw,
  ListPlus, Pencil, Pin, PinOff, Search, Send, Server, Settings2, ShieldAlert, Square, Terminal, TreePine,
  WifiOff, X, Zap,
} from 'lucide-react'
import { api, gatewayOrigin } from './api'
import type { AppState, DiscoveredAgent, DraftSession, FileEntry, GitContext, Host, Project, Provider, ProviderSession, Run, RunEvent, SessionMessage } from './types'

const empty: AppState = { hosts: [], projects: [], runs: [], sessions: [], drafts: [], providersByHost: {}, discoveredAgentsByHost: {}, settings: { notifications: true, pinnedSessionKeys: [], pinnedSessions: [] } }
const active = new Set(['queued', 'starting', 'running', 'waiting_for_input', 'interrupting'])
const markdownPlugins = [remarkGfm]
const environmentContextPattern = /<environment_context>[\s\S]*?<\/environment_context>/gi

const providerIcon = (id: string) => id === 'codex' ? <Bot size={16} /> : id === 'pi' ? <Zap size={16} /> : id === 'claude' ? <Cpu size={16} /> : <Terminal size={16} />
const relative = (value?: string | null) => { if (!value) return ''; const seconds = Math.floor((Date.now() - new Date(value).getTime()) / 1000); return seconds < 60 ? 'now' : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 3600)}h` }
const prepareNotifications = async () => { if (!("Notification" in window)) return; if (Notification.permission === 'default') await Notification.requestPermission() }
const notify = async (title: string, body: string, tag: string) => { if (!("Notification" in window)) return; await prepareNotifications(); if (Notification.permission === 'granted') new Notification(title, { body, tag }) }
const projectKey = (project: Project) => `${project.hostId}:${project.id}`
const projectForAgent = (projects: Project[], hostId: string, agent: DiscoveredAgent) => projects.filter((project) => project.hostId === hostId && agent.cwd && (agent.cwd === project.path || agent.cwd.startsWith(`${project.path}/`))).sort((left, right) => right.path.length - left.path.length)[0]
const observedAgents = (state: AppState) => {
  const sessions = new Map<string, { hostId: string; agent: DiscoveredAgent; project?: Project }>()
  for (const [hostId, agents] of Object.entries(state.discoveredAgentsByHost || {})) for (const agent of agents) {
    if (agent.managed_run_id || /codex-code-mode-host|app-server(?:\s|$)/.test(agent.command)) continue
    const key = `${hostId}:${agent.process_group_id || agent.pid}`
    if (!sessions.has(key)) sessions.set(key, { hostId, agent, project: projectForAgent(state.projects, hostId, agent) })
  }
  return [...sessions.values()]
}
const providerName = (provider: string) => provider === 'codex' ? 'Codex' : provider === 'pi' ? 'Pi' : provider === 'claude' ? 'Claude Code' : 'Command'
const sessionKey = (session: Pick<ProviderSession, 'hostId' | 'id'>) => `${session.hostId}:${session.id}`
const recentFirst = (left: ProviderSession, right: ProviderSession) => right.sortAt.localeCompare(left.sortAt) || Number(right.status === 'running') - Number(left.status === 'running')
const pathLike = (value: string) => { const query = value.trim(); return query.startsWith('/') || query.startsWith('~') || query.includes('/') }
const mergeEvents = (prior: RunEvent[], incoming: RunEvent[]) => {
  const merged = new Map(prior.map((event) => [event.event_id, event]))
  for (const event of incoming) merged.set(event.event_id, event)
  return [...merged.values()].sort((left, right) => left.run_sequence - right.run_sequence)
}
const coalesceStreamEvents = (events: RunEvent[]) => {
  const result: RunEvent[] = []
  for (const event of events) {
    const itemId = typeof event.payload.item_id === 'string' ? event.payload.item_id : ''
    const stream = itemId && ['assistant.message', 'reasoning.message', 'tool.output'].includes(event.kind)
    const prior = result.at(-1)
    if (stream && prior?.kind === event.kind && prior.channel === event.channel && prior.payload.item_id === itemId) {
      const finalItem = event.provider_event_type === 'codex.item/completed'
      const nextText = finalItem ? String(event.payload.text || prior.payload.text || '') : `${String(prior.payload.text || '')}${String(event.payload.text || '')}`
      result[result.length - 1] = { ...prior, event_id: event.event_id, run_sequence: event.run_sequence, timestamp: event.timestamp, payload: { ...prior.payload, text: nextText } }
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
const normalizeState = (value: AppState) => ({ ...value, drafts: value.drafts || [], settings: { notifications: value.settings?.notifications ?? true, pinnedSessionKeys: value.settings?.pinnedSessionKeys || [], pinnedSessions: value.settings?.pinnedSessions || [] } })
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
  const [error, setError] = useState('')
  const initialized = useRef(false)
  const sessionMessagesRef = useRef<Record<string, SessionMessage[]>>({})
  const priorSessionStatus = useRef<Map<string, ProviderSession['status']>>(new Map())
  const notified = useRef<Set<string>>(new Set(JSON.parse(localStorage.getItem('codesk.notifications') || '[]')))
  const initializeSelection = (next: AppState) => {
    const firstDraft = next.drafts[0]; const firstSession = next.sessions[0] || next.settings.pinnedSessions[0]; const firstRun = next.runs[0]
    if (firstDraft) setSelectedDraftId(firstDraft.id); else if (firstSession) setSelectedSessionKey(sessionKey(firstSession)); else setSelectedId(firstRun?.id || null)
    const firstProject = firstDraft ? next.projects.find((item) => item.id === firstDraft.projectId && item.hostId === firstDraft.hostId) : firstSession ? next.projects.find((item) => item.id === firstSession.projectId && item.hostId === firstSession.hostId) : firstRun ? next.projects.find((item) => item.id === firstRun.projectId && item.hostId === firstRun.hostId) : next.projects[0]
    setSelectedProjectKey(firstProject ? projectKey(firstProject) : null); initialized.current = true
  }
  const reload = async () => { try { const next = normalizeState(await api.state()); setState(next); setExtraSessions((current) => { const refreshed = { ...current }; for (const [key, items] of Object.entries(refreshed)) { const latest = new Map(next.sessions.filter((item) => `${item.hostId}:${item.projectId}` === key).map((item) => [sessionKey(item), item])); refreshed[key] = items.map((item) => latest.get(sessionKey(item)) || item) } return refreshed }); setError(''); if (!initialized.current) initializeSelection(next); else { setSelectedId((id) => id && next.runs.some((item) => item.id === id) ? id : null); setSelectedDraftId((id) => id && next.drafts.some((item) => item.id === id) ? id : null); setSelectedSessionKey((key) => key && [...next.sessions, ...next.settings.pinnedSessions].some((item) => sessionKey(item) === key) ? key : null) } } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } }
  useEffect(() => { let cancelled = false; api.navigation().then((value) => { if (cancelled || initialized.current) return; const next = normalizeState(value); setState(next); if (next.projects.length || next.drafts.length || next.sessions.length || next.runs.length || next.settings.pinnedSessions.length) initializeSelection(next) }).catch(() => {}); return () => { cancelled = true } }, [])
  useEffect(() => { let cancelled = false; let timer = 0; const poll = async () => { if (cancelled) return; await reload(); timer = window.setTimeout(poll, state.hosts.length ? 5000 : 650) }; void poll(); return () => { cancelled = true; clearTimeout(timer) } }, [])
  const run = state.runs.find((item) => item.id === selectedId) || null
  const session = [...state.sessions, ...Object.values(extraSessions).flat(), ...state.settings.pinnedSessions].find((item) => sessionKey(item) === selectedSessionKey) || null
  const sessionHostStatus = session ? state.hosts.find((item) => item.id === session.hostId)?.status : undefined
  const draft = state.drafts.find((item) => item.id === selectedDraftId) || null
  useEffect(() => { if (!run || events[run.id]) return; api.events(run.hostId, run.id).then((items) => setEvents((current) => ({ ...current, [run.id]: items }))).catch(() => {}) }, [run?.id])
  useEffect(() => {
    if (!session || !selectedSessionKey || sessionHostStatus !== 'online') return
    let stopped = false
    let timer = 0
    const load = async () => {
      const prior = sessionMessagesRef.current[selectedSessionKey] || []
      const after = [...prior].reverse().find((item) => item.timestamp)?.timestamp
      try {
        const incoming = await api.sessionMessages(session.hostId, session.projectId, session.provider, session.nativeSessionId, after)
        if (stopped || !incoming.length) return
        setSessionMessages((current) => {
          const existing = current[selectedSessionKey] || []
          const merged = new Map(existing.map((item) => [item.id, item]))
          for (const item of incoming) merged.set(item.id, item)
          const next = [...merged.values()].sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.id.localeCompare(right.id))
          if (next.length === existing.length && next.every((item, index) => item.id === existing[index].id && item.timestamp === existing[index].timestamp && item.role === existing[index].role && item.text === existing[index].text)) return current
          const updated = { ...current, [selectedSessionKey]: next }
          sessionMessagesRef.current = updated
          return updated
        })
      } catch (cause) {
        if (!stopped) setError(cause instanceof Error ? cause.message : String(cause))
      }
    }
    const poll = async () => { await load(); if (!stopped) timer = window.setTimeout(poll, 2000) }
    void poll()
    return () => { stopped = true; clearTimeout(timer) }
  }, [selectedSessionKey, session?.hostId, session?.projectId, session?.provider, session?.nativeSessionId, sessionHostStatus])
  useEffect(() => {
    const origin = gatewayOrigin ? gatewayOrigin.replace('http://', 'ws://').replace('https://', 'wss://') : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`
    let ws: WebSocket | null = null; let stopped = false; let retry = 500
    const replay = async () => { const snapshot = await api.state(); await Promise.all(snapshot.runs.map(async (item) => { const incoming = await api.events(item.hostId, item.id); setEvents((current) => ({ ...current, [item.id]: mergeEvents(current[item.id] || [], incoming) })) })) }
    const connect = () => { if (stopped) return; ws = new WebSocket(`${origin}/ws`); ws.onopen = () => { retry = 500; void reload(); void replay().catch(() => {}) }; ws.onmessage = (message) => { const envelope = JSON.parse(message.data); if (envelope.type === 'daemon.event') { const event = envelope.payload.event as RunEvent; setEvents((current) => { const prior = current[event.run_id] || []; return prior.some((item) => item.event_id === event.event_id) ? current : { ...current, [event.run_id]: [...prior, event].sort((a, b) => a.run_sequence - b.run_sequence) } }); if (event.kind.startsWith('run.') || event.kind.startsWith('control.') || event.kind.startsWith('turn.') || event.kind.startsWith('thread.') || event.kind.startsWith('queue.')) void reload(); if (['run.completed','run.failed','run.interrupted','run.killed','run.orphaned','input.required','approval.required'].includes(event.kind) && !notified.current.has(event.event_id)) { notified.current.add(event.event_id); localStorage.setItem('codesk.notifications', JSON.stringify([...notified.current].slice(-500))); void notify(`Codesk · ${event.kind.replaceAll('.', ' ')}`, String(event.payload.text || 'Agent run updated'), event.event_id) } } else if (envelope.type.startsWith('host.') || envelope.type.startsWith('draft.') || envelope.type === 'settings.updated') void reload() }; ws.onclose = () => { if (!stopped) { window.setTimeout(connect, retry); retry = Math.min(10000, retry * 1.8) } }; ws.onerror = () => ws?.close() }
    connect(); return () => { stopped = true; ws?.close() }
  }, [])
  useEffect(() => {
    if (!state.settings.notifications) return
    void prepareNotifications()
  }, [state.settings.notifications])
  useEffect(() => {
    for (const session of state.sessions) {
      const key = `${session.hostId}:${session.id}`; const prior = priorSessionStatus.current.get(key)
      if (session.status === 'stopped' && prior === 'running' && state.settings.notifications) void notify('Codesk · Agent stopped', session.title, `session-stopped:${key}:${session.updatedAt}`)
      priorSessionStatus.current.set(key, session.status)
    }
  }, [state.sessions, state.settings.notifications])
  const allSessions = useMemo(() => {
    const merged = new Map([...state.settings.pinnedSessions, ...state.sessions].map((item) => [sessionKey(item), item]))
    for (const items of Object.values(extraSessions)) for (const item of items) merged.set(sessionKey(item), item)
    return [...merged.values()]
  }, [state.sessions, state.settings.pinnedSessions, extraSessions])
  const agents = useMemo(() => observedAgents(state), [state])
  const selectedAgent = agents.find(({ hostId, agent }) => `${hostId}:${agent.id}` === selectedAgentKey) || null
  const project = draft ? state.projects.find((item) => item.id === draft.projectId && item.hostId === draft.hostId) : session ? state.projects.find((item) => item.id === session.projectId && item.hostId === session.hostId) : run ? state.projects.find((item) => item.id === run.projectId && item.hostId === run.hostId) : selectedAgent?.project || state.projects.find((item) => projectKey(item) === selectedProjectKey) || state.projects[0]
  const host = project ? state.hosts.find((item) => item.id === project.hostId) : state.hosts[0]
  const provider = run ? state.providersByHost[run.hostId]?.find((item) => item.id === run.provider) : undefined
  const selectProject = (next: Project) => { setSelectedProjectKey(projectKey(next)); setSelectedId(null); setSelectedSessionKey(null); setSelectedAgentKey(null); setSelectedDraftId(null) }
  const selectRun = (next: Run) => { setSelectedId(next.id); setSelectedSessionKey(null); setSelectedAgentKey(null); setSelectedDraftId(null); setSelectedProjectKey(`${next.hostId}:${next.projectId}`) }
  const selectSession = (next: ProviderSession) => { setSelectedSessionKey(`${next.hostId}:${next.id}`); setSelectedId(null); setSelectedAgentKey(null); setSelectedDraftId(null); setSelectedProjectKey(`${next.hostId}:${next.projectId}`) }
  const selectDraft = (next: DraftSession) => { setSelectedDraftId(next.id); setSelectedId(null); setSelectedSessionKey(null); setSelectedAgentKey(null); setSelectedProjectKey(`${next.hostId}:${next.projectId}`) }
  const selectAgent = (hostId: string, agent: DiscoveredAgent, nextProject?: Project) => { setSelectedAgentKey(`${hostId}:${agent.id}`); setSelectedId(null); setSelectedSessionKey(null); setSelectedDraftId(null); if (nextProject) setSelectedProjectKey(projectKey(nextProject)) }
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
  return <div className="codex-shell">
    <Sidebar state={state} runs={state.runs} sessions={allSessions} agents={agents} selectedId={selectedId} selectedSessionKey={selectedSessionKey} selectedAgentKey={selectedAgentKey} selectedDraftId={selectedDraftId} selectedProjectKey={selectedProjectKey} query={query} onQuery={setQuery} onSelectRun={selectRun} onSelectSession={selectSession} onSelectDraft={selectDraft} onSelectAgent={selectAgent} onSelectProject={selectProject} onTogglePin={togglePin} onShowMore={async (project) => { const key = projectKey(project); try { const items = await api.projectSessions(project.hostId, project.id, 150); setExtraSessions((current) => ({ ...current, [key]: items })); return true } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return false } }} onNewRun={() => void newDraft()} onNewProject={() => setNewProject(true)} onSettings={() => setSettings(true)} />
    <section className="codex-main">
      {session ? <SessionScreen session={session} messages={sessionMessages[selectedSessionKey!] || []} project={project} host={host} /> : run ? <RunScreen run={run} events={events[run.id] || []} project={project} host={host} provider={provider} /> : selectedAgent ? <ObservedScreen host={state.hosts.find((item) => item.id === selectedAgent.hostId)} project={selectedAgent.project} agent={selectedAgent.agent} /> : <StartScreen key={draft?.id || (project ? projectKey(project) : 'empty')} state={state} draft={draft || undefined} project={project} host={host} onProject={() => setNewProject(true)} onStarted={(next) => { selectRun(next); void reload() }} />}
    </section>
    {error && <div className="toast-error">{error}<button onClick={() => setError('')}><X size={14} /></button></div>}
    {newProject && <ProjectDialog hosts={state.hosts} onClose={() => setNewProject(false)} onCreated={async () => { setNewProject(false); await reload() }} />}
    {settings && <ConnectionsDialog hosts={state.hosts} onClose={() => setSettings(false)} onChanged={reload} />}
  </div>
}

function Sidebar({ state, runs, sessions, agents, selectedId, selectedSessionKey, selectedAgentKey, selectedDraftId, selectedProjectKey, query, onQuery, onSelectRun, onSelectSession, onSelectDraft, onSelectAgent, onSelectProject, onTogglePin, onShowMore, onNewRun, onNewProject, onSettings }: {
  state: AppState; runs: Run[]; sessions: ProviderSession[]; agents: ReturnType<typeof observedAgents>
  selectedId: string | null; selectedSessionKey: string | null; selectedAgentKey: string | null; selectedDraftId: string | null; selectedProjectKey: string | null
  query: string; onQuery: (value: string) => void; onSelectRun: (run: Run) => void; onSelectSession: (session: ProviderSession) => void; onSelectDraft: (draft: DraftSession) => void
  onSelectAgent: (hostId: string, agent: DiscoveredAgent, project?: Project) => void; onSelectProject: (project: Project) => void; onTogglePin: (session: ProviderSession) => Promise<void>
  onShowMore: (project: Project) => Promise<boolean>; onNewRun: () => void; onNewProject: () => void; onSettings: () => void
}) {
  const [expanded, setExpanded] = useState<Set<string>>(loadExpandedProjects)
  const [expandedSessionLists, setExpandedSessionLists] = useState<Set<string>>(() => new Set())
  const scroller = useRef<HTMLDivElement>(null)
  const preSearchScroll = useRef(0)
  const restoreSearchScroll = useRef(false)
  const searchScrollCaptured = useRef(false)
  const queryRef = useRef(query)
  queryRef.current = query
  const onNewRunRef = useRef(onNewRun)
  onNewRunRef.current = onNewRun
  const needle = query.trim().toLowerCase()
  const pinnedKeys = state.settings.pinnedSessionKeys
  const pinnedSessions = pinnedKeys.map((key) => sessions.find((session) => sessionKey(session) === key)).filter((session): session is ProviderSession => Boolean(session)).filter((session) => {
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
      if (event.key.toLowerCase() === 'k') { event.preventDefault(); if (!queryRef.current && !searchScrollCaptured.current) { preSearchScroll.current = scroller.current?.scrollTop || 0; searchScrollCaptured.current = true } document.querySelector<HTMLInputElement>('.navigation-search input')?.focus() }
      if (event.key.toLowerCase() === 'n') { event.preventDefault(); onNewRunRef.current() }
    }
    document.addEventListener('keydown', shortcuts)
    return () => document.removeEventListener('keydown', shortcuts)
  }, [])
  const toggle = (key: string) => setExpanded((current) => { const next = new Set(current); next.has(key) ? next.delete(key) : next.add(key); saveStringSet('codesk.expanded-projects:v1', next); return next })
  const expandSessions = async (project: Project) => { if (await onShowMore(project)) setExpandedSessionLists((current) => new Set(current).add(projectKey(project))) }
  const updateQuery = (value: string) => {
    if (!query && value && !searchScrollCaptured.current) { preSearchScroll.current = scroller.current?.scrollTop || 0; searchScrollCaptured.current = true }
    const restore = Boolean(query && !value)
    if (restore) restoreSearchScroll.current = true
    onQuery(value)
  }
  let visibleProjectCount = 0
  return <aside className="codex-sidebar">
    <div className="sidebar-top"><strong>Codesk</strong><ChevronDown size={14} /><span /><button title="Search conversations" onClick={() => document.querySelector<HTMLInputElement>('.navigation-search input')?.focus()}><Search size={17} /></button><button title="Notifications"><Bell size={17} /></button></div>
    <button className="side-action" onClick={onNewRun}><Plus size={17} />New chat</button>
    <button className="side-action"><GitBranch size={17} />Pull requests</button>
    <button className="side-action"><Clock3 size={17} />Scheduled</button>
    <button className="side-action"><Plug size={17} />Plugins</button>
    <div className="navigation-scroller" ref={scroller} onScroll={(event) => { if (needle || restoreSearchScroll.current) return; try { localStorage.setItem('codesk.navigation-scroll:v1', String(event.currentTarget.scrollTop)) } catch {} }}>
      <div className="navigation-search"><Search size={13} /><input aria-label="Search projects and conversations" value={query} onPointerDown={() => { if (!query && !searchScrollCaptured.current) { preSearchScroll.current = scroller.current?.scrollTop || 0; searchScrollCaptured.current = true } }} onFocus={() => { if (!query && !searchScrollCaptured.current) { preSearchScroll.current = scroller.current?.scrollTop || 0; searchScrollCaptured.current = true } }} onChange={(event) => updateQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') { updateQuery(''); event.currentTarget.blur() } }} placeholder="Search" />{query && <button title="Clear search" onClick={() => updateQuery('')}><X size={12} /></button>}</div>
      {pinnedSessions.length > 0 && <section className="pinned-section" aria-label="Pinned conversations"><div className="side-heading"><span>Pinned</span></div>{pinnedSessions.map((session) => {
        const key = sessionKey(session); const project = state.projects.find((item) => item.id === session.projectId && item.hostId === session.hostId); const host = state.hosts.find((item) => item.id === session.hostId)
        return <div className="pinned-row" key={key}><button data-session-key={key} className={`pinned-session ${key === selectedSessionKey ? 'selected' : ''}`} title={`${project?.name || session.cwd} · ${host?.name || session.hostId}`} onClick={() => onSelectSession(session)} onContextMenu={(event) => { event.preventDefault(); void onTogglePin(session) }}><Pin size={12} /><span><strong>{session.title}</strong><small>{project?.name || 'Unknown project'} · {host?.name || session.hostId}</small></span></button><button className="session-pin" title="Unpin conversation" onClick={() => void onTogglePin(session)}><PinOff size={12} /></button></div>
      })}</section>}
      <section className="projects-section" aria-label="Projects"><div className="side-heading"><span>Projects</span><button title="Add project" onClick={onNewProject}><Plus size={15} /></button></div><div className="project-tree" role="tree">{state.projects.map((project) => {
        const key = projectKey(project); const host = state.hosts.find((item) => item.id === project.hostId)
        const allProjectDrafts = state.drafts.filter((draft) => draft.projectId === project.id && draft.hostId === project.hostId)
        const allProjectSessions = sessions.filter((session) => session.projectId === project.id && session.hostId === project.hostId).sort(recentFirst)
        const allProjectRuns = runs.filter((run) => run.projectId === project.id && run.hostId === project.hostId && !allProjectSessions.some((session) => session.nativeSessionId === run.sessionId))
        const allProjectAgents = agents.filter((item) => item.project && projectKey(item.project) === key && !allProjectSessions.some((session) => session.provider === item.agent.provider && session.status === 'running'))
        const projectMatches = `${project.name} ${project.path} ${host?.name || ''}`.toLowerCase().includes(needle)
        const projectDrafts = !needle || projectMatches || 'new chat'.includes(needle) ? allProjectDrafts : []
        const matchingSessions = !needle || projectMatches ? allProjectSessions : allProjectSessions.filter((session) => `${session.title} ${session.provider}`.toLowerCase().includes(needle))
        const projectRuns = !needle || projectMatches ? allProjectRuns : allProjectRuns.filter((run) => `${run.title} ${run.prompt} ${run.provider}`.toLowerCase().includes(needle))
        const projectAgents = !needle || projectMatches ? allProjectAgents : allProjectAgents.filter(({ agent }) => `${providerName(agent.provider)} ${agent.cwd || ''}`.toLowerCase().includes(needle))
        if (needle && !projectMatches && !projectDrafts.length && !matchingSessions.length && !projectRuns.length && !projectAgents.length) return null
        visibleProjectCount += 1
        const open = needle ? true : expanded.has(key); const sessionListExpanded = expandedSessionLists.has(key)
        const projectSessions = needle && !projectMatches ? matchingSessions : sessionListExpanded ? matchingSessions : matchingSessions.slice(0, 5)
        const runningCount = allProjectSessions.filter((session) => session.status === 'running').length
        const projectOnlySelected = selectedProjectKey === key && !selectedId && !selectedSessionKey && !selectedAgentKey && !selectedDraftId
        const createProjectDraft = async () => { if (!open) toggle(key); onSelectDraft(await api.createDraft({ hostId: project.hostId, projectId: project.id })) }
        return <div className={`project-group host-${host?.status || 'offline'}`} key={key} role="treeitem" aria-expanded={open}>
          <div className={`project-row ${projectOnlySelected ? 'selected' : ''}`}><button className="project-chevron" aria-label={`${open ? 'Collapse' : 'Expand'} ${project.name}`} onClick={() => toggle(key)}>{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button><button className="project-main" onClick={() => onSelectProject(project)}><FolderGit2 size={15} /><strong>{project.name}</strong></button>{runningCount > 0 && <span className="project-running-count"><Radio size={10} />{runningCount}</span>}<span className="project-host-tag">{host?.name || project.hostId}</span><i className={host?.status} title={host?.status || 'offline'} /><button className="project-new-chat" title={`Start new chat in ${project.name}`} onClick={() => void createProjectDraft()}><Plus size={14} /></button></div>
          {open && <div className="project-sessions" role="group">
            {projectDrafts.map((draft) => <button key={draft.id} className={`project-session draft ${draft.id === selectedDraftId ? 'selected' : ''}`} onClick={() => onSelectDraft(draft)}><span className="recent-status"><Circle size={7} /></span><span>New chat</span></button>)}
            {projectSessions.map((session) => { const sessionId = sessionKey(session); const pinned = pinnedKeys.includes(sessionId); return <div className="project-session-row" key={sessionId}><button data-session-key={sessionId} className={`project-session ${session.status} ${sessionId === selectedSessionKey ? 'selected' : ''}`} onClick={() => onSelectSession(session)} onContextMenu={(event) => { event.preventDefault(); void onTogglePin(session) }}><span className="recent-status">{session.status === 'running' ? <Radio size={11} /> : session.status === 'stopped' ? <Circle className="stopped-dot" size={7} fill="currentColor" /> : null}</span><span>{session.title}</span>{session.status === 'running' ? <small className="running-label">Running</small> : <small>{relative(session.updatedAt)}</small>}</button><button className={`session-pin ${pinned ? 'pinned' : ''}`} title={pinned ? 'Unpin conversation' : 'Pin conversation'} onClick={() => void onTogglePin(session)}>{pinned ? <PinOff size={12} /> : <Pin size={12} />}</button></div> })}
            {!needle && !sessionListExpanded && allProjectSessions.length > 5 && <button className="project-show-more" onClick={() => void expandSessions(project)}>Show more</button>}
            {projectRuns.map((run) => <button key={`${run.hostId}:${run.id}`} className={`project-session ${run.id === selectedId ? 'selected' : ''}`} onClick={() => onSelectRun(run)}><span className="recent-status">{active.has(run.status) ? <Radio size={11} /> : <Circle size={7} fill="currentColor" />}</span><span>{run.title}</span><small>{relative(run.createdAt)}</small></button>)}
            {projectAgents.map(({ hostId, agent }) => <button key={`${hostId}:${agent.id}`} className={`project-session observed ${`${hostId}:${agent.id}` === selectedAgentKey ? 'selected' : ''}`} onClick={() => onSelectAgent(hostId, agent, project)}><span className="recent-status"><Radio size={11} /></span><span>{providerName(agent.provider)}</span><small>observed</small></button>)}
            {!projectDrafts.length && !projectSessions.length && !projectRuns.length && !projectAgents.length && <div className="project-empty">No chats</div>}
          </div>}
        </div>
      })}{needle && visibleProjectCount === 0 && <div className="navigation-empty">No matching projects or conversations</div>}</div></section>
    </div>
    <div className="side-bottom"><button onClick={onSettings}><Settings2 size={17} /><span>Gateway / Settings</span></button><button><Archive size={17} /><span>Archived chats</span></button></div>
  </aside>
}

function ComposerFrame({ className, onSubmit, children }: { className: string; onSubmit: (event: FormEvent) => void; children: React.ReactNode }) { return <form className={className} onSubmit={onSubmit}>{children}</form> }
function ComposerInput(props: React.ComponentProps<'textarea'>) { return <textarea {...props} /> }
function ComposerFooter({ className, children }: { className?: string; children: React.ReactNode }) { return <div className={className}>{children}</div> }

function StartScreen({ state, draft, project, host, onProject, onStarted }: { state: AppState; draft?: DraftSession; project?: Project; host?: Host; onProject: () => void; onStarted: (run: Run) => void }) {
  const [prompt, setPrompt] = useState(draft?.prompt || ''); const [provider, setProvider] = useState(draft?.provider || 'codex'); const [workspace, setWorkspace] = useState<'current_checkout' | 'managed_worktree'>(draft?.workspaceMode || 'current_checkout'); const [busy, setBusy] = useState(false); const [gitContext, setGitContext] = useState<GitContext | null>(null)
  const providers = project ? state.providersByHost[project.hostId] || [] : []
  useEffect(() => { if (draft) return; const first = providers.find((item) => item.available); if (first) setProvider(first.id) }, [project?.id, draft?.id])
  useEffect(() => { if (!draft) return; const timer = window.setTimeout(() => { void api.updateDraft(draft.id, { prompt, provider, workspaceMode: workspace }) }, 250); return () => clearTimeout(timer) }, [draft?.id, prompt, provider, workspace])
  useEffect(() => { let cancelled = false; setGitContext(null); if (project && host?.status === 'online') api.projectContext(project.hostId, project.id).then((value) => { if (!cancelled) setGitContext(value) }).catch(() => {}); return () => { cancelled = true } }, [project?.hostId, project?.id, host?.status])
  const submit = async (event: FormEvent) => { event.preventDefault(); if (!project || !prompt.trim()) return; setBusy(true); try { const input = { hostId: project.hostId, project_id: project.id, provider, prompt, workspace_mode: workspace, base_ref: 'HEAD' }; onStarted(draft ? await api.startDraft(draft.id, input) : await api.createRun(input)) } finally { setBusy(false) } }
  return <div className="start-screen">
    <div className="start-center"><div className="agent-cloud"><Command size={28} /></div><h1>{project ? `What should we work on in ${project.name}?` : 'Add a project to get started'}</h1>{project && <div className="starter-cards"><button onClick={() => setPrompt('Explore and explain this codebase')}><Search size={17} /><span>Explore and<br />understand code</span></button><button onClick={() => setPrompt('Build a new feature for this project')}><Zap size={17} /><span>Build a new feature,<br />app, or tool</span></button><button onClick={() => setPrompt('Review the code and suggest improvements')}><RefreshCw size={17} /><span>Review code and<br />suggest changes</span></button><button onClick={() => setPrompt('Find and fix issues and failures')}><ShieldAlert size={17} /><span>Fix issues and failures</span></button></div>}</div>
    {project ? <ComposerFrame className="codex-composer" onSubmit={submit}><div className="composer-context"><button type="button"><FolderGit2 size={15} />{project.name}</button><button type="button">{host?.type === 'ssh' ? <Globe2 size={15} /> : <Laptop size={15} />}{host?.type === 'ssh' ? 'Remote' : 'Local'}</button><button type="button" title={gitContext?.detached ? 'Detached HEAD' : gitContext?.dirty ? 'Working tree has changes' : gitContext?.available ? 'Current Git branch' : 'This folder is not a Git repository'}><GitBranch size={15} />{gitContext ? gitContext.available ? gitContext.branch : 'No Git repository' : host?.status === 'online' ? 'Loading branch' : 'Unavailable'}{gitContext?.dirty ? ' *' : ''}</button><span /><strong>{host?.name}<i className={host?.status} /></strong></div><ComposerInput value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Do anything" /><ComposerFooter className="composer-footer"><button type="button" className="plus"><Plus size={18} /></button><button type="button" className={`access ${workspace === 'managed_worktree' ? 'worktree' : ''}`} onClick={() => setWorkspace((value) => value === 'current_checkout' ? 'managed_worktree' : 'current_checkout')}>{workspace === 'managed_worktree' ? <TreePine size={15} /> : <ShieldAlert size={15} />}{workspace === 'managed_worktree' ? 'New worktree' : 'Current checkout'}</button><span /><select value={provider} onChange={(event) => setProvider(event.target.value as Provider['id'])}>{providers.filter((item) => item.available).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><button className="send" disabled={busy || !prompt.trim()}>{busy ? <RefreshCw className="spin" size={17} /> : <Send size={17} />}</button></ComposerFooter></ComposerFrame> : <button className="add-project-cta" onClick={onProject}><Plus size={17} />Add project</button>}
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
function MarkdownContent({ text, className = '' }: { text: string; className?: string }) { return <div className={`markdown-content ${className}`}><ReactMarkdown remarkPlugins={markdownPlugins}>{text}</ReactMarkdown></div> }
function ConversationMessage({ role, text, className = '', children }: { role: 'user' | 'assistant'; text: string; className?: string; children?: React.ReactNode }) {
  const content = conversationText(text)
  if (!content.text && content.hadContext) return <div className="context-note"><Info size={13} />Environment context attached</div>
  if (role === 'user') return <div className={`user-message ${className}`}><MarkdownContent text={content.text} />{children}</div>
  return <MarkdownContent text={content.text} className={`assistant-message ${className}`} />
}
function ToolActivityGroup({ events }: { events: RunEvent[] }) {
  const commandCount = events.filter((event) => String((event.raw_payload as { method?: string })?.method || '').includes('commandExecution')).length
  const fileCount = events.filter((event) => event.kind === 'file.change' || String((event.raw_payload as { method?: string })?.method || '').includes('fileChange')).length
  const failed = events.some((event) => event.channel === 'stderr' || event.kind === 'run.error')
  const label = commandCount || fileCount ? `${commandCount ? `${commandCount} command${commandCount === 1 ? '' : 's'}` : ''}${commandCount && fileCount ? ' · ' : ''}${fileCount ? `${fileCount} file change${fileCount === 1 ? '' : 's'}` : ''}` : `${events.length} activity item${events.length === 1 ? '' : 's'}`
  return <details className="tool-activity-group" open={failed || undefined}><summary><Terminal size={13} /><span>{failed ? 'Activity failed' : 'Activity'}</span><small>{label}</small><ChevronRight size={13} /></summary><div>{events.map((event) => <OperationalEvent event={event} key={event.event_id} />)}</div></details>
}
function OperationalEvent({ event }: { event: RunEvent }) {
  const raw = event.raw_payload as { method?: string; params?: { command?: string; item?: { type?: string; command?: string; changes?: Array<{ path?: string; kind?: string; diff?: string }> } } }
  const text = String(event.payload.text || ''); const method = raw?.method || ''; const item = raw?.params?.item
  if (event.kind === 'reasoning.message') return <div className="reasoning-summary"><Bot size={13} /><MarkdownContent text={text} /></div>
  if (event.kind === 'file.change' || method.includes('fileChange') || item?.type === 'fileChange') {
    return <div className="file-change-card"><header><FileDiff size={14} /><strong>File changes</strong></header>{item?.changes?.map((change, index) => <div key={`${change.path || 'file'}:${index}`}><span>{change.kind || 'updated'}</span><code>{change.path || 'Unknown file'}</code></div>)}{text && <pre>{text}</pre>}</div>
  }
  const command = raw?.params?.command || item?.command || (method.includes('commandExecution') ? text : '')
  if (command) return <div className={`command-row ${event.channel === 'stderr' ? 'failed' : ''}`}><header><Terminal size={13} /><code>{command}</code>{event.channel === 'stderr' ? <ShieldAlert size={13} /> : <CheckCircle2 size={13} />}</header>{text && text !== command && <pre>{text}</pre>}</div>
  return <div className={`tool-output ${event.channel === 'stderr' ? 'failed' : ''}`}><code>{event.kind.replaceAll('.', ' ')}</code>{text && <pre>{text}</pre>}</div>
}

function EnvironmentPopover({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) { return <aside className="environment-popover"><header><span>{title}</span><button title="Close environment inspector" onClick={onClose}><X size={14} /></button></header>{children}</aside> }
function EnvironmentRow({ icon, label, value }: { icon: React.ReactNode; label: string; value?: React.ReactNode }) { return <div className="environment-row">{icon}<span>{label}</span><strong>{value || 'Unknown'}</strong></div> }

function RunScreen({ run, events, project, host, provider }: { run: Run; events: RunEvent[]; project?: Project; host?: Host; provider?: Provider }) {
  const [message, setMessage] = useState(''); const [rewind, setRewind] = useState<{ turnId: string; lastTurnId: string | null; text: string } | null>(null); const [showEnvironment, setShowEnvironment] = useState(false); const [workspaceLabel, setWorkspaceLabel] = useState(run.worktreeId ? 'Managed worktree' : 'Current checkout'); const scroll = useRef<HTMLDivElement>(null); const lastEscape = useRef(0)
  useEffect(() => { scroll.current?.scrollTo({ top: scroll.current.scrollHeight }) }, [events.length])
  useEffect(() => { let cancelled = false; if (run.worktreeId) api.worktreeStatus(run.hostId, run.worktreeId).then((status) => { if (!cancelled) setWorkspaceLabel(status.worktree.branch || 'Managed worktree') }).catch(() => {}); else if (project && host?.status === 'online') api.projectContext(project.hostId, project.id).then((context) => { if (!cancelled) setWorkspaceLabel(context.branch || 'Current checkout') }).catch(() => {}); return () => { cancelled = true } }, [run.hostId, run.worktreeId, project?.id, host?.status])
  const turnRunning = run.status === 'running'
  const canUseAttachedSession = Boolean(provider?.live_input && active.has(run.status))
  const send = async (event: FormEvent) => { event.preventDefault(); if (!message.trim()) return; if (rewind && canUseAttachedSession) await api.input(run.hostId, run.id, message.trim(), 'fork', rewind.lastTurnId); else if (canUseAttachedSession) await api.input(run.hostId, run.id, message.trim()); else if (run.sessionId && provider?.resume) await api.resumeRun(run, message.trim()); else return; setMessage(''); setRewind(null) }
  const queue = async () => { if (!message.trim()) return; await api.input(run.hostId, run.id, message.trim(), 'queue'); setMessage('') }
  const branchEvents = currentBranchEvents(events)
  const hasUserEvents = branchEvents.some((event) => event.kind === 'user.message')
  const displayEvents = coalesceStreamEvents(branchEvents)
  const displayItems = timelineItems(displayEvents)
  const durations = turnDurations(displayEvents)
  const queued = pendingQueue(branchEvents)
  const backtrackable = branchEvents.filter((event, index, all) => event.kind === 'user.message' && typeof event.payload.turn_id === 'string' && typeof event.payload.text === 'string' && all.findIndex((candidate) => candidate.kind === 'user.message' && candidate.payload.turn_id === event.payload.turn_id) === index)
  const backtrackableEventIds = new Set(backtrackable.map((event) => event.event_id))
  const resolvedRequests = new Set(branchEvents.filter((event) => event.provider_event_type === 'codex.serverRequest/resolved' && event.payload.request_id !== undefined).map((event) => String(event.payload.request_id)))
  const selectRewind = (turnId: string, text: string) => { const index = backtrackable.findIndex((event) => event.payload.turn_id === turnId); if (index < 0) return; setRewind({ turnId, lastTurnId: index > 0 ? String(backtrackable[index - 1].payload.turn_id) : null, text }); setMessage(text) }
  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
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
  return <div className={`thread-screen ${showEnvironment ? 'environment-open' : ''}`}>
    <header className="thread-header"><FolderGit2 size={16} /><strong>{run.title}</strong><button title="Thread actions"><MoreHorizontal size={18} /></button><span /><button className="open-in">Open in <ChevronDown size={14} /></button><button className={`environment-toggle ${showEnvironment ? 'active' : ''}`} onClick={() => setShowEnvironment((value) => !value)}><Info size={15} />Environment</button></header>
    <div className="thread-scroll" ref={scroll}><div className="thread-column">{!hasUserEvents && <ConversationMessage role="user" text={run.prompt} />}{displayItems.map((item) => isActivityGroup(item) ? <ToolActivityGroup events={item.events} key={item.id} /> : <ThreadEvent key={item.event_id} event={item} run={run} durationMs={durations.get(item.event_id)} resolved={item.payload.rpc_id !== undefined && resolvedRequests.has(String(item.payload.rpc_id))} canRewind={run.status === 'waiting_for_input' && queued.length === 0 && backtrackableEventIds.has(item.event_id)} onRewind={selectRewind} />)}</div></div>
    {showEnvironment && <EnvironmentPopover title="Environment" onClose={() => setShowEnvironment(false)}><EnvironmentRow icon={<Terminal size={16} />} label="Provider" value={provider?.name || run.provider} /><EnvironmentRow icon={host?.type === 'ssh' ? <Globe2 size={16} /> : <Laptop size={16} />} label="Location" value={host?.name} /><EnvironmentRow icon={<FolderGit2 size={16} />} label="Project" value={project?.name} /><EnvironmentRow icon={<GitBranch size={16} />} label="Workspace" value={workspaceLabel} /><EnvironmentRow icon={<Folder size={16} />} label="Path" value={run.cwd} /><div className="environment-actions"><button onClick={() => api.openPath(run.hostId, run.cwd)}>Open folder</button>{run.worktreeId && !active.has(run.status) && <><button onClick={async () => { const status = await api.worktreeStatus(run.hostId, run.worktreeId!); alert(`${status.summary}\n\n${status.diff_stat}`) }}>Inspect changes</button><button className="danger" onClick={async () => { const status = await api.worktreeStatus(run.hostId, run.worktreeId!); if (confirm(status.dirty ? 'This worktree has uncommitted changes. Force remove it?' : 'Remove this managed worktree?')) await api.removeWorktree(run.hostId, run.worktreeId!, status.dirty) }}>Remove worktree</button></>}</div>{host?.status !== 'online' && <p><WifiOff size={13} />Viewer reconnecting; run remains on host.</p>}</EnvironmentPopover>}
    <ComposerFrame className={`thread-composer ${rewind ? 'rewinding' : ''}`} onSubmit={send}>{queued.length > 0 && <div className="queue-panel"><header><ListPlus size={13} /><strong>{queued.length} queued</strong>{run.status === 'waiting_for_input' && <button type="button" onClick={() => api.startQueued(run.hostId, run.id)}>Run next</button>}</header>{queued.map((item) => <div key={item.id}><span title={item.error || item.message}>{item.message}{item.error ? ' · failed to start' : ''}</span><button type="button" title="Remove queued prompt" onClick={() => api.removeQueued(run.hostId, run.id, item.id)}><X size={12} /></button></div>)}</div>}{rewind && <div className="rewind-banner"><Pencil size={13} />Editing previous message · sending creates a branch<button type="button" title="Cancel editing previous message" onClick={() => { setRewind(null); setMessage('') }}><X size={13} /></button></div>}<ComposerInput disabled={active.has(run.status) ? !provider?.live_input : !(run.sessionId && provider?.resume)} value={message} onChange={(event) => setMessage(event.target.value)} onKeyDown={handleComposerKeyDown} placeholder={active.has(run.status) ? (run.status === 'waiting_for_input' ? queued.length ? 'Run or remove queued prompts before editing history' : 'Continue this Codex thread · edit a message above or press Esc Esc' : provider?.live_input ? 'Steer this turn' : 'Live steering is not available for this provider') : (run.sessionId && provider?.resume ? 'Continue this session' : 'This provider session cannot be resumed')} /><ComposerFooter><button type="button"><Plus size={18} /></button>{turnRunning && <button type="button" className="interrupt" onClick={() => api.controlRun(run.hostId, run.id, 'interrupt')}><Square size={14} />Interrupt</button>}{run.provider === 'codex' && turnRunning && <button type="button" className="queue" disabled={!message.trim()} onClick={queue}><ListPlus size={14} />Queue</button>}{run.provider === 'codex' && run.status === 'waiting_for_input' && <button type="button" className="interrupt" onClick={() => confirm('Close this attached Codex app-server session?') && api.controlRun(run.hostId, run.id, 'terminate')}><Square size={14} />Close</button>}{run.status === 'interrupting' && <><button type="button" className="interrupt" onClick={() => api.controlRun(run.hostId, run.id, 'terminate')}>Terminate</button><button type="button" className="interrupt" onClick={() => confirm('Force kill the full process group?') && api.controlRun(run.hostId, run.id, 'kill')}>Kill</button></>}<span /><small>{run.model || provider?.name}</small>{!active.has(run.status) && run.sessionId && provider?.fork && <button type="button" onClick={() => message.trim() && api.resumeRun(run, message.trim(), true)}>Fork</button>}<button className="send" disabled={!message.trim() || (active.has(run.status) ? !provider?.live_input : !(run.sessionId && provider?.resume))}>{rewind ? <GitBranch size={16} /> : <Send size={17} />}</button></ComposerFooter></ComposerFrame>
  </div>
}

function SessionScreen({ session, messages, project, host }: { session: ProviderSession; messages: SessionMessage[]; project?: Project; host?: Host }) {
  const scroll = useRef<HTMLDivElement>(null); const [showEnvironment, setShowEnvironment] = useState(false)
  useEffect(() => { scroll.current?.scrollTo({ top: scroll.current.scrollHeight }) }, [messages.length])
  return <div className={`thread-screen provider-thread ${showEnvironment ? 'environment-open' : ''}`}>
    <header className="thread-header">{providerIcon(session.provider)}<strong>{session.title}</strong>{session.status === 'running' && <span className="observed-badge"><Radio size={11} />Running</span>}<span /><button title="Thread actions"><MoreHorizontal size={18} /></button><button className={`environment-toggle ${showEnvironment ? 'active' : ''}`} onClick={() => setShowEnvironment((value) => !value)}><Info size={15} />Environment</button></header>
    <div className="thread-scroll history-scroll" ref={scroll}><div className="thread-column">{messages.length ? messages.map((message) => <ConversationMessage role={message.role} text={message.text} key={message.id} />) : host?.status !== 'online' ? <div className="thread-empty-state"><WifiOff size={20} /><strong>{host?.name || 'This host'} is offline</strong><p>The project and conversation remain in navigation. Messages will load when the host reconnects.</p></div> : <div className="thread-status"><RefreshCw className="spin" size={13} />Loading conversation</div>}</div></div>
    {showEnvironment && <EnvironmentPopover title="Environment" onClose={() => setShowEnvironment(false)}><EnvironmentRow icon={providerIcon(session.provider)} label="Provider" value={providerName(session.provider)} /><EnvironmentRow icon={host?.type === 'ssh' ? <Globe2 size={16} /> : <Laptop size={16} />} label="Location" value={host?.name} /><EnvironmentRow icon={<FolderGit2 size={16} />} label="Project" value={project?.name} />{session.pid && <EnvironmentRow icon={<Terminal size={16} />} label="Process" value={`PID ${session.pid}`} />}</EnvironmentPopover>}
    <div className="history-notice"><Info size={14} /><span><strong>{session.status === 'running' ? 'Read-only live session' : 'Historical provider session'}</strong>{session.status === 'running' ? 'Safe attachment is not available for this externally managed process.' : 'Resume or fork is unavailable until the provider exposes a safe continuation path.'}</span></div>
  </div>
}

function ObservedScreen({ host, project, agent }: { host?: Host; project?: Project; agent: DiscoveredAgent }) {
  return <div className="thread-screen observed-screen">
    <header className="thread-header">{providerIcon(agent.provider)}<strong>{providerName(agent.provider)} session</strong><span className="observed-badge"><Radio size={11} />Observed</span><span /><button><MoreHorizontal size={18} /></button></header>
    <div className="observed-content"><div className="observed-hero">{providerIcon(agent.provider)}<h1>{providerName(agent.provider)} is running</h1><p>Codesk found this session on {host?.name || 'the execution host'}. It was started outside Codesk, so it remains read-only.</p></div><div className="observed-details"><div><span>Project</span><strong>{project?.name || 'Unregistered folder'}</strong></div><div><span>Working directory</span><code>{agent.cwd || 'Unknown'}</code></div><div><span>Process</span><strong>PID {agent.pid}</strong></div><div><span>Command</span><code>{agent.command}</code></div></div><div className="observed-note"><ShieldAlert size={17} /><span><strong>No terminal attachment</strong>Existing output and stdin are unavailable unless the session was launched through Codesk or the provider exposes a safe attach protocol.</span></div></div>
  </div>
}

function ThreadEvent({ event, run, durationMs, resolved, canRewind, onRewind }: { event: RunEvent; run: Run; durationMs?: number; resolved: boolean; canRewind: boolean; onRewind: (turnId: string, text: string) => void }) {
  const text = String(event.payload.text || '')
  const rpcId = event.payload.rpc_id
  const raw = event.raw_payload as { method?: string; params?: { permissions?: unknown; questions?: Array<{ id: string; question?: string; header?: string }> } }
  if (event.kind.startsWith('queue.')) return null
  if (event.kind === 'approval.required' && rpcId !== undefined && rpcId !== null && raw?.method === 'item/permissions/requestApproval') return <div className={`request-card ${resolved ? 'resolved' : ''}`}><strong>{resolved ? 'Permission request resolved' : 'Additional permissions required'}</strong><p>{text}</p>{!resolved && <div><button onClick={() => api.providerResponse(run.hostId, run.id, rpcId, { permissions: raw.params?.permissions || {}, scope: 'turn' })}>Grant for turn</button><button onClick={() => api.providerResponse(run.hostId, run.id, rpcId, { permissions: raw.params?.permissions || {}, scope: 'session' })}>Grant for session</button><button className="decline" onClick={() => api.providerResponse(run.hostId, run.id, rpcId, { permissions: {} })}>Decline</button></div>}</div>
  if (event.kind === 'approval.required' && rpcId !== undefined && rpcId !== null) return <div className={`request-card ${resolved ? 'resolved' : ''}`}><strong>{resolved ? 'Approval resolved' : 'Approval required'}</strong><p>{text}</p>{!resolved && <div><button onClick={() => api.providerResponse(run.hostId, run.id, rpcId, { decision: 'accept' })}>Approve</button><button onClick={() => api.providerResponse(run.hostId, run.id, rpcId, { decision: 'acceptForSession' })}>Approve for session</button><button className="decline" onClick={() => api.providerResponse(run.hostId, run.id, rpcId, { decision: 'decline' })}>Decline</button></div>}</div>
  if (event.kind === 'input.required' && rpcId !== undefined && rpcId !== null) return <div className={`request-card ${resolved ? 'resolved' : ''}`}><strong>{resolved ? 'Input submitted' : 'Codex needs input'}</strong><p>{text}</p>{!resolved && <div><button onClick={() => { const raw = event.raw_payload as { params?: { questions?: Array<{ id: string; question?: string; header?: string }> } }; const answers: Record<string, { answers: string[] }> = {}; for (const question of raw?.params?.questions || []) { const answer = prompt(question.question || question.header || 'Answer Codex'); if (answer === null) return; answers[question.id] = { answers: [answer] } } void api.providerResponse(run.hostId, run.id, rpcId, { answers }) }}>Answer</button></div>}</div>
  if (event.kind === 'user.message') return <ConversationMessage role="user" text={text} className="rewindable">{canRewind && typeof event.payload.turn_id === 'string' && <button title="Edit this message and branch from here" onClick={() => onRewind(event.payload.turn_id as string, conversationText(text).text)}><Pencil size={12} />Edit from here</button>}</ConversationMessage>
  if (event.kind === 'turn.started') return null
  if (event.kind === 'turn.completed') return <div className="turn-boundary"><span />{durationMs !== undefined ? `Worked for ${durationLabel(durationMs)}` : 'Turn completed'}<span /></div>
  if (!text && !event.kind.startsWith('run.') && !event.kind.startsWith('control.') && !event.kind.startsWith('turn.') && !event.kind.startsWith('input.')) return null
  if (event.kind === 'assistant.message') return <ConversationMessage role="assistant" text={text} />
  if (event.kind === 'output' || event.kind.includes('message') || event.kind === 'tool.output') return <OperationalEvent event={event} />
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
    {error && <p className="dialog-error">{error}</p>}<p className="folder-note">Codesk registers the selected folder and Git repositories up to two levels below it. Existing agent processes are only observed and never modified.</p>
    <footer><button type="button" onClick={onClose}>Cancel</button><button type="button" className="dialog-primary" disabled={!selectedPath || !!busy} onClick={async () => { setBusy('add'); setError(''); try { await api.discoverProjects(hostId, selectedPath, true, 2); onCreated() } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setBusy('') } }}>{busy === 'add' ? <><RefreshCw className="spin" size={14} />Adding…</> : 'Add folder'}</button></footer>
  </div></Dialog>
}
function ConnectionsDialog({ hosts, onClose, onChanged }: { hosts: Host[]; onClose: () => void; onChanged: () => void }) {
  const [name, setName] = useState(''); const [alias, setAlias] = useState(''); const [aliases, setAliases] = useState<string[]>([]); const [agents, setAgents] = useState<Record<string, DiscoveredAgent[]>>({}); const [busy, setBusy] = useState(''); const [error, setError] = useState('')
  useEffect(() => { api.sshAliases().then(setAliases).catch(() => {}) }, [])
  const inspectAgents = async (host: Host) => { setBusy(`agents:${host.id}`); setError(''); try { const found = await api.discoveredAgents(host.id); setAgents((current) => ({ ...current, [host.id]: found })) } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy('') } }
  return <Dialog title="Connections" subtitle="Local and SSH execution hosts" onClose={onClose}><div className="connection-list">{hosts.map((host) => <div className="connection-host" key={host.id}><div className="connection-row"><i className={host.status} /><span><strong>{host.name}</strong><small>{host.type === 'local' ? 'Local daemon' : host.sshAlias}{host.error ? ` · ${host.error}` : ''}</small></span><button title="Discover running agents" disabled={host.status !== 'online'} onClick={() => void inspectAgents(host)}><Radio size={15} /></button>{host.type === 'ssh' && <button title="Install or reconnect" onClick={async () => { setBusy(`host:${host.id}`); setError(''); try { await api.bootstrapHost(host.id); await onChanged() } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy('') } }}>{busy === `host:${host.id}` ? <RefreshCw className="spin" size={15} /> : <RefreshCw size={15} />}</button>}</div>{agents[host.id]?.map((agent) => <div className="discovered-agent" key={agent.id}>{providerIcon(agent.provider)}<span><strong>{agent.provider} · PID {agent.pid}</strong><small>{agent.cwd || agent.command}</small></span>{agent.managed_run_id ? <em>Managed</em> : <button onClick={() => api.controlDiscoveredAgent(host.id, agent.pid, 'interrupt')}><Square size={12} />Interrupt</button>}</div>)}</div>)}</div>{error && <p className="dialog-error">{error}</p>}<form className="connection-add" onSubmit={async (event) => { event.preventDefault(); setError(''); try { const host = await api.createHost({ name: name || alias, sshAlias: alias }); setName(''); setAlias(''); await onChanged(); try { await api.bootstrapHost(host.id); await onChanged() } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } }}><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Display name" /><input list="ssh-aliases" value={alias} onChange={(event) => setAlias(event.target.value)} placeholder="SSH alias" /><datalist id="ssh-aliases">{aliases.map((value) => <option key={value} value={value} />)}</datalist><button><Plus size={16} />Connect</button></form></Dialog>
}
