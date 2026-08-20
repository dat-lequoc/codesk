import { Archive } from 'lucide-react'

import { AppDialog } from '../../components/ui/app-dialog'
import { Button } from '../../components/ui/button'
import { relative } from '../../lib/format'
import { runNotificationKeys, sessionKey, sessionNotificationKey } from '../../lib/keys'
import { providerName } from '../../providerRegistry'
import type { Host, Project, ProviderSession, Run } from '../../types'

const archivedRow =
  'my-2 flex min-h-[62px] items-center rounded-xl border border-line-strong bg-ink-700 py-1.5 pr-2 pl-1'
const archivedMain = 'flex h-[50px] min-w-0 flex-1 items-center gap-2.5 text-left text-fg-soft'
const unreadDot =
  'block size-2 shrink-0 rounded-full bg-scarlet-500 shadow-[0_0_0_2px_#ff3b3033,0_0_7px_#ff3b30aa]'
export function ArchivedChatsDialog({
  sessions,
  archivedRuns,
  runs,
  unreadKeys,
  projects,
  hosts,
  onOpen,
  onOpenRun,
  onRestore,
  onRestoreRun,
  onClose,
}: {
  sessions: ProviderSession[]
  archivedRuns: Run[]
  runs: Run[]
  unreadKeys: Set<string>
  projects: Project[]
  hosts: Host[]
  onOpen: (session: ProviderSession) => void
  onOpenRun: (run: Run) => void
  onRestore: (session: ProviderSession) => Promise<void>
  onRestoreRun: (run: Run) => Promise<void>
  onClose: () => void
}) {
  const hasUnread = (session: ProviderSession) =>
    unreadKeys.has(sessionNotificationKey(session)) ||
    runs.some(
      (run) =>
        run.hostId === session.hostId &&
        run.provider === session.provider &&
        run.sessionId === session.nativeSessionId &&
        runNotificationKeys(run).some((key) => unreadKeys.has(key)),
    )
  return (
    <AppDialog
      title="Archived chats"
      subtitle="Archived conversations stay available without cluttering project navigation."
      onClose={onClose}
      className="max-w-[680px]"
    >
      <div className="max-h-[480px]">
        {sessions.length + archivedRuns.length ? (
          <>
            {sessions.map((session) => {
              const project = projects.find(
                (item) => item.id === session.projectId && item.hostId === session.hostId,
              )
              const host = hosts.find((item) => item.id === session.hostId)
              return (
                <div className={archivedRow} key={sessionKey(session)}>
                  <button className={archivedMain} onClick={() => onOpen(session)}>
                    <Archive size={14} className="shrink-0 text-muted" />
                    <span className="min-w-0">
                      <strong className="flex items-center gap-1.5 truncate text-[13px] font-medium">
                        {hasUnread(session) && (
                          <i
                            className={unreadDot}
                            title="Unread agent update"
                            aria-label="Unread agent update"
                          />
                        )}
                        <span className="min-w-0 truncate">{session.title}</span>
                      </strong>
                      <small className="mt-1 block truncate text-[10px] text-muted">
                        {project?.name || session.cwd} · {host?.name || session.hostId} ·{' '}
                        {relative(session.updatedAt)}
                      </small>
                    </span>
                  </button>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="h-[30px] shrink-0 text-[11px]"
                    onClick={() => void onRestore(session)}
                  >
                    Unarchive
                  </Button>
                </div>
              )
            })}
            {archivedRuns.map((run) => {
              const project = projects.find(
                (item) => item.id === run.projectId && item.hostId === run.hostId,
              )
              const host = hosts.find((item) => item.id === run.hostId)
              return (
                <div className={archivedRow} key={`run:${run.hostId}:${run.id}`}>
                  <button className={archivedMain} onClick={() => onOpenRun(run)}>
                    <Archive size={14} className="shrink-0 text-muted" />
                    <span className="min-w-0">
                      <strong className="flex items-center gap-1.5 truncate text-[13px] font-medium">
                        <span className="min-w-0 truncate">{run.title}</span>
                      </strong>
                      <small className="mt-1 block truncate text-[10px] text-muted">
                        {providerName(run.provider)} run · {run.status} · {project?.name || run.cwd}{' '}
                        · {host?.name || run.hostId} · {relative(run.createdAt)}
                      </small>
                    </span>
                  </button>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="h-[30px] shrink-0 text-[11px]"
                    onClick={() => void onRestoreRun(run)}
                  >
                    Unarchive
                  </Button>
                </div>
              )
            })}
          </>
        ) : (
          <div className="flex h-[190px] flex-col items-center justify-center gap-2 text-center text-dim">
            <Archive size={24} />
            <strong className="text-sm text-fg-soft">No archived chats</strong>
            <span className="max-w-[330px] text-[11px] leading-relaxed">
              Use the archive button beside a project conversation to move it here.
            </span>
          </div>
        )}
      </div>
    </AppDialog>
  )
}
