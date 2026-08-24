import { cn } from '../../lib/cn'
import {
  composerBar,
  composerHint,
  composerTextarea,
  deliveryMode,
  environmentActionButton,
  environmentActionDanger,
  environmentActions,
  environmentToggle,
  environmentToggleActive,
  headerButton,
  interrupt,
  openIn,
  queueHeader,
  queueHeaderButton,
  queueLabel,
  queuePanel,
  queueRow,
  queueRowButton,
  queueRowFailed,
  rewindBanner,
  sendButton,
  threadComposer,
  threadComposerFilePreview,
  threadComposerMenuOpen,
  threadHeader,
  threadHeaderTitle,
  threadScreen,
  threadScreenEnvOpen,
  threadScroll,
  threadScrollFilePreview,
} from './screen-styles'
import { FilePreviewContext } from '../../hooks/useFilePreview'
import type { KeyboardEvent } from 'react'
import { Globe2, MoreHorizontal } from 'lucide-react'
import {
  ChevronDown,
  Folder,
  FolderGit2,
  GitBranch,
  GitMerge,
  Info,
  Laptop,
  ListPlus,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  Square,
  Terminal,
  WifiOff,
  X,
} from 'lucide-react'
import { api } from '../../api'
import { useFilePreview } from '../../hooks/useFilePreview'
import { usePersistentComposerDraft } from '../../hooks/usePersistentComposerDraft'
import {
  isActivityGroup,
  liveActivityItems,
  timelineItems,
  turnDurations,
} from '../../lib/activity'
import type { ActivityEntry } from '../../lib/activity'
import { active, coalesceStreamEvents, currentBranchEvents, pendingQueue } from '../../lib/events'
import { kiroCommandContext, kiroSlashSuggestions, kiroSuggestionLimit } from '../../lib/kiro'
import type { SlashSuggestion } from '../../lib/kiro'
import { providerName, providerUi } from '../../lib/providers'
import type { Host, Project, Provider, Run, RunEvent } from '../../types'
import { ActivityInspectorPanel, ToolActivityGroup } from '../activity/Activity'
import {
  ComposerFooter,
  ComposerFrame,
  ComposerInput,
  SlashCommandMenu,
} from '../composer/Composer'
import { ConfirmDialog } from '../dialogs/ConfirmDialog'
import type { AppDialogRequest } from '../dialogs/ConfirmDialog'
import { FilePreviewPanel } from '../dialogs/FilePreviewPanel'
import { EnvironmentPopover, EnvironmentRow, TmuxDetails } from '../environment/Environment'
import { ConversationMessage } from '../thread/Markdown'
import { ThreadEvent } from '../thread/ThreadEvent'
import { VirtualTimeline, virtualRowEstimate } from '../thread/VirtualTimeline'
import { useThreadScroll } from '../../hooks/useThreadScroll'
import { threadScrollKeyForRun } from '../../lib/keys'
import { markSessionFinishSeen } from '../../lib/session-finish'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
export function RunScreen({
  run,
  events,
  project,
  host,
  provider,
  onStarted,
  onError,
}: {
  run: Run
  events: RunEvent[]
  project?: Project
  host?: Host
  provider?: Provider
  onStarted: (run: Run) => void
  onError: (message: string) => void
}) {
  const [message, setMessage] = usePersistentComposerDraft(`run:${run.hostId}:${run.id}`)
  const [sending, setSending] = useState(false)
  const [rewind, setRewind] = useState<{
    turnId: string
    lastTurnId: string | null
    text: string
  } | null>(null)
  const [showEnvironment, setShowEnvironment] = useState(false)
  const [selectedActivityId, setSelectedActivityId] = useState<string | null>(null)
  const [workspaceLabel, setWorkspaceLabel] = useState(
    run.worktreeId ? 'Managed worktree' : 'Current checkout',
  )
  const [worktreeBusy, setWorktreeBusy] = useState(false)
  const [dialog, setDialog] = useState<AppDialogRequest | null>(null)
  const lastEscape = useRef(0)
  const submitting = useRef(false)
  const composerInput = useRef<HTMLTextAreaElement>(null)
  const [commandIndex, setCommandIndex] = useState(0)
  const filePreview = useFilePreview(run.hostId, run.cwd)
  const lastEvent = events.at(-1)
  const { scroll, onScroll, startAtEnd, savedTop } = useThreadScroll(
    threadScrollKeyForRun(run),
    `${events.length}:${lastEvent?.event_id ?? ''}:${lastEvent?.kind ?? ''}:${run.status}`,
    {
      ready: events.length > 0,
      onAtEnd: () => {
        if (active.has(run.status) || !run.sessionId) return
        markSessionFinishSeen(`session:${run.hostId}:${run.provider}:${run.sessionId}`)
      },
    },
  )
  const projectHostId = project?.hostId
  const projectId = project?.id
  useEffect(() => {
    let cancelled = false
    if (run.worktreeId)
      api
        .worktreeStatus(run.hostId, run.worktreeId)
        .then((status) => {
          if (!cancelled) setWorkspaceLabel(status.worktree.branch || 'Managed worktree')
        })
        .catch(() => {})
    else if (projectHostId && projectId && host?.status === 'online')
      api
        .projectContext(projectHostId, projectId)
        .then((context) => {
          if (!cancelled) setWorkspaceLabel(context.branch || 'Current checkout')
        })
        .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [run.hostId, run.worktreeId, projectHostId, projectId, host?.status])
  const turnRunning = run.status === 'running'
  const ui = providerUi(run.provider)
  const tmuxRun = run.inputTransport === 'tmux'
  const queuedInput = tmuxRun || (provider?.queued_input ?? ui.queuedInput)
  const turnRewind = provider?.turn_rewind ?? ui.turnRewind
  const canUseAttachedSession = Boolean((tmuxRun || provider?.live_input) && active.has(run.status))
  const sendPrompt = async (mode: 'send' | 'fork' | 'queue' = 'send') => {
    const prompt = message.trim()
    if (!prompt || submitting.current) return
    submitting.current = true
    setSending(true)
    try {
      if (mode === 'queue') await api.input(run.hostId, run.id, prompt, 'queue')
      else if (mode === 'fork') onStarted(await api.resumeRun(run, prompt, true))
      else if (rewind && canUseAttachedSession)
        await api.input(run.hostId, run.id, prompt, 'fork', rewind.lastTurnId)
      else if (canUseAttachedSession) await api.input(run.hostId, run.id, prompt)
      else if (run.sessionId && provider?.resume) onStarted(await api.resumeRun(run, prompt))
      else return
      setMessage('')
      setRewind(null)
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      submitting.current = false
      setSending(false)
    }
  }
  const send = (event: FormEvent) => {
    event.preventDefault()
    void sendPrompt()
  }
  const queue = () => {
    void sendPrompt('queue')
  }
  // The whole timeline derivation chain is a function of `events` alone.
  // Recomputing it on every keystroke or unrelated state change re-coalesced
  // and re-grouped the full journal, so it only runs when events change.
  const derived = useMemo(() => {
    const branchEvents = currentBranchEvents(events)
    const displayEvents = coalesceStreamEvents(branchEvents)
    const displayItems = timelineItems(displayEvents)
    const backtrackable = branchEvents.filter(
      (event, index, all) =>
        event.kind === 'user.message' &&
        typeof event.payload.turn_id === 'string' &&
        typeof event.payload.text === 'string' &&
        all.findIndex(
          (candidate) =>
            candidate.kind === 'user.message' &&
            candidate.payload.turn_id === event.payload.turn_id,
        ) === index,
    )
    return {
      branchEvents,
      displayEvents,
      displayItems,
      hasUserEvents: branchEvents.some((event) => event.kind === 'user.message'),
      activityEntries: displayItems.flatMap((item) =>
        isActivityGroup(item)
          ? liveActivityItems(item.events).flatMap((activity) =>
              activity.type === 'entry' ? [activity.entry] : [],
            )
          : [],
      ),
      durations: turnDurations(displayEvents),
      queued: pendingQueue(branchEvents),
      backtrackable,
      backtrackableEventIds: new Set(backtrackable.map((event) => event.event_id)),
      resolvedRequests: new Set(
        branchEvents
          .filter(
            (event) =>
              (event.provider_event_type === 'codex.serverRequest/resolved' ||
                event.kind === 'provider.response.submitted' ||
                event.kind === 'provider.response') &&
              (event.payload.request_id !== undefined || event.payload.rpc_id !== undefined),
          )
          .map((event) => String(event.payload.request_id ?? event.payload.rpc_id)),
      ),
    }
  }, [events])
  const {
    branchEvents,
    displayItems,
    hasUserEvents,
    activityEntries,
    durations,
    queued,
    backtrackable,
    backtrackableEventIds,
    resolvedRequests,
  } = derived
  const selectedActivity = selectedActivityId
    ? activityEntries.find((entry) => entry.id === selectedActivityId) || null
    : null
  const commandContext = useMemo(() => kiroCommandContext(branchEvents), [branchEvents])
  const commandSuggestions = useMemo(
    () =>
      run.provider === 'kiro'
        ? kiroSlashSuggestions(message, commandContext).slice(0, kiroSuggestionLimit(message))
        : [],
    [run.provider, message, commandContext],
  )
  const selectedCommandIndex = Math.min(commandIndex, Math.max(0, commandSuggestions.length - 1))
  const chooseCommand = (suggestion: SlashSuggestion) => {
    setMessage(suggestion.value)
    requestAnimationFrame(() => composerInput.current?.focus())
  }
  // Typing past a slash command drops the highlight back to the first match.
  const [commandIndexFor, setCommandIndexFor] = useState(message)
  if (commandIndexFor !== message) {
    setCommandIndexFor(message)
    setCommandIndex(0)
  }
  const openFile = (href: string) => {
    setSelectedActivityId(null)
    filePreview.open(href)
  }
  const selectActivity = (entry: ActivityEntry) => {
    filePreview.close()
    setShowEnvironment(false)
    setSelectedActivityId(entry.id)
  }
  // Stable so memoized ThreadEvent rows are not invalidated by every render.
  const selectRewind = useCallback(
    (turnId: string, text: string) => {
      const index = backtrackable.findIndex((event) => event.payload.turn_id === turnId)
      if (index < 0) return
      setRewind({
        turnId,
        lastTurnId: index > 0 ? String(backtrackable[index - 1].payload.turn_id) : null,
        text,
      })
      setMessage(text)
    },
    [backtrackable, setMessage],
  )
  const mergeManagedWorktree = async () => {
    if (!run.worktreeId || worktreeBusy) return
    setWorktreeBusy(true)
    try {
      const status = await api.worktreeStatus(run.hostId, run.worktreeId)
      const target = status.worktree.base_ref || 'the base branch'
      if (status.dirty)
        throw new Error(
          'The worktree has uncommitted changes. Ask the agent to commit them before merging.',
        )
      setDialog({
        kind: 'confirm',
        title: `Merge ${status.worktree.branch || 'this worktree'} into ${target}?`,
        body: 'Codesk will refuse if the project checkout is dirty and will abort on conflicts.',
        confirmLabel: 'Merge',
        action: async () => {
          const result = await api.mergeWorktree(
            run.hostId,
            run.worktreeId!,
            status.worktree.base_ref || undefined,
          )
          setDialog({
            kind: 'message',
            title: 'Worktree merge',
            body: result.changed
              ? `Merged ${result.source_branch} into ${result.target_branch} at ${result.commit}.`
              : `${result.source_branch} is already merged into ${result.target_branch}.`,
          })
        },
      })
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setWorktreeBusy(false)
    }
  }
  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (commandSuggestions.length && event.key === 'ArrowDown') {
      event.preventDefault()
      setCommandIndex((value) => (value + 1) % commandSuggestions.length)
      return
    }
    if (commandSuggestions.length && event.key === 'ArrowUp') {
      event.preventDefault()
      setCommandIndex(
        (value) => (value - 1 + commandSuggestions.length) % commandSuggestions.length,
      )
      return
    }
    if (commandSuggestions.length && event.key === 'Tab') {
      event.preventDefault()
      chooseCommand(commandSuggestions[selectedCommandIndex])
      return
    }
    if (
      commandSuggestions.length &&
      event.key === 'Enter' &&
      !event.shiftKey &&
      message !== commandSuggestions[selectedCommandIndex].value
    ) {
      event.preventDefault()
      chooseCommand(commandSuggestions[selectedCommandIndex])
      return
    }
    if (tmuxRun && event.key === 'Tab') {
      event.preventDefault()
      void sendPrompt('queue')
      return
    }
    if (tmuxRun && event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void sendPrompt()
      return
    }
    if (event.key !== 'Escape') {
      lastEscape.current = 0
      return
    }
    if (run.status !== 'waiting_for_input' || queued.length || (!rewind && message)) return
    event.preventDefault()
    const now = Date.now()
    if (!rewind && now - lastEscape.current > 900) {
      lastEscape.current = now
      return
    }
    lastEscape.current = now
    const current = rewind
      ? backtrackable.findIndex((item) => item.payload.turn_id === rewind.turnId)
      : backtrackable.length
    const selected = backtrackable[Math.max(0, current - 1)]
    if (selected) selectRewind(selected.payload.turn_id as string, String(selected.payload.text))
  }
  return (
    <FilePreviewContext.Provider value={openFile}>
      <div className={cn(threadScreen, showEnvironment && threadScreenEnvOpen)}>
        <header className={threadHeader}>
          <FolderGit2 size={16} className="shrink-0" />
          <strong className={threadHeaderTitle}>{run.title}</strong>
          <button className={headerButton} title="Thread actions" aria-label="Thread actions">
            <MoreHorizontal size={18} />
          </button>
          <span className="flex-1" />
          <button className={openIn}>
            Open in <ChevronDown size={14} />
          </button>
          <button
            className={cn(environmentToggle, showEnvironment && environmentToggleActive)}
            onClick={() => setShowEnvironment((value) => !value)}
          >
            <Info size={15} />
            Environment
          </button>
        </header>
        <div
          className={cn(
            threadScroll,
            (filePreview.preview || selectedActivity) && threadScrollFilePreview,
          )}
          ref={scroll}
          onScroll={onScroll}
        >
          <VirtualTimeline
            items={displayItems}
            scrollRef={scroll}
            initialOffset={startAtEnd ? displayItems.length * virtualRowEstimate : savedTop}
            itemKey={(item) => (isActivityGroup(item) ? item.id : item.event_id)}
            before={
              !hasUserEvents ? <ConversationMessage author="user" text={run.prompt} /> : undefined
            }
            renderItem={(item) =>
              isActivityGroup(item) ? (
                <ToolActivityGroup
                  events={item.events}
                  selectedId={selectedActivity?.id ?? null}
                  onSelect={selectActivity}
                />
              ) : (
                <ThreadEvent
                  event={item}
                  run={run}
                  durationMs={durations.get(item.event_id)}
                  resolved={
                    item.payload.rpc_id !== undefined &&
                    resolvedRequests.has(String(item.payload.rpc_id))
                  }
                  canRewind={
                    Boolean(provider?.fork) &&
                    turnRewind &&
                    run.status === 'waiting_for_input' &&
                    queued.length === 0 &&
                    backtrackableEventIds.has(item.event_id)
                  }
                  onRewind={selectRewind}
                />
              )
            }
          />
        </div>
        {showEnvironment && (
          <EnvironmentPopover title="Environment" onClose={() => setShowEnvironment(false)}>
            <EnvironmentRow
              icon={<Terminal size={16} />}
              label="Provider"
              value={provider?.name || run.provider}
            />
            <EnvironmentRow
              icon={host?.type === 'ssh' ? <Globe2 size={16} /> : <Laptop size={16} />}
              label="Location"
              value={host?.name}
            />
            <EnvironmentRow icon={<FolderGit2 size={16} />} label="Project" value={project?.name} />
            <EnvironmentRow
              icon={<GitBranch size={16} />}
              label="Workspace"
              value={workspaceLabel}
            />
            <EnvironmentRow icon={<Folder size={16} />} label="Path" value={run.cwd} />
            <TmuxDetails
              name={run.tmuxName}
              command={run.tmuxAccessCommand}
              hostCommand={run.tmuxHostAccessCommand}
            />
            <div className={environmentActions}>
              <button onClick={() => api.openPath(run.hostId, run.cwd)}>Open folder</button>
              {run.worktreeId && !active.has(run.status) && (
                <>
                  <button
                    className={environmentActionButton}
                    onClick={async () => {
                      try {
                        const status = await api.worktreeStatus(run.hostId, run.worktreeId!)
                        setDialog({
                          kind: 'message',
                          title: 'Worktree changes',
                          body: `${status.summary}\n\n${status.diff_stat}`,
                        })
                      } catch (cause) {
                        onError(cause instanceof Error ? cause.message : String(cause))
                      }
                    }}
                  >
                    Inspect changes
                  </button>
                  <button
                    className={environmentActionButton}
                    disabled={worktreeBusy}
                    onClick={() => void mergeManagedWorktree()}
                  >
                    <GitMerge size={12} />
                    {worktreeBusy ? 'Merging…' : 'Merge'}
                  </button>
                  <button
                    className={cn(environmentActionButton, environmentActionDanger)}
                    onClick={async () => {
                      try {
                        const status = await api.worktreeStatus(run.hostId, run.worktreeId!)
                        setDialog({
                          kind: 'confirm',
                          title: status.dirty ? 'Force remove worktree?' : 'Remove worktree?',
                          body: status.dirty
                            ? 'This worktree has uncommitted changes that will be lost.'
                            : undefined,
                          confirmLabel: 'Remove',
                          danger: true,
                          action: () =>
                            api.removeWorktree(run.hostId, run.worktreeId!, status.dirty),
                        })
                      } catch (cause) {
                        onError(cause instanceof Error ? cause.message : String(cause))
                      }
                    }}
                  >
                    Remove worktree
                  </button>
                </>
              )}
            </div>
            {host?.status !== 'online' && (
              <p>
                <WifiOff size={13} />
                Viewer reconnecting; run remains on host.
              </p>
            )}
          </EnvironmentPopover>
        )}
        {selectedActivity && (
          <ActivityInspectorPanel
            entry={selectedActivity}
            hostId={run.hostId}
            cwd={run.cwd}
            onClose={() => setSelectedActivityId(null)}
          />
        )}
        {!selectedActivity && filePreview.preview && (
          <FilePreviewPanel state={filePreview.preview} onClose={filePreview.close} />
        )}
        <ComposerFrame
          className={cn(
            threadComposer,
            (filePreview.preview || selectedActivity) && threadComposerFilePreview,
            commandSuggestions.length > 0 && threadComposerMenuOpen,
          )}
          onSubmit={send}
        >
          <SlashCommandMenu
            suggestions={commandSuggestions}
            selected={selectedCommandIndex}
            onSelect={setCommandIndex}
            onChoose={chooseCommand}
          />
          {queued.length > 0 && (
            <div className={queuePanel}>
              <header className={queueHeader}>
                <ListPlus size={13} className="shrink-0" />
                <strong className="flex-1">{queued.length} queued</strong>
                {run.status === 'waiting_for_input' && !tmuxRun && (
                  <button
                    type="button"
                    className={queueHeaderButton}
                    onClick={() => api.startQueued(run.hostId, run.id)}
                  >
                    Run next
                  </button>
                )}
              </header>
              {queued.map((item) => (
                <div className={cn(queueRow, item.error && queueRowFailed)} key={item.id}>
                  <span className="min-w-0 flex-1 truncate" title={item.error || item.message}>
                    {item.message}
                    {item.error ? ' · failed to start' : ''}
                  </span>
                  <button
                    type="button"
                    className={queueRowButton}
                    title="Remove queued prompt"
                    onClick={() => api.removeQueued(run.hostId, run.id, item.id)}
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
          {rewind && (
            <div className={rewindBanner}>
              <Pencil size={13} />
              Editing previous message · sending creates a branch
              <button
                type="button"
                className="ml-auto grid place-items-center text-current/70 hover:text-current"
                title="Cancel editing previous message"
                aria-label="Cancel editing previous message"
                onClick={() => {
                  setRewind(null)
                  setMessage('')
                }}
              >
                <X size={13} />
              </button>
            </div>
          )}
          <ComposerInput
            className={composerTextarea}
            ref={composerInput}
            disabled={
              sending ||
              (active.has(run.status)
                ? !canUseAttachedSession
                : !(run.sessionId && provider?.resume))
            }
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={handleComposerKeyDown}
            placeholder={
              tmuxRun
                ? 'Steer now · Tab queues after this turn'
                : active.has(run.status)
                  ? run.status === 'waiting_for_input'
                    ? queued.length
                      ? 'Run or remove queued prompts before editing history'
                      : 'Continue this thread · edit a message above or press Esc Esc'
                    : ui.activeInput === 'queue'
                      ? `Queue for after this ${providerName(run.provider)} turn`
                      : provider?.live_input
                        ? 'Steer this turn'
                        : 'Live steering is not available for this provider'
                  : run.sessionId && provider?.resume
                    ? 'Continue this session'
                    : 'This provider session cannot be resumed'
            }
          />
          <ComposerFooter className={composerBar}>
            <button
              type="button"
              className="grid shrink-0 place-items-center text-muted hover:text-fg"
              aria-label="Add attachment"
              title="Attachments are not supported yet"
              disabled
            >
              <Plus size={18} />
            </button>
            {turnRunning && (
              <button
                type="button"
                className={interrupt}
                onClick={() => api.controlRun(run.hostId, run.id, 'interrupt')}
              >
                <Square size={14} />
                Interrupt
              </button>
            )}
            {queuedInput && turnRunning && (
              <button
                type="button"
                className={queueLabel}
                disabled={!message.trim() || sending}
                onClick={queue}
              >
                <ListPlus size={14} />
                Queue
              </button>
            )}
            {tmuxRun && (
              <span className={deliveryMode}>
                <Send size={13} />
                Enter · Steer
              </span>
            )}
            {ui.closeAttached && run.status === 'waiting_for_input' && (
              <button
                type="button"
                className={interrupt}
                onClick={() =>
                  setDialog({
                    kind: 'confirm',
                    title: `Close this attached ${providerName(run.provider)} session?`,
                    confirmLabel: 'Close session',
                    danger: true,
                    action: () => api.controlRun(run.hostId, run.id, 'terminate'),
                  })
                }
              >
                <Square size={14} />
                Close
              </button>
            )}
            {run.status === 'interrupting' && (
              <>
                <button
                  type="button"
                  className={interrupt}
                  onClick={() => api.controlRun(run.hostId, run.id, 'terminate')}
                >
                  Terminate
                </button>
                <button
                  type="button"
                  className={interrupt}
                  onClick={() =>
                    setDialog({
                      kind: 'confirm',
                      title: 'Force kill the full process group?',
                      confirmLabel: 'Kill',
                      danger: true,
                      action: () => api.controlRun(run.hostId, run.id, 'kill'),
                    })
                  }
                >
                  Kill
                </button>
              </>
            )}
            <span className="flex-1" />
            <small className={composerHint}>
              {run.provider === 'kiro'
                ? [commandContext.currentModel || run.model || 'Kiro', commandContext.currentEffort]
                    .filter(Boolean)
                    .join(' · ')
                : tmuxRun
                  ? run.tmuxName
                  : run.model || provider?.name}
            </small>
            {!active.has(run.status) && run.sessionId && provider?.fork && (
              <button
                type="button"
                disabled={sending || !message.trim()}
                onClick={() => void sendPrompt('fork')}
              >
                Fork
              </button>
            )}
            <button
              className={sendButton}
              aria-label="Send message"
              disabled={
                sending ||
                !message.trim() ||
                (active.has(run.status)
                  ? !canUseAttachedSession
                  : !(run.sessionId && provider?.resume))
              }
            >
              {sending ? (
                <RefreshCw className="animate-spin" size={15} />
              ) : rewind ? (
                <GitBranch size={16} />
              ) : (
                <Send size={17} />
              )}
            </button>
          </ComposerFooter>
        </ComposerFrame>
        {dialog && (
          <ConfirmDialog
            request={dialog}
            onClose={() => setDialog((current) => (current === dialog ? null : current))}
            onError={onError}
          />
        )}
      </div>
    </FilePreviewContext.Provider>
  )
}
