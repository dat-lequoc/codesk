import { useLatest } from '../../hooks/useLatest'
import { useExternalQueuePoller } from '../../hooks/useExternalQueuePoller'
import { cn } from '../../lib/cn'
import { threadColumn } from '../thread/thread-column'
import { threadStatus, turnBoundary, turnRule } from '../thread/thread-styles'
import {
  composerBar,
  composerHint,
  composerTextarea,
  deliveryMode,
  deliveryModeQueue,
  emptyState,
  environmentToggle,
  environmentToggleActive,
  headerButton,
  historyNotice,
  historyScroll,
  historyScrollContinuable,
  historyTextarea,
  observedBadge,
  queuePanel,
  sendButton,
  sendButtonSmall,
  threadComposer,
  threadComposerFilePreview,
  threadComposerMenuOpen,
  threadHeader,
  threadScreen,
  threadScreenEnvOpen,
  threadScroll,
  threadScrollFilePreview,
  tmuxNotice,
  tmuxNoticeButton,
} from './screen-styles'
import { FilePreviewContext } from '../../hooks/useFilePreview'
import type { KeyboardEvent } from 'react'
import { Globe2, MoreHorizontal } from 'lucide-react'
import {
  FolderGit2,
  Info,
  Laptop,
  ListPlus,
  Plug,
  Plus,
  RefreshCw,
  Send,
  Terminal,
  WifiOff,
  X,
} from 'lucide-react'
import { api } from '../../api'
import { Spinner } from '../../components/ui/spinner'
import { useFilePreview } from '../../hooks/useFilePreview'
import { usePersistentComposerDraft } from '../../hooks/usePersistentComposerDraft'
import {
  historicalActivityItems,
  historicalTimelineItems,
  isHistoricalActivity,
} from '../../lib/activity'
import type { ActivityEntry } from '../../lib/activity'
import { durationLabel } from '../../lib/format'
import {
  kiroCommandContext,
  kiroModelCatalog,
  kiroSlashSuggestions,
  kiroSuggestionLimit,
} from '../../lib/kiro'
import type { SlashSuggestion } from '../../lib/kiro'
import { pendingQueue } from '../../lib/events'
import { sessionNotificationKey, threadScrollKeyForSession } from '../../lib/keys'
import { markSessionFinishSeen } from '../../lib/session-finish'
import { providerName } from '../../lib/providers'
import { ProviderIcon } from '../../components/ProviderIcon'
import type {
  ExternalQueuedInput,
  Host,
  Project,
  Provider,
  ProviderSession,
  Run,
  RunEvent,
  SessionMessage,
} from '../../types'
import { ActivityInspectorPanel, HistoricalActivityGroup } from '../activity/Activity'
import {
  ComposerFooter,
  ComposerFrame,
  ComposerInput,
  SlashCommandMenu,
} from '../composer/Composer'
import { FilePreviewPanel } from '../dialogs/FilePreviewPanel'
import { EnvironmentPopover, EnvironmentRow, TmuxDetails } from '../environment/Environment'
import { ConversationMessage } from '../thread/Markdown'
import { UsageCard } from '../thread/ThreadEvent'
import { VirtualTimeline, virtualRowEstimate } from '../thread/VirtualTimeline'
import { useThreadScroll } from '../../hooks/useThreadScroll'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
export function SessionScreen({
  session,
  messages,
  messagesLoaded = false,
  runEvents,
  project,
  host,
  provider,
  onStarted,
  onError,
}: {
  session: ProviderSession
  messages: SessionMessage[]
  /// Whether the first fetch for this conversation has completed; separates
  /// "still loading" from "loaded and genuinely empty".
  messagesLoaded?: boolean
  runEvents: RunEvent[]
  project?: Project
  host?: Host
  provider?: Provider
  onStarted: (run: Run) => void
  onError: (message: string) => void
}) {
  const [showEnvironment, setShowEnvironment] = useState(false)
  const [selectedActivityId, setSelectedActivityId] = useState<string | null>(null)
  const [message, setMessage] = usePersistentComposerDraft(
    `session:${session.hostId}:${session.provider}:${session.nativeSessionId}`,
  )
  const [busy, setBusy] = useState(false)
  const [controlBusy, setControlBusy] = useState<'adopt' | 'move' | null>(null)
  const [moving, setMoving] = useState(false)
  // Adjust during render instead of in an effect: the move finished the moment
  // the session reports a tmux name, and an effect would paint the stale
  // "Moving to tmux" banner for one extra frame.
  if (moving && (session.tmuxName || session.tmuxControlled)) setMoving(false)
  const [queued, setQueued] = useState<ExternalQueuedInput[]>([])
  const hasQueued = queued.length > 0
  // Managed runs persist the queue on the run journal, not the external-session
  // table. Without this the composer clears and nothing on the thread explains
  // that the next prompt is waiting — which is what "Queue does nothing" looks
  // like while Claude is compacting or otherwise busy.
  const managedQueued = useMemo(() => pendingQueue(runEvents), [runEvents])
  const onStartedRef = useLatest(onStarted)
  const submitting = useRef(false)
  const composerInput = useRef<HTMLTextAreaElement>(null)
  const [commandIndex, setCommandIndex] = useState(0)
  const adoptedRun = useRef<string | null>(null)
  const filePreview = useFilePreview(session.hostId, session.cwd)
  const timeline = useMemo(() => historicalTimelineItems(messages), [messages])
  // Terminal-only commands such as /usage never reach the transcript; Codesk
  // reports them as run events on the backing managed run.
  const latestUsage = useMemo(
    () => runEvents.filter((event) => event.kind === 'usage.updated').at(-1) || null,
    [runEvents],
  )
  const activityEntries = timeline.flatMap((item) =>
    isHistoricalActivity(item)
      ? historicalActivityItems(item.messages).flatMap((activity) =>
          activity.type === 'entry' ? [activity.entry] : [],
        )
      : [],
  )
  const selectedActivity = selectedActivityId
    ? activityEntries.find((entry) => entry.id === selectedActivityId) || null
    : null
  const attached = Boolean(session.pid)
  const queuePid = session.pid || queued[0]?.pid
  const canUseAttachedSession =
    attached &&
    host?.status === 'online' &&
    session.inputTransport === 'tmux' &&
    session.tmuxControlled === true
  // A live pane that is not adopted yet still has a name. Sending should take
  // control and deliver, instead of hiding Queue/Resume behind Enable control.
  const canAdoptAndSend =
    attached &&
    host?.status === 'online' &&
    Boolean(session.tmuxName) &&
    session.tmuxControlled !== true
  const canResume =
    !attached &&
    session.status !== 'running' &&
    host?.status === 'online' &&
    provider?.available === true &&
    provider.resume
  const canQueue = canUseAttachedSession || canAdoptAndSend
  const canSend = canUseAttachedSession || canAdoptAndSend || canResume
  const [models, setModels] = useState(() => kiroModelCatalog.get(session.hostId) || [])
  const modelsRequested = useRef(false)
  // A terminal-driven session reports its live model and effort on the harness
  // status line, which is more current than anything replayed from events.
  const commandContext = useMemo(() => {
    const base = kiroCommandContext(runEvents)
    return {
      ...base,
      models: models.length ? models : base.models,
      currentModel: session.model || base.currentModel,
      currentEffort: session.effort || base.currentEffort,
      modelsPending: session.provider === 'kiro' && Boolean(session.managedRunId),
    }
  }, [runEvents, models, session.model, session.effort, session.provider, session.managedRunId])
  // Kiro exposes no non-interactive model listing, so the catalog is read from
  // its picker the first time the operator actually asks for `/model`.
  useEffect(() => {
    if (session.provider !== 'kiro' || !session.managedRunId || !canUseAttachedSession) return
    if (
      models.length ||
      modelsRequested.current ||
      !message.trimStart().toLowerCase().startsWith('/model')
    )
      return
    modelsRequested.current = true
    api
      .providerModels(session.hostId, session.managedRunId)
      .then((result) => {
        const catalog = result.models.map((model) => ({
          id: model.id,
          description: model.description || '',
        }))
        if (!catalog.length) return
        kiroModelCatalog.set(session.hostId, catalog)
        setModels(catalog)
      })
      .catch(() => {
        modelsRequested.current = false
      })
  }, [
    message,
    session.provider,
    session.managedRunId,
    session.hostId,
    canUseAttachedSession,
    models.length,
  ])
  const commandSuggestions = useMemo(
    () =>
      session.provider === 'kiro'
        ? kiroSlashSuggestions(message, commandContext).slice(0, kiroSuggestionLimit(message))
        : [],
    [session.provider, message, commandContext],
  )
  const selectedCommandIndex = Math.min(commandIndex, Math.max(0, commandSuggestions.length - 1))
  const chooseCommand = (suggestion: SlashSuggestion) => {
    setMessage(suggestion.value)
    requestAnimationFrame(() => composerInput.current?.focus())
  }
  const submitMessage = async (mode: 'steer' | 'queue' = 'steer') => {
    const prompt = message.trim()
    if (!prompt || !canSend || submitting.current) return
    submitting.current = true
    setBusy(true)
    try {
      if (canUseAttachedSession || canAdoptAndSend) {
        if (canAdoptAndSend) await api.adoptExternalTmux(session)
        // A session backed by a Codesk-managed run must go through the run
        // input API; the external-session path refuses managed writers.
        if (session.managedRunId) {
          await api.input(session.hostId, session.managedRunId, prompt, mode)
          setMessage('')
        } else {
          const result = await api.externalSessionInput(session, prompt, mode)
          if (result.queued)
            setQueued((items) => [
              ...items.filter((item) => item.id !== result.queued!.id),
              result.queued!,
            ])
          setMessage('')
          if (result.run) onStarted(result.run)
        }
      } else {
        const run = await api.resumeSession(session, prompt)
        setMessage('')
        onStarted(run)
      }
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }
  const continueSession = (event: FormEvent) => {
    event.preventDefault()
    void submitMessage()
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
    if (event.key === 'Tab' && canQueue) {
      event.preventDefault()
      void submitMessage('queue')
      return
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void submitMessage()
    }
  }
  // Typing past a slash command drops the highlight back to the first match.
  const [commandIndexFor, setCommandIndexFor] = useState(message)
  if (commandIndexFor !== message) {
    setCommandIndexFor(message)
    setCommandIndex(0)
  }
  useEffect(() => {
    if (!session.pid || !canUseAttachedSession || host?.status !== 'online') return
    let cancelled = false
    api
      .externalSessionQueue(session.hostId, session.pid)
      .then((items) => {
        if (cancelled) return
        const started = items.find((item) => item.status === 'started' && item.run)
        if (started?.run && adoptedRun.current !== started.run.id) {
          adoptedRun.current = started.run.id
          void api.removeExternalQueued(session.hostId, session.pid!, started.id).catch(() => {})
          onStartedRef.current(started.run)
          return
        }
        setQueued(items)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [session.hostId, session.pid, host?.status, canUseAttachedSession, onStartedRef])
  // Adopting the same started run twice would fork the selection; the ref
  // remembers what was already handed to onStarted across poll cycles.
  const handleQueueStarted = useLatest((run: Run) => {
    if (adoptedRun.current === run.id) return false
    adoptedRun.current = run.id
    onStartedRef.current(run)
    return true
  })
  useExternalQueuePoller({
    hostId: session.hostId,
    pid: queuePid,
    enabled: hasQueued && host?.status === 'online',
    handleStarted: handleQueueStarted,
    setQueued,
  })
  // Streaming updates the last message in place without changing the count, so
  // follow-bottom keys on the tail's identity and content, not just length.
  const lastMessage = messages.at(-1)
  const followKey = `${messages.length}:${lastMessage?.id ?? ''}:${lastMessage?.text?.length ?? 0}:${session.status}`
  const { scroll, onScroll, startAtEnd, savedTop } = useThreadScroll(
    threadScrollKeyForSession(session),
    followKey,
    {
      ready: messages.length > 0 || messagesLoaded,
      onAtEnd: () => {
        if (session.status === 'running') return
        markSessionFinishSeen(sessionNotificationKey(session))
      },
    },
  )
  const openFile = (href: string) => {
    setSelectedActivityId(null)
    filePreview.open(href)
  }
  const selectActivity = (entry: ActivityEntry) => {
    filePreview.close()
    setShowEnvironment(false)
    setSelectedActivityId(entry.id)
  }
  return (
    <FilePreviewContext.Provider value={openFile}>
      <div className={cn(threadScreen, showEnvironment && threadScreenEnvOpen)}>
        <header className={threadHeader}>
          <ProviderIcon provider={session.provider} />
          <strong>{session.title}</strong>
          {session.status === 'running' && (
            <span className={observedBadge}>
              <Spinner />
              Running
            </span>
          )}
          <span className="flex-1" />
          <button className={headerButton} title="Thread actions" aria-label="Thread actions">
            <MoreHorizontal size={18} />
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
            canSend ? historyScrollContinuable : historyScroll,
            (filePreview.preview || selectedActivity) && threadScrollFilePreview,
          )}
          ref={scroll}
          onScroll={onScroll}
        >
          {messages.length ? (
            <VirtualTimeline
              items={timeline}
              scrollRef={scroll}
              initialOffset={startAtEnd ? timeline.length * virtualRowEstimate : savedTop}
              itemKey={(item) => item.id}
              renderItem={(item) =>
                isHistoricalActivity(item) ? (
                  <HistoricalActivityGroup
                    messages={item.messages}
                    selectedId={selectedActivity?.id ?? null}
                    onSelect={selectActivity}
                  />
                ) : item.kind === 'turn_completed' ? (
                  <div className={turnBoundary}>
                    <span className={turnRule} />
                    {item.duration_ms !== undefined
                      ? `Worked for ${durationLabel(item.duration_ms)}`
                      : 'Turn completed'}
                    <span className={turnRule} />
                  </div>
                ) : (
                  <ConversationMessage author={item.role} text={item.text} />
                )
              }
            />
          ) : (
            <div className={threadColumn}>
              {host?.status !== 'online' ? (
                <div className={emptyState}>
                  <WifiOff size={20} className="mx-auto text-dim" />
                  <strong className="mt-3 mb-1.5 block text-sm text-fg-soft">
                    {host?.name || 'This host'} is offline
                  </strong>
                  <p className="m-0 text-[11px] leading-relaxed">
                    The project and conversation remain in navigation. Messages will load when the
                    host reconnects.
                  </p>
                </div>
              ) : messagesLoaded ? (
                <div className={emptyState}>
                  <strong className="mt-3 mb-1.5 block text-sm text-fg-soft">
                    No messages yet
                  </strong>
                  <p className="m-0 text-[11px] leading-relaxed">
                    This conversation has no transcript entries. Send a prompt below to start one.
                  </p>
                </div>
              ) : (
                <div className={threadStatus}>
                  <RefreshCw className="animate-spin" size={13} />
                  Loading conversation
                </div>
              )}
            </div>
          )}
          {latestUsage && (
            <div className={threadColumn}>
              <UsageCard event={latestUsage} />
            </div>
          )}
        </div>
        {showEnvironment && (
          <EnvironmentPopover title="Environment" onClose={() => setShowEnvironment(false)}>
            <EnvironmentRow
              icon={<ProviderIcon provider={session.provider} />}
              label="Provider"
              value={providerName(session.provider)}
            />
            <EnvironmentRow
              icon={host?.type === 'ssh' ? <Globe2 size={16} /> : <Laptop size={16} />}
              label="Location"
              value={host?.name}
            />
            <EnvironmentRow icon={<FolderGit2 size={16} />} label="Project" value={project?.name} />
            <TmuxDetails
              name={session.tmuxName}
              command={session.tmuxAccessCommand}
              hostCommand={session.tmuxHostAccessCommand}
              // A dormant transcript has no pane because its process exited,
              // not because detection failed — and there is nothing to move
              // into tmux, which is what "Not detected" invites you to try.
              emptyLabel={!attached && host?.status === 'online' ? 'No live process' : undefined}
              note={
                !attached && canResume ? 'Sending resumes this conversation' : undefined
              }
            />
          </EnvironmentPopover>
        )}
        {selectedActivity && (
          <ActivityInspectorPanel
            entry={selectedActivity}
            hostId={session.hostId}
            cwd={session.cwd}
            onClose={() => setSelectedActivityId(null)}
          />
        )}
        {!selectedActivity && filePreview.preview && (
          <FilePreviewPanel state={filePreview.preview} onClose={filePreview.close} />
        )}
        {attached && !canUseAttachedSession && host?.status === 'online' && (
          <div className={tmuxNotice}>
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <Terminal size={16} className="shrink-0 text-grass-400" />
              <span className="flex min-w-0 flex-col gap-0.5">
                <strong className="text-[11px] font-semibold">
                  {session.tmuxName
                    ? 'tmux session detected'
                    : moving
                      ? 'Moving to tmux'
                      : 'Terminal session'}
                </strong>
                <small className="text-[9.5px] leading-tight text-muted">
                  {session.tmuxName
                    ? 'Enable control to steer now or queue the next turn.'
                    : moving
                      ? 'Codesk will switch after the active turn becomes idle.'
                      : 'Move this session to tmux to enable safe Steer and Queue input.'}
                </small>
              </span>
            </div>
            <div className="min-w-0 max-w-[42%] flex-1">
              <TmuxDetails name={session.tmuxName} command={session.tmuxAccessCommand} />
            </div>
            <button
              type="button"
              className={tmuxNoticeButton}
              disabled={Boolean(controlBusy) || moving}
              onClick={async () => {
                if (!session.pid) return
                const action = session.tmuxName ? 'adopt' : 'move'
                setControlBusy(action)
                try {
                  if (action === 'adopt') await api.adoptExternalTmux(session)
                  else {
                    await api.moveExternalToTmux(session)
                    setMoving(true)
                  }
                } catch (cause) {
                  onError(cause instanceof Error ? cause.message : String(cause))
                } finally {
                  setControlBusy(null)
                }
              }}
            >
              {controlBusy ? (
                <RefreshCw className="animate-spin" size={14} />
              ) : session.tmuxName ? (
                <Plug size={14} />
              ) : (
                <Terminal size={14} />
              )}
              {session.tmuxName ? 'Enable control' : moving ? 'Waiting for idle' : 'Move to tmux'}
            </button>
          </div>
        )}
        {canSend ? (
          <ComposerFrame
            className={cn(
              threadComposer,
              'bottom-3',
              (filePreview.preview || selectedActivity) && threadComposerFilePreview,
              commandSuggestions.length > 0 && threadComposerMenuOpen,
            )}
            onSubmit={continueSession}
          >
            <SlashCommandMenu
              suggestions={commandSuggestions}
              selected={selectedCommandIndex}
              onSelect={setCommandIndex}
              onChoose={chooseCommand}
            />
            {(session.managedRunId ? managedQueued.length > 0 : queued.length > 0) && (
              <div className={queuePanel}>
                <header>
                  <ListPlus size={13} />
                  <strong>
                    {session.managedRunId
                      ? managedQueued.length
                      : queued.filter(
                          (item) => item.status === 'queued' || item.status === 'sending',
                        ).length}{' '}
                    queued
                  </strong>
                </header>
                {(session.managedRunId
                  ? managedQueued.map((item) => ({
                      id: item.id,
                      message: item.message,
                      status: item.error ? 'failed' : 'queued',
                      error: item.error,
                    }))
                  : queued
                ).map((item) => (
                  <div key={item.id} className={item.status === 'failed' ? 'failed' : ''}>
                    <span title={item.error || item.message}>
                      {item.message}
                      {item.status === 'sending'
                        ? ' · sending'
                        : item.status === 'queued'
                          ? ' · after this turn'
                          : item.error
                            ? ` · ${item.error}`
                            : ''}
                    </span>
                    {(session.managedRunId || queuePid) && (
                      <button
                        type="button"
                        title="Remove queued prompt"
                        onClick={async () => {
                          if (session.managedRunId) {
                            await api.removeQueued(session.hostId, session.managedRunId, item.id)
                            return
                          }
                          if (!queuePid) return
                          await api.removeExternalQueued(session.hostId, queuePid, item.id)
                          setQueued((items) =>
                            items.filter((candidate) => candidate.id !== item.id),
                          )
                        }}
                      >
                        <X size={12} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
            <ComposerInput
              className={cn(composerTextarea, historyTextarea)}
              ref={composerInput}
              disabled={busy}
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={handleComposerKeyDown}
              placeholder={
                canQueue
                  ? `Steer this ${providerName(session.provider)} session`
                  : `Continue this ${providerName(session.provider)} conversation`
              }
            />
            <ComposerFooter className={composerBar}>
              <button
                type="button"
                className="grid shrink-0 place-items-center text-muted hover:text-fg"
                aria-label="Add attachment"
              >
                <Plus size={18} />
              </button>
              {canQueue && (
                <>
                  <span className={deliveryMode}>
                    <Send size={13} />
                    Enter · Steer
                  </span>
                  <button
                    type="button"
                    className={cn(deliveryMode, deliveryModeQueue)}
                    disabled={!message.trim() || busy}
                    onClick={() => void submitMessage('queue')}
                  >
                    <ListPlus size={13} />
                    Queue
                  </button>
                </>
              )}
              <span className="flex-1" />
              <small className={composerHint}>
                {canQueue
                  ? [commandContext.currentModel, commandContext.currentEffort]
                      .filter(Boolean)
                      .join(' · ') || session.tmuxName
                  : provider?.name}
              </small>
              <button
                type="submit"
                className={cn(
                  sendButton,
                  sendButtonSmall,
                  canResume && 'w-auto gap-1.5 px-2.5',
                )}
                aria-label={canResume ? 'Resume conversation' : 'Send message'}
                disabled={!message.trim() || busy}
                title={
                  canQueue ? 'Steer now (Tab queues instead)' : 'Continue conversation'
                }
              >
                {busy ? <RefreshCw className="animate-spin" size={15} /> : <Send size={17} />}
                {canResume ? 'Resume' : null}
              </button>
            </ComposerFooter>
          </ComposerFrame>
        ) : (
          !attached && (
            <div className={historyNotice}>
              <Info size={14} className="shrink-0" />
              <span className="text-[10px] leading-relaxed">
                <strong className="mb-0.5 block text-[11px] text-fg-soft">
                  {host?.status !== 'online'
                    ? 'Host offline'
                    : provider && !provider.available
                      ? `${provider.name} unavailable`
                      : 'Continuation unavailable'}
                </strong>
                {host?.status !== 'online'
                  ? 'Reconnect the host to continue this conversation.'
                  : provider && !provider.available
                    ? `Install or reconnect ${provider.name} on this host to continue.`
                    : 'This provider does not expose a supported resume path for this session.'}
              </span>
            </div>
          )
        )}
      </div>
    </FilePreviewContext.Provider>
  )
}
