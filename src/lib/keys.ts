// Extracted from App.tsx during the Tailwind/module refactor.
import type { Project, ProviderSession, Run } from '../types'

export const projectKey = (project: Project) => `${project.hostId}:${project.id}`

export const normalizedFolder = (value: string) =>
  value.length > 1 ? value.replace(/\/+$/, '') : value
/// Folders shown before the "Outside your projects" list collapses. Remote hosts
/// can be running many harnesses at once, and this list must not crowd out the
/// projects the user actually registered.

export const sessionKey = (session: Pick<ProviderSession, 'hostId' | 'id'>) =>
  `${session.hostId}:${session.id}`
/// Identity of a run row in navigation, used for pinning-style user state such
/// as archiving. Distinct from a provider session key: run ids are daemon-issued.

export const runRowKey = (run: Pick<Run, 'hostId' | 'id'>) => `${run.hostId}:${run.id}`

export const recentFirst = (left: ProviderSession, right: ProviderSession) =>
  right.sortAt.localeCompare(left.sortAt) ||
  Number(right.status === 'running') - Number(left.status === 'running')

export const runEventNotificationKey = (_hostId: string, runId: string) => `run:${runId}`

export const sessionNotificationKey = (
  session: Pick<ProviderSession, 'hostId' | 'provider' | 'nativeSessionId'>,
) => `session:${session.hostId}:${session.provider}:${session.nativeSessionId}`

export const runNotificationKeys = (run: Pick<Run, 'hostId' | 'id' | 'provider' | 'sessionId'>) => [
  runEventNotificationKey(run.hostId, run.id),
  ...(run.sessionId ? [`session:${run.hostId}:${run.provider}:${run.sessionId}`] : []),
]

/// Session and run screens remount independently; share a key when they are
/// the same conversation so the last scroll position survives that switch too.
export const threadScrollKeyForSession = sessionNotificationKey
export const threadScrollKeyForRun = (
  run: Pick<Run, 'hostId' | 'id' | 'provider' | 'sessionId'>,
) =>
  run.sessionId
    ? `session:${run.hostId}:${run.provider}:${run.sessionId}`
    : runEventNotificationKey(run.hostId, run.id)

export const terminalNotificationTag = (runId: string, status: Run['status']) =>
  `run-status:${runId}:${status}`
