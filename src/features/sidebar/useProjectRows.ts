import { useCallback, useMemo } from 'react'
import type { observedAgents } from '../../lib/app-state'
import { active } from '../../lib/events'
import { draftTitle } from '../../lib/format'
import {
  projectKey,
  recentFirst,
  runNotificationKeys,
  runRowKey,
  sessionKey,
  sessionNotificationKey,
} from '../../lib/keys'
import { providerName } from '../../lib/providers'
import { itemBudget } from '../../sessionBudget'
import type { DraftSession, Host, Project, ProviderSession, Run } from '../../types'

export type ObservedAgentEntry = ReturnType<typeof observedAgents>[number]

export type ProjectRowModel = {
  project: Project
  key: string
  host: Host | undefined
  open: boolean
  /// Whether the project has any non-archived sessions (drives "Archive chats").
  canArchive: boolean
  projectUnread: boolean
  totalProjectItems: number
  itemLimit: number
  visibleProjectDrafts: DraftSession[]
  visibleProjectSessions: ProviderSession[]
  visibleProjectRuns: Run[]
  visibleProjectAgents: ObservedAgentEntry[]
  runningSessions: ProviderSession[]
  runningCount: number
}

/**
 * Builds the per-project row model for the sidebar: which drafts, sessions,
 * runs and observed agents are visible under each project after search
 * filtering and the item budget, plus the unread/running rollups the project
 * header shows. Pure data — the components render it.
 */
export function useProjectRows({
  projects,
  hosts,
  drafts,
  sessions,
  runs,
  agents,
  unreadKeys,
  archivedSessionKeys,
  archivedRunKeys,
  needle,
  expanded,
  projectItemLimits,
  selectedId,
}: {
  projects: Project[]
  hosts: Host[]
  drafts: DraftSession[]
  sessions: ProviderSession[]
  runs: Run[]
  agents: ObservedAgentEntry[]
  unreadKeys: Set<string>
  archivedSessionKeys: string[]
  archivedRunKeys: string[]
  needle: string
  expanded: Set<string>
  projectItemLimits: Map<string, number>
  selectedId: string | null
}) {
  // One pass over runs instead of an O(sessions × runs) scan per row: the
  // budget logic below calls hasUnreadSession for every visible session on
  // every render.
  const unreadRunSessionKeys = useMemo(() => {
    const keys = new Set<string>()
    for (const run of runs) {
      if (!run.sessionId) continue
      if (runNotificationKeys(run).some((key) => unreadKeys.has(key)))
        keys.add(`${run.hostId}:${run.provider}:${run.sessionId}`)
    }
    return keys
  }, [runs, unreadKeys])
  const hasUnreadSession = useCallback(
    (session: ProviderSession) =>
      unreadKeys.has(sessionNotificationKey(session)) ||
      unreadRunSessionKeys.has(
        `${session.hostId}:${session.provider}:${session.nativeSessionId}`,
      ),
    [unreadKeys, unreadRunSessionKeys],
  )
  const hasUnreadRun = useCallback(
    (run: Run) => runNotificationKeys(run).some((key) => unreadKeys.has(key)),
    [unreadKeys],
  )
  const rows = useMemo(() => {
    const archivedKeys = new Set(archivedSessionKeys)
    const archivedRunKeySet = new Set(archivedRunKeys)
    // How many items a project may list. Zero is a real budget the user can
    // reach by archiving, so a stored zero must not be mistaken for a missing
    // entry.
    const projectItemLimit = (key: string) => itemBudget(projectItemLimits, key)
    const models: ProjectRowModel[] = []
    for (const project of projects) {
      const key = projectKey(project)
      const host = hosts.find((item) => item.id === project.hostId)
      const allProjectDrafts = drafts.filter(
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
          !archivedRunKeySet.has(runRowKey(run)) &&
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
        continue
      const open = needle ? true : expanded.has(key)
      const totalProjectItems =
        projectDrafts.length + matchingSessions.length + projectRuns.length + projectAgents.length
      const itemLimit = needle ? totalProjectItems : projectItemLimit(key)
      const unreadProjectSessions = matchingSessions.filter(hasUnreadSession)
      const unreadProjectRuns = projectRuns.filter(hasUnreadRun)
      // A running conversation keeps a slot ahead of quiet history, so the
      // count in the project header always has a row to point at.
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
      models.push({
        project,
        key,
        host,
        open,
        canArchive: allProjectSessions.length > 0,
        projectUnread,
        totalProjectItems,
        itemLimit,
        visibleProjectDrafts,
        visibleProjectSessions,
        visibleProjectRuns,
        visibleProjectAgents,
        runningSessions,
        runningCount,
      })
    }
    return models
  }, [
    agents,
    archivedRunKeys,
    archivedSessionKeys,
    drafts,
    expanded,
    hasUnreadRun,
    hasUnreadSession,
    hosts,
    needle,
    projectItemLimits,
    projects,
    runs,
    selectedId,
    sessions,
  ])
  return { rows, hasUnreadSession, hasUnreadRun }
}
