import { FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import {
  Archive, Bell, Bot, ChevronDown, ChevronRight, Circle, Clock3, Command, Cpu, FolderGit2,
  GitBranch, Globe2, Laptop, MoreHorizontal, Plug, Plus, Radio, RefreshCw,
  Search, Send, Server, Settings2, ShieldAlert, Square, Terminal, TreePine,
  WifiOff, X, Zap,
} from 'lucide-react'
import { api, gatewayOrigin } from './api'
import type { AppState, DiscoveredAgent, DraftSession, FileEntry, Host, Project, Provider, ProviderSession, Run, RunEvent, SessionMessage } from './types'

const empty: AppState = { hosts: [], projects: [], runs: [], sessions: [], drafts: [], providersByHost: {}, discoveredAgentsByHost: {}, settings: { notifications: true } }
const active = new Set(['queued', 'starting', 'running', 'waiting_for_input', 'interrupting'])

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
const runningFirst = (left: ProviderSession, right: ProviderSession) => Number(right.status === 'running') - Number(left.status === 'running') || right.updatedAt.localeCompare(left.updatedAt)

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
  const [newProject, setNewProject] = useState(false)
  const [settings, setSettings] = useState(false)
  const [error, setError] = useState('')
  const initialized = useRef(false)
  const notified = useRef<Set<string>>(new Set(JSON.parse(localStorage.getItem('codesk.notifications') || '[]')))
  const reload = async () => { try { const next = await api.state(); next.drafts ||= []; setState(next); setError(''); if (!initialized.current) { const firstDraft = next.drafts[0]; const firstSession = next.sessions[0]; const firstRun = next.runs[0]; if (firstDraft) setSelectedDraftId(firstDraft.id); else if (firstSession) setSelectedSessionKey(`${firstSession.hostId}:${firstSession.id}`); else setSelectedId(firstRun?.id || null); const firstProject = firstDraft ? next.projects.find((item) => item.id === firstDraft.projectId && item.hostId === firstDraft.hostId) : firstSession ? next.projects.find((item) => item.id === firstSession.projectId && item.hostId === firstSession.hostId) : firstRun ? next.projects.find((item) => item.id === firstRun.projectId && item.hostId === firstRun.hostId) : next.projects[0]; setSelectedProjectKey(firstProject ? projectKey(firstProject) : null); initialized.current = true } else { setSelectedId((id) => id && next.runs.some((item) => item.id === id) ? id : null); setSelectedSessionKey((key) => key && next.sessions.some((item) => `${item.hostId}:${item.id}` === key) ? key : null); setSelectedDraftId((id) => id && next.drafts.some((item) => item.id === id) ? id : null) } } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } }
  useEffect(() => { let cancelled = false; let timer = 0; const poll = async () => { if (cancelled) return; await reload(); timer = window.setTimeout(poll, state.hosts.length ? 5000 : 650) }; void poll(); return () => { cancelled = true; clearTimeout(timer) } }, [])
  const run = state.runs.find((item) => item.id === selectedId) || null
  const session = state.sessions.find((item) => `${item.hostId}:${item.id}` === selectedSessionKey) || null
  const draft = state.drafts.find((item) => item.id === selectedDraftId) || null
  useEffect(() => { if (!run || events[run.id]) return; api.events(run.hostId, run.id).then((items) => setEvents((current) => ({ ...current, [run.id]: items }))).catch(() => {}) }, [run?.id])
  useEffect(() => {
    if (!session || !selectedSessionKey) return
    let stopped = false
    const load = () => api.sessionMessages(session.hostId, session.projectId, session.provider, session.nativeSessionId).then((items) => { if (!stopped) setSessionMessages((current) => ({ ...current, [selectedSessionKey]: items })) }).catch((cause) => { if (!stopped) setError(cause instanceof Error ? cause.message : String(cause)) })
    if (!sessionMessages[selectedSessionKey] || session.status === 'running') void load()
    const timer = session.status === 'running' ? window.setInterval(load, 2500) : 0
    return () => { stopped = true; if (timer) clearInterval(timer) }
  }, [selectedSessionKey, session?.status])
  useEffect(() => {
    const origin = gatewayOrigin ? gatewayOrigin.replace('http://', 'ws://').replace('https://', 'wss://') : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`
    let ws: WebSocket | null = null; let stopped = false; let retry = 500
    const connect = () => { if (stopped) return; ws = new WebSocket(`${origin}/ws`); ws.onopen = () => { retry = 500 }; ws.onmessage = (message) => { const envelope = JSON.parse(message.data); if (envelope.type === 'daemon.event') { const event = envelope.payload.event as RunEvent; setEvents((current) => { const prior = current[event.run_id] || []; return prior.some((item) => item.event_id === event.event_id) ? current : { ...current, [event.run_id]: [...prior, event].sort((a, b) => a.run_sequence - b.run_sequence) } }); if (event.kind.startsWith('run.') || event.kind.startsWith('control.')) void reload(); if (['run.completed','run.failed','run.interrupted','run.killed','run.orphaned','input.required','approval.required'].includes(event.kind) && !notified.current.has(event.event_id)) { notified.current.add(event.event_id); localStorage.setItem('codesk.notifications', JSON.stringify([...notified.current].slice(-500))); void notify(`Codesk · ${event.kind.replaceAll('.', ' ')}`, String(event.payload.text || 'Agent run updated'), event.event_id) } } else if (envelope.type.startsWith('host.') || envelope.type.startsWith('draft.')) void reload() }; ws.onclose = () => { if (!stopped) { window.setTimeout(connect, retry); retry = Math.min(10000, retry * 1.8) } }; ws.onerror = () => ws?.close() }
    connect(); return () => { stopped = true; ws?.close() }
  }, [])
  useEffect(() => {
    if (!state.settings.notifications) return
    void prepareNotifications()
  }, [state.settings.notifications])
  const visibleRuns = useMemo(() => state.runs.filter((item) => `${item.title} ${item.prompt}`.toLowerCase().includes(query.toLowerCase())), [state.runs, query])
  const visibleSessions = useMemo(() => state.sessions.filter((item) => item.title.toLowerCase().includes(query.toLowerCase())), [state.sessions, query])
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
  return <div className="codex-shell">
    <Sidebar state={state} runs={visibleRuns} sessions={visibleSessions} agents={agents} selectedId={selectedId} selectedSessionKey={selectedSessionKey} selectedAgentKey={selectedAgentKey} selectedDraftId={selectedDraftId} selectedProjectKey={selectedProjectKey} query={query} onQuery={setQuery} onSelectRun={selectRun} onSelectSession={selectSession} onSelectDraft={selectDraft} onSelectAgent={selectAgent} onSelectProject={selectProject} onNewRun={() => void newDraft()} onNewProject={() => setNewProject(true)} onSettings={() => setSettings(true)} />
    <section className="codex-main">
      {session ? <SessionScreen session={session} messages={sessionMessages[selectedSessionKey!] || []} project={project} host={host} /> : run ? <RunScreen run={run} events={events[run.id] || []} project={project} host={host} provider={provider} /> : selectedAgent ? <ObservedScreen host={state.hosts.find((item) => item.id === selectedAgent.hostId)} project={selectedAgent.project} agent={selectedAgent.agent} /> : <StartScreen key={draft?.id || (project ? projectKey(project) : 'empty')} state={state} draft={draft || undefined} project={project} host={host} onProject={() => setNewProject(true)} onStarted={(next) => { selectRun(next); void reload() }} />}
    </section>
    {error && <div className="toast-error">{error}<button onClick={() => setError('')}><X size={14} /></button></div>}
    {newProject && <ProjectDialog hosts={state.hosts} onClose={() => setNewProject(false)} onCreated={async () => { setNewProject(false); await reload() }} />}
    {settings && <ConnectionsDialog hosts={state.hosts} onClose={() => setSettings(false)} onChanged={reload} />}
  </div>
}

function Sidebar({ state, runs, sessions, agents, selectedId, selectedSessionKey, selectedAgentKey, selectedDraftId, selectedProjectKey, query, onQuery, onSelectRun, onSelectSession, onSelectDraft, onSelectAgent, onSelectProject, onNewRun, onNewProject, onSettings }: { state: AppState; runs: Run[]; sessions: ProviderSession[]; agents: ReturnType<typeof observedAgents>; selectedId: string | null; selectedSessionKey: string | null; selectedAgentKey: string | null; selectedDraftId: string | null; selectedProjectKey: string | null; query: string; onQuery: (value: string) => void; onSelectRun: (run: Run) => void; onSelectSession: (session: ProviderSession) => void; onSelectDraft: (draft: DraftSession) => void; onSelectAgent: (hostId: string, agent: DiscoveredAgent, project?: Project) => void; onSelectProject: (project: Project) => void; onNewRun: () => void; onNewProject: () => void; onSettings: () => void }) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(JSON.parse(localStorage.getItem('codesk.expanded-projects') || '[]')))
  useEffect(() => { if (!selectedProjectKey) return; setExpanded((current) => current.has(selectedProjectKey) ? current : new Set([...current, selectedProjectKey])) }, [selectedProjectKey])
  const toggle = (key: string) => setExpanded((current) => { const next = new Set(current); next.has(key) ? next.delete(key) : next.add(key); localStorage.setItem('codesk.expanded-projects', JSON.stringify([...next])); return next })
  return <aside className="codex-sidebar">
    <div className="sidebar-top"><strong>Codesk</strong><ChevronDown size={14} /><span /><button><Search size={17} /></button><button><Bell size={17} /></button></div>
    <button className="side-action" onClick={onNewRun}><Plus size={17} />New chat</button>
    <button className="side-action"><GitBranch size={17} />Pull requests</button>
    <button className="side-action"><Clock3 size={17} />Scheduled</button>
    <button className="side-action"><Plug size={17} />Plugins</button>
    <div className="side-heading"><span>Projects</span><button onClick={onNewProject}><Plus size={15} /></button></div>
    <div className="side-projects">{state.projects.map((project) => {
      const key = projectKey(project); const host = state.hosts.find((item) => item.id === project.hostId)
      const projectDrafts = state.drafts.filter((draft) => draft.projectId === project.id && draft.hostId === project.hostId)
      const projectSessions = sessions.filter((session) => session.projectId === project.id && session.hostId === project.hostId).sort(runningFirst)
      const runningCount = projectSessions.filter((session) => session.status === 'running').length
      const projectRuns = runs.filter((run) => run.projectId === project.id && run.hostId === project.hostId && !projectSessions.some((session) => session.nativeSessionId === run.sessionId))
      const projectAgents = agents.filter((item) => item.project && projectKey(item.project) === key && !projectSessions.some((session) => session.provider === item.agent.provider && session.status === 'running'))
      const open = expanded.has(key)
      const createProjectDraft = async () => { if (!open) toggle(key); onSelectDraft(await api.createDraft({ hostId: project.hostId, projectId: project.id })) }
      return <div className={`project-group ${selectedProjectKey === key ? 'current' : ''}`} key={key}>
        <div className="project-row"><button className="project-main" onClick={() => { onSelectProject(project); toggle(key) }}><span className="project-chevron">{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span><FolderGit2 size={15} /><strong>{project.name}</strong></button>{runningCount > 0 && <span className="project-running-count"><Radio size={10} />{runningCount}</span>}<i className={host?.status} /><button className="project-new-chat" title={`Start new chat in ${project.name}`} onClick={() => void createProjectDraft()}><Plus size={14} /></button></div>
        {open && <div className="project-sessions">
          {projectDrafts.map((draft) => <button key={draft.id} className={`project-session draft ${draft.id === selectedDraftId ? 'selected' : ''}`} onClick={() => onSelectDraft(draft)}><span className="recent-status"><Circle size={7} /></span><span>New chat</span></button>)}
          {projectSessions.map((session) => <button key={`${session.hostId}:${session.id}`} className={`project-session ${session.status === 'running' ? 'running' : ''} ${`${session.hostId}:${session.id}` === selectedSessionKey ? 'selected' : ''}`} onClick={() => onSelectSession(session)}><span className="recent-status">{session.status === 'running' ? <Radio size={11} /> : providerIcon(session.provider)}</span><span>{session.title}</span>{session.status === 'running' ? <small className="running-label">Running</small> : <small>{relative(session.updatedAt)}</small>}</button>)}
          {projectRuns.map((run) => <button key={`${run.hostId}:${run.id}`} className={`project-session ${run.id === selectedId ? 'selected' : ''}`} onClick={() => onSelectRun(run)}><span className="recent-status">{active.has(run.status) ? <Radio size={11} /> : <Circle size={7} fill="currentColor" />}</span><span>{run.title}</span><small>{relative(run.createdAt)}</small></button>)}
          {projectAgents.map(({ hostId, agent }) => <button key={`${hostId}:${agent.id}`} className={`project-session observed ${`${hostId}:${agent.id}` === selectedAgentKey ? 'selected' : ''}`} onClick={() => onSelectAgent(hostId, agent, project)}><span className="recent-status"><Radio size={11} /></span><span>{providerName(agent.provider)}</span><small>observed</small></button>)}
          {!projectDrafts.length && !projectSessions.length && !projectRuns.length && !projectAgents.length && <div className="project-empty">No chats</div>}
        </div>}
      </div>
    })}</div>
    <div className="side-heading"><span>Recents</span></div>
    <div className="recent-search"><Search size={13} /><input value={query} onChange={(event) => onQuery(event.target.value)} placeholder="Search chats" /></div>
    <div className="side-recents">{state.drafts.map((draft) => <button key={draft.id} className={draft.id === selectedDraftId ? 'selected' : ''} onClick={() => onSelectDraft(draft)}><span className="recent-status draft-status"><Circle size={7} /></span><span>New chat</span></button>)}{[...sessions].sort(runningFirst).slice(0, 30).map((session) => <button key={`${session.hostId}:${session.id}`} className={`${session.status === 'running' ? 'running ' : ''}${`${session.hostId}:${session.id}` === selectedSessionKey ? 'selected' : ''}`} onClick={() => onSelectSession(session)}><span className="recent-status">{session.status === 'running' ? <Radio size={12} /> : providerIcon(session.provider)}</span><span>{session.title}</span>{session.status === 'running' ? <small className="running-label">Running</small> : <small>{relative(session.updatedAt)}</small>}</button>)}</div>
    <div className="side-bottom"><button onClick={onSettings}><Settings2 size={17} /><span>Settings</span></button><button><Archive size={17} /><span>Archived chats</span></button></div>
  </aside>
}

function StartScreen({ state, draft, project, host, onProject, onStarted }: { state: AppState; draft?: DraftSession; project?: Project; host?: Host; onProject: () => void; onStarted: (run: Run) => void }) {
  const [prompt, setPrompt] = useState(draft?.prompt || ''); const [provider, setProvider] = useState(draft?.provider || 'codex'); const [workspace, setWorkspace] = useState<'current_checkout' | 'managed_worktree'>(draft?.workspaceMode || 'current_checkout'); const [busy, setBusy] = useState(false)
  const providers = project ? state.providersByHost[project.hostId] || [] : []
  useEffect(() => { if (draft) return; const first = providers.find((item) => item.available); if (first) setProvider(first.id) }, [project?.id, draft?.id])
  useEffect(() => { if (!draft) return; const timer = window.setTimeout(() => { void api.updateDraft(draft.id, { prompt, provider, workspaceMode: workspace }) }, 250); return () => clearTimeout(timer) }, [draft?.id, prompt, provider, workspace])
  const submit = async (event: FormEvent) => { event.preventDefault(); if (!project || !prompt.trim()) return; setBusy(true); try { const input = { hostId: project.hostId, project_id: project.id, provider, prompt, workspace_mode: workspace, base_ref: 'HEAD' }; onStarted(draft ? await api.startDraft(draft.id, input) : await api.createRun(input)) } finally { setBusy(false) } }
  return <div className="start-screen">
    <div className="start-center"><div className="agent-cloud"><Command size={28} /></div><h1>{project ? `What should we work on in ${project.name}?` : 'Add a project to get started'}</h1>{project && <div className="starter-cards"><button onClick={() => setPrompt('Explore and explain this codebase')}><Search size={17} /><span>Explore and<br />understand code</span></button><button onClick={() => setPrompt('Build a new feature for this project')}><Zap size={17} /><span>Build a new feature,<br />app, or tool</span></button><button onClick={() => setPrompt('Review the code and suggest improvements')}><RefreshCw size={17} /><span>Review code and<br />suggest changes</span></button><button onClick={() => setPrompt('Find and fix issues and failures')}><ShieldAlert size={17} /><span>Fix issues and failures</span></button></div>}</div>
    {project ? <form className="codex-composer" onSubmit={submit}><div className="composer-context"><button><FolderGit2 size={15} />{project.name}</button><button>{host?.type === 'ssh' ? <Globe2 size={15} /> : <Laptop size={15} />}{host?.type === 'ssh' ? 'Remote' : 'Local'}</button><button><GitBranch size={15} />main</button><span /><strong>{host?.name}<i className={host?.status} /></strong></div><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Do anything" /><div className="composer-footer"><button type="button" className="plus"><Plus size={18} /></button><button type="button" className={`access ${workspace === 'managed_worktree' ? 'worktree' : ''}`} onClick={() => setWorkspace((value) => value === 'current_checkout' ? 'managed_worktree' : 'current_checkout')}>{workspace === 'managed_worktree' ? <TreePine size={15} /> : <ShieldAlert size={15} />}{workspace === 'managed_worktree' ? 'New worktree' : 'Current checkout'}</button><span /><select value={provider} onChange={(event) => setProvider(event.target.value as Provider['id'])}>{providers.filter((item) => item.available).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><button className="send" disabled={busy || !prompt.trim()}>{busy ? <RefreshCw className="spin" size={17} /> : <Send size={17} />}</button></div></form> : <button className="add-project-cta" onClick={onProject}><Plus size={17} />Add project</button>}
  </div>
}

function RunScreen({ run, events, project, host, provider }: { run: Run; events: RunEvent[]; project?: Project; host?: Host; provider?: Provider }) {
  const [message, setMessage] = useState(''); const scroll = useRef<HTMLDivElement>(null)
  useEffect(() => { scroll.current?.scrollTo({ top: scroll.current.scrollHeight }) }, [events.length])
  const send = async (event: FormEvent) => { event.preventDefault(); if (!message.trim()) return; if (provider?.live_input && active.has(run.status)) await api.input(run.hostId, run.id, message.trim()); else if (run.sessionId && provider?.resume) await api.resumeRun(run, message.trim()); else return; setMessage('') }
  return <div className="thread-screen">
    <header className="thread-header"><FolderGit2 size={16} /><strong>{run.title}</strong><button><MoreHorizontal size={18} /></button><span /><button className="open-in">Open in <ChevronDown size={14} /></button><button><Settings2 size={17} /></button></header>
    <div className="thread-scroll" ref={scroll}><div className="thread-column"><div className="user-message">{run.prompt}</div>{events.map((event) => <ThreadEvent key={event.event_id} event={event} />)}</div></div>
    <aside className="environment-card"><header><span>Environment</span><button onClick={() => api.openPath(run.hostId, run.cwd)}><Plus size={17} /></button></header><div><Terminal size={16} /><span>Provider</span><strong>{provider?.name || run.provider}</strong></div><div>{host?.type === 'ssh' ? <Globe2 size={16} /> : <Laptop size={16} />}<span>Location</span><strong>{host?.name}</strong></div><div><FolderGit2 size={16} /><span>Project</span><strong>{project?.name}</strong></div><div><GitBranch size={16} /><span>Workspace</span><strong>{run.worktreeId ? 'Worktree' : 'Current'}</strong></div>{run.worktreeId && !active.has(run.status) && <div className="worktree-actions"><button onClick={async () => { const status = await api.worktreeStatus(run.hostId, run.worktreeId!); alert(`${status.summary}\n\n${status.diff_stat}`) }}>Inspect</button><button onClick={async () => { const status = await api.worktreeStatus(run.hostId, run.worktreeId!); if (confirm(status.dirty ? 'This worktree has uncommitted changes. Force remove it?' : 'Remove this managed worktree?')) await api.removeWorktree(run.hostId, run.worktreeId!, status.dirty) }}>Remove</button></div>}{host?.status !== 'online' && <p><WifiOff size={13} />Viewer reconnecting; run remains on host.</p>}</aside>
    <form className="thread-composer" onSubmit={send}><textarea disabled={active.has(run.status) ? !provider?.live_input : !(run.sessionId && provider?.resume)} value={message} onChange={(event) => setMessage(event.target.value)} placeholder={active.has(run.status) ? (provider?.live_input ? 'Steer this run' : 'Live steering is not available for this provider') : (run.sessionId && provider?.resume ? 'Continue this session' : 'This provider session cannot be resumed')} /><div><button type="button"><Plus size={18} /></button>{active.has(run.status) && <button type="button" className="interrupt" onClick={() => api.controlRun(run.hostId, run.id, 'interrupt')}><Square size={14} />Interrupt</button>} {run.status === 'interrupting' && <><button type="button" className="interrupt" onClick={() => api.controlRun(run.hostId, run.id, 'terminate')}>Terminate</button><button type="button" className="interrupt" onClick={() => confirm('Force kill the full process group?') && api.controlRun(run.hostId, run.id, 'kill')}>Kill</button></>}<span /><small>{run.model || provider?.name}</small>{!active.has(run.status) && run.sessionId && provider?.fork && <button type="button" onClick={() => message.trim() && api.resumeRun(run, message.trim(), true)}>Fork</button>}<button className="send" disabled={!message.trim() || (active.has(run.status) ? !provider?.live_input : !(run.sessionId && provider?.resume))}><Send size={17} /></button></div></form>
  </div>
}

function SessionScreen({ session, messages, project, host }: { session: ProviderSession; messages: SessionMessage[]; project?: Project; host?: Host }) {
  const scroll = useRef<HTMLDivElement>(null)
  useEffect(() => { scroll.current?.scrollTo({ top: scroll.current.scrollHeight }) }, [messages.length])
  return <div className="thread-screen provider-thread">
    <header className="thread-header">{providerIcon(session.provider)}<strong>{session.title}</strong>{session.status === 'running' && <span className="observed-badge"><Radio size={11} />Running</span>}<span /><button><MoreHorizontal size={18} /></button></header>
    <div className="thread-scroll" ref={scroll}><div className="thread-column">{messages.length ? messages.map((message) => message.role === 'user' ? <div className="user-message" key={message.id}>{message.text}</div> : <div className="thread-text assistant-message" key={message.id}>{message.text}</div>) : <div className="thread-status"><RefreshCw className="spin" size={13} />Loading conversation</div>}</div></div>
    <aside className="environment-card"><header><span>Environment</span></header><div>{providerIcon(session.provider)}<span>Provider</span><strong>{providerName(session.provider)}</strong></div><div>{host?.type === 'ssh' ? <Globe2 size={16} /> : <Laptop size={16} />}<span>Location</span><strong>{host?.name}</strong></div><div><FolderGit2 size={16} /><span>Project</span><strong>{project?.name}</strong></div>{session.pid && <div><Terminal size={16} /><span>Process</span><strong>PID {session.pid}</strong></div>}</aside>
    <div className="thread-composer readonly-composer"><textarea disabled placeholder={session.status === 'running' ? 'Read-only live session · safe attach is not available' : 'This historical session is read-only'} /><div><span /><small>Provider-native history</small></div></div>
  </div>
}

function ObservedScreen({ host, project, agent }: { host?: Host; project?: Project; agent: DiscoveredAgent }) {
  return <div className="thread-screen observed-screen">
    <header className="thread-header">{providerIcon(agent.provider)}<strong>{providerName(agent.provider)} session</strong><span className="observed-badge"><Radio size={11} />Observed</span><span /><button><MoreHorizontal size={18} /></button></header>
    <div className="observed-content"><div className="observed-hero">{providerIcon(agent.provider)}<h1>{providerName(agent.provider)} is running</h1><p>Codesk found this session on {host?.name || 'the execution host'}. It was started outside Codesk, so it remains read-only.</p></div><div className="observed-details"><div><span>Project</span><strong>{project?.name || 'Unregistered folder'}</strong></div><div><span>Working directory</span><code>{agent.cwd || 'Unknown'}</code></div><div><span>Process</span><strong>PID {agent.pid}</strong></div><div><span>Command</span><code>{agent.command}</code></div></div><div className="observed-note"><ShieldAlert size={17} /><span><strong>No terminal attachment</strong>Existing output and stdin are unavailable unless the session was launched through Codesk or the provider exposes a safe attach protocol.</span></div></div>
  </div>
}

function ThreadEvent({ event }: { event: RunEvent }) { const text = event.payload.text; if (!text && !event.kind.startsWith('run.') && !event.kind.startsWith('control.')) return null; if (event.kind === 'output' || event.kind.includes('message')) return <div className={`thread-text ${event.channel === 'stderr' ? 'error' : ''}`}>{String(text || '')}</div>; return <div className="thread-status"><span>{event.kind.replaceAll('.', ' ')}</span>{event.payload.exit_code !== undefined && <code>{String(event.payload.exit_code)}</code>}</div> }

function Dialog({ title, subtitle, onClose, children }: { title: string; subtitle: string; onClose: () => void; children: React.ReactNode }) { return <div className="dialog-backdrop"><div className="codex-dialog"><header><div><h2>{title}</h2><p>{subtitle}</p></div><button onClick={onClose}><X size={18} /></button></header>{children}</div></div> }
function ProjectDialog({ hosts, onClose, onCreated }: { hosts: Host[]; onClose: () => void; onCreated: () => void }) {
  const online = hosts.filter((host) => host.status === 'online'); const [hostId, setHost] = useState(online[0]?.id || ''); const [path, setPath] = useState(''); const [entries, setEntries] = useState<FileEntry[]>([]); const [busy, setBusy] = useState(false); const [error, setError] = useState('')
  const browse = async (nextPath = path) => { if (!hostId) return; setBusy(true); setError(''); try { const items = await api.files(hostId, nextPath); setEntries(items); if (!nextPath && items[0]) setPath(items[0].path.split('/').slice(0, -1).join('/') || '/') } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) } }
  useEffect(() => { setEntries([]); setPath(''); if (hostId) void browse('') }, [hostId])
  const parent = path.split('/').slice(0, -1).join('/') || '/'
  return <Dialog title="Add folder" subtitle="Browse on the execution host. Git projects below this folder are discovered automatically." onClose={onClose}><div className="folder-dialog"><label>Host<select value={hostId} onChange={(event) => setHost(event.target.value)}>{online.map((host) => <option value={host.id} key={host.id}>{host.name}{host.type === 'ssh' ? ' · Remote' : ' · Local'}</option>)}</select></label><div className="folder-path"><button type="button" onClick={() => { setPath(parent); void browse(parent) }}>↩</button><input value={path} onChange={(event) => setPath(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void browse() } }} /><button type="button" onClick={() => void browse()}><RefreshCw className={busy ? 'spin' : ''} size={15} /></button></div><div className="folder-list">{entries.map((entry) => <button type="button" key={entry.path} onClick={() => { setPath(entry.path); void browse(entry.path) }}><FolderGit2 size={17} /><span>{entry.name}</span>{entry.is_git && <small>Git</small>}<ChevronDown size={14} /></button>)}</div>{error && <p className="dialog-error">{error}</p>}<p className="folder-note">Adding a parent folder registers every Git repository found up to two levels below it. Existing runs are never touched.</p><footer><button type="button" onClick={onClose}>Cancel</button><button type="button" className="dialog-primary" disabled={!path || busy} onClick={async () => { setBusy(true); setError(''); try { await api.discoverProjects(hostId, path, true, 2); onCreated() } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setBusy(false) } }}>{busy ? 'Discovering…' : 'Add folder'}</button></footer></div></Dialog>
}
function ConnectionsDialog({ hosts, onClose, onChanged }: { hosts: Host[]; onClose: () => void; onChanged: () => void }) {
  const [name, setName] = useState(''); const [alias, setAlias] = useState(''); const [aliases, setAliases] = useState<string[]>([]); const [agents, setAgents] = useState<Record<string, DiscoveredAgent[]>>({}); const [busy, setBusy] = useState(''); const [error, setError] = useState('')
  useEffect(() => { api.sshAliases().then(setAliases).catch(() => {}) }, [])
  const inspectAgents = async (host: Host) => { setBusy(`agents:${host.id}`); setError(''); try { const found = await api.discoveredAgents(host.id); setAgents((current) => ({ ...current, [host.id]: found })) } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy('') } }
  return <Dialog title="Connections" subtitle="Local and SSH execution hosts" onClose={onClose}><div className="connection-list">{hosts.map((host) => <div className="connection-host" key={host.id}><div className="connection-row"><i className={host.status} /><span><strong>{host.name}</strong><small>{host.type === 'local' ? 'Local daemon' : host.sshAlias}{host.error ? ` · ${host.error}` : ''}</small></span><button title="Discover running agents" disabled={host.status !== 'online'} onClick={() => void inspectAgents(host)}><Radio size={15} /></button>{host.type === 'ssh' && <button title="Install or reconnect" onClick={async () => { setBusy(`host:${host.id}`); setError(''); try { await api.bootstrapHost(host.id); await onChanged() } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy('') } }}>{busy === `host:${host.id}` ? <RefreshCw className="spin" size={15} /> : <RefreshCw size={15} />}</button>}</div>{agents[host.id]?.map((agent) => <div className="discovered-agent" key={agent.id}>{providerIcon(agent.provider)}<span><strong>{agent.provider} · PID {agent.pid}</strong><small>{agent.cwd || agent.command}</small></span>{agent.managed_run_id ? <em>Managed</em> : <button onClick={() => api.controlDiscoveredAgent(host.id, agent.pid, 'interrupt')}><Square size={12} />Interrupt</button>}</div>)}</div>)}</div>{error && <p className="dialog-error">{error}</p>}<form className="connection-add" onSubmit={async (event) => { event.preventDefault(); setError(''); try { const host = await api.createHost({ name: name || alias, sshAlias: alias }); setName(''); setAlias(''); await onChanged(); try { await api.bootstrapHost(host.id); await onChanged() } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } }}><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Display name" /><input list="ssh-aliases" value={alias} onChange={(event) => setAlias(event.target.value)} placeholder="SSH alias" /><datalist id="ssh-aliases">{aliases.map((value) => <option key={value} value={value} />)}</datalist><button><Plus size={16} />Connect</button></form></Dialog>
}
