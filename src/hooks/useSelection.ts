import { useCallback, useEffect, useRef, useState } from 'react'
import type { Dispatch, RefObject, SetStateAction } from 'react'
import { active } from '../lib/events'
import { projectKey, sessionKey } from '../lib/keys'
import type {
  AppState,
  DiscoveredAgent,
  DraftSession,
  Project,
  ProviderSession,
  Run,
} from '../types'

/**
 * What the user is looking at: the selected run/session/agent/draft/project,
 * the handlers that move between them, and the bootstrap pick made from the
 * first loaded snapshot.
 */
export function useSelection({
  state,
  setState,
  stateRef,
  allSessions,
}: {
  state: AppState
  setState: Dispatch<SetStateAction<AppState>>
  stateRef: RefObject<AppState>
  allSessions: ProviderSession[]
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedSessionKey, setSelectedSessionKey] = useState<string | null>(null)
  const [selectedAgentKey, setSelectedAgentKey] = useState<string | null>(null)
  const [selectedDraftId, setSelectedDraftId] = useState<string | null>(null)
  const [selectedProjectKey, setSelectedProjectKey] = useState<string | null>(null)
  const initialized = useRef(false)
  const selectedRunRef = useRef<Run | null>(null)
  const initializeSelection = useCallback((next: AppState) => {
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
  }, [])
  const run = state.runs.find((item) => item.id === selectedId) || null
  const clearSelectedRun = useCallback(() => {
    selectedRunRef.current = null
  }, [])
  const selectProject = useCallback(
    (next: Project) => {
      clearSelectedRun()
      setSelectedProjectKey(projectKey(next))
      setSelectedId(null)
      setSelectedSessionKey(null)
      setSelectedAgentKey(null)
      setSelectedDraftId(null)
    },
    [clearSelectedRun],
  )
  const selectRun = useCallback(
    (next: Run) => {
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
    },
    [setState],
  )
  const selectSession = useCallback(
    (next: ProviderSession) => {
      const activeRun = stateRef.current.runs.find(
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
    },
    [clearSelectedRun, selectRun, stateRef],
  )
  const selectDraft = useCallback(
    (next: DraftSession) => {
      clearSelectedRun()
      setSelectedDraftId(next.id)
      setSelectedId(null)
      setSelectedSessionKey(null)
      setSelectedAgentKey(null)
      setSelectedProjectKey(`${next.hostId}:${next.projectId}`)
    },
    [clearSelectedRun],
  )
  const selectAgent = useCallback(
    (hostId: string, agent: DiscoveredAgent, nextProject?: Project) => {
      clearSelectedRun()
      setSelectedAgentKey(`${hostId}:${agent.id}`)
      setSelectedId(null)
      setSelectedSessionKey(null)
      setSelectedDraftId(null)
      if (nextProject) setSelectedProjectKey(projectKey(nextProject))
    },
    [clearSelectedRun],
  )
  const runHostId = run?.hostId
  const runProjectId = run?.projectId
  const runProvider = run?.provider
  const runSessionId = run?.sessionId
  const runInputTransport = run?.inputTransport
  useEffect(() => {
    if (
      runInputTransport !== 'tmux' ||
      !runSessionId ||
      !runHostId ||
      runProjectId === undefined ||
      !runProvider
    )
      return
    const matching = allSessions.find(
      (item) =>
        item.hostId === runHostId &&
        item.projectId === runProjectId &&
        item.provider === runProvider &&
        item.nativeSessionId === runSessionId,
    )
    if (!matching) return
    // Redirecting the selection is a state write, and it cannot move into the
    // click handler that picked the run: a tmux-backed run only learns its
    // native session id once the harness has attached, which happens after the
    // run is already on screen.
    selectSession(matching)
  }, [
    allSessions,
    runHostId,
    runInputTransport,
    runProjectId,
    runProvider,
    runSessionId,
    selectSession,
  ])
  return {
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
  }
}
