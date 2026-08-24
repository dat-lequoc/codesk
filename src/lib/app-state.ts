// Extracted from App.tsx during the Tailwind/module refactor.
import type { AppState, DiscoveredAgent, FileEntry, Project } from '../types'
import { normalizedFolder } from './keys'
import { normalizeTheme } from './theme'

export const empty: AppState = {
  hosts: [],
  projects: [],
  runs: [],
  sessions: [],
  drafts: [],
  providersByHost: {},
  discoveredAgentsByHost: {},
  settings: {
    notifications: true,
    theme: 'system' as const,
    pinnedSessionKeys: [],
    pinnedSessions: [],
    archivedSessionKeys: [],
    archivedSessions: [],
    archivedRunKeys: [],
    hiddenAgentKeys: [],
  },
}

export const logoUrl = new URL('../../logo.png', import.meta.url).href

export const DETACHED_FOLDER_PREVIEW = 4

export const projectForAgent = (projects: Project[], hostId: string, agent: DiscoveredAgent) =>
  projects.find(
    (project) =>
      project.hostId === hostId &&
      agent.cwd &&
      normalizedFolder(agent.cwd) === normalizedFolder(project.path),
  )

export const observedAgents = (state: AppState) => {
  const sessions = new Map<string, { hostId: string; agent: DiscoveredAgent; project?: Project }>()
  const indexedSessions = [
    ...state.sessions,
    ...state.settings.pinnedSessions,
    ...state.settings.archivedSessions,
  ]
  for (const [hostId, agents] of Object.entries(state.discoveredAgentsByHost || {}))
    for (const agent of agents) {
      if (agent.managed_run_id || /codex-code-mode-host|app-server(?:\s|$)/.test(agent.command))
        continue
      if (
        agent.native_session_id &&
        indexedSessions.some(
          (session) =>
            session.hostId === hostId &&
            session.provider === agent.provider &&
            session.nativeSessionId === agent.native_session_id,
        )
      )
        continue
      const key = `${hostId}:${agent.process_group_id || agent.pid}`
      if (!sessions.has(key))
        sessions.set(key, {
          hostId,
          agent,
          project: projectForAgent(state.projects, hostId, agent),
        })
    }
  return [...sessions.values()]
}
/// Indeterminate arc spinner, following the approach loading-ui.com uses for its
/// Arc component: a rotating circle with one transparent side that inherits
/// `currentColor`. Written as plain CSS because this app has no utility-class
/// framework, so callers set only size, thickness and `--duration`.

export const folderMatchScore = (entry: FileEntry, rawQuery: string) => {
  const query = rawQuery.trim().toLowerCase()
  const name = entry.name.toLowerCase()
  const fullPath = entry.path.toLowerCase()
  if (!query) return 0
  if (name === query) return 0
  if (name.startsWith(query)) return 1
  if (name.includes(query)) return 2
  if (fullPath.includes(query)) return 3
  let cursor = 0
  for (const character of name) if (character === query[cursor]) cursor += 1
  return cursor === query.length ? 4 : Number.POSITIVE_INFINITY
}

export const normalizeState = (value: AppState) => ({
  ...value,
  drafts: value.drafts || [],
  settings: {
    notifications: value.settings?.notifications ?? true,
    theme: normalizeTheme(value.settings?.theme),
    pinnedSessionKeys: value.settings?.pinnedSessionKeys || [],
    pinnedSessions: value.settings?.pinnedSessions || [],
    archivedSessionKeys: value.settings?.archivedSessionKeys || [],
    archivedSessions: value.settings?.archivedSessions || [],
    archivedRunKeys: value.settings?.archivedRunKeys || [],
    hiddenAgentKeys: value.settings?.hiddenAgentKeys || [],
  },
})
