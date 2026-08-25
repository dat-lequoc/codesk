import { cn } from '../../lib/cn'
import {
  composerBar,
  composerHint,
  composerTextarea,
  deliveryMode,
  deliveryModeQueue,
  headerButton,
  historyTextarea,
  observedBadge,
  queuePanel,
  sendButton,
  sendButtonSmall,
  threadComposer,
  threadHeader,
  threadHeaderTitle,
  threadScreen,
} from './screen-styles'
import type { KeyboardEvent } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { ListPlus, RefreshCw, ScrollText, Send, Terminal } from 'lucide-react'
import { api } from '../../api'
import { useLatest } from '../../hooks/useLatest'
import { useExternalQueuePoller } from '../../hooks/useExternalQueuePoller'
import { usePersistentComposerDraft } from '../../hooks/usePersistentComposerDraft'
import { providerName } from '../../lib/providers'
import { observedAgentTitle } from '../../lib/observed'
import { ProviderIcon } from '../../components/ProviderIcon'
import type {
  DiscoveredAgent,
  ExternalQueuedInput,
  Host,
  Project,
  Provider,
  Run,
} from '../../types'
import {
  AttachmentButton,
  ComposerAttachmentsList,
  ComposerFooter,
  ComposerFrame,
  ComposerInput,
} from '../composer/Composer'
import { formatPromptWithAttachments, type ComposerAttachment } from '../../lib/attachments'
import { TmuxDetails } from '../environment/Environment'
import { useEffect, useRef, useState } from 'react'
export function ObservedScreen({
  host,
  project,
  agent,
  onStarted,
  onError,
}: {
  host?: Host
  project?: Project
  provider?: Provider
  agent: DiscoveredAgent
  onStarted: (run: Run) => void
  onError: (message: string) => void
}) {
  const [message, setMessage] = usePersistentComposerDraft(
    `agent:${host?.id || 'unknown'}:${agent.id}`,
  )
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  const [busy, setBusy] = useState(false)
  const [controlBusy, setControlBusy] = useState(false)
  const [moving, setMoving] = useState(false)
  // Adjust during render instead of in an effect: the move finished the moment
  // the agent reports a tmux session, and an effect would paint the stale
  // "Moving to tmux" state for one extra frame.
  if (moving && (agent.tmux_session_name || agent.tmux_controlled)) setMoving(false)
  const [queued, setQueued] = useState<ExternalQueuedInput[]>([])
  const [logOpen, setLogOpen] = useState(false)
  const [log, setLog] = useState<{ text: string; capturedAt: string } | null>(null)
  const [logError, setLogError] = useState('')
  const logRef = useRef<HTMLPreElement>(null)
  const hasQueued = queued.length > 0
  const hostId = host?.id
  const hostStatus = host?.status
  // `onStarted` is a fresh arrow on every parent render; the queue poller must
  // not resubscribe for it.
  const onStartedRef = useLatest(onStarted)
  const controlled = Boolean(agent.tmux_controlled && agent.tmux_pane_id)
  // Steering only needs an adopted tmux pane; queueing the next turn still
  // needs a project (queue items become runs).
  const canContinue = Boolean(agent.native_session_id && controlled)
  const canQueue = Boolean(project && canContinue)
  const hasPane = Boolean(agent.tmux_pane_id)
  useEffect(() => {
    if (!logOpen || !hostId || hostStatus !== 'online' || !hasPane) return
    let cancelled = false
    const load = async () => {
      try {
        const result = await api.externalAgentTmuxLog(hostId, agent.pid)
        if (cancelled) return
        setLog({ text: result.text.replace(/\s+$/, ''), capturedAt: result.captured_at })
        setLogError('')
      } catch (cause) {
        if (!cancelled) setLogError(cause instanceof Error ? cause.message : String(cause))
      }
    }
    void load()
    const timer = window.setInterval(() => void load(), 5000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [logOpen, hostId, hostStatus, hasPane, agent.pid])
  useEffect(() => {
    const element = logRef.current
    if (element) element.scrollTop = element.scrollHeight
  }, [log])
  const submit = async (delivery: 'steer' | 'queue' = 'steer') => {
    const prompt = formatPromptWithAttachments(message.trim(), attachments)
    if (!prompt || busy || host?.status !== 'online' || !canContinue) return
    if (delivery === 'queue' && !canQueue) return
    setBusy(true)
    try {
      const result = await api.externalAgentInput(
        host.id,
        project?.id ?? null,
        agent.pid,
        agent.native_session_id,
        prompt,
        delivery,
      )
      if (result.queued)
        setQueued((items) => [
          ...items.filter((item) => item.id !== result.queued!.id),
          result.queued!,
        ])
      setMessage('')
      setAttachments([])
      if (result.run) onStarted(result.run)
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Tab' && canQueue) {
      event.preventDefault()
      void submit('queue')
      return
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void submit()
    }
  }
  const handleQueueStarted = useLatest((run: Run) => {
    onStartedRef.current(run)
    return true
  })
  useExternalQueuePoller({
    hostId,
    pid: agent.pid,
    enabled: Boolean(controlled && hasQueued && hostStatus === 'online'),
    handleStarted: handleQueueStarted,
    setQueued,
  })
  return (
    <div className={threadScreen}>
      <header className={threadHeader}>
        <ProviderIcon provider={agent.provider} />
        <strong className={threadHeaderTitle}>{providerName(agent.provider)} session</strong>
        <span className={observedBadge}>Observed</span>
        <span className="flex-1" />
        <button className={headerButton} aria-label="Thread actions">
          <MoreHorizontal size={18} />
        </button>
      </header>
      <div className="mx-auto w-[min(720px,calc(100%-100px))] py-24">
        <div className="text-center [&>svg]:mx-auto [&>svg]:size-9 [&>svg]:text-fg-soft">
          <ProviderIcon provider={agent.provider} />
          <h1 className="mt-4 mb-2 text-2xl font-medium">{observedAgentTitle(agent)}</h1>
          <p className="mx-auto max-w-[490px] text-[13px] leading-relaxed text-muted">
            External process, not started by Codesk. Show the log to see what it is doing, or take
            control to steer it from here.
          </p>
          {controlled && (
            <p className="mx-auto mt-2 max-w-[490px] text-[13px] leading-relaxed text-muted">
              Control is on: Codesk can steer this tmux session directly and queue the next turn.
            </p>
          )}
        </div>
        <dl className="mx-auto mt-4 w-[min(650px,100%)] rounded-lg border border-line-strong bg-ink-700 px-3 py-2.5 text-left text-[12px]">
          <div className="flex gap-3 py-1">
            <dt className="w-[72px] shrink-0 text-dim">Folder</dt>
            <dd className="min-w-0 truncate text-fg-soft" title={agent.cwd || undefined}>
              {agent.cwd || 'unknown'}
            </dd>
          </div>
          <div className="flex gap-3 py-1">
            <dt className="w-[72px] shrink-0 text-dim">PID</dt>
            <dd className="text-fg-soft">{agent.pid}</dd>
          </div>
          <div className="flex gap-3 py-1">
            <dt className="w-[72px] shrink-0 text-dim">Command</dt>
            <dd className="min-w-0 break-all text-fg-soft">{agent.command}</dd>
          </div>
        </dl>
        {(agent.tmux_session_name || agent.tmux_access_command) && (
          <div className="mx-auto mt-2 w-[min(650px,100%)] rounded-lg border border-line-strong bg-ink-700 px-3 py-2.5">
            <TmuxDetails
              name={agent.tmux_session_name}
              command={agent.tmux_access_command}
              hostCommand={agent.tmux_host_access_command}
            />
          </div>
        )}
        <div className="mt-3 flex items-center justify-center gap-2">
          {agent.native_session_id && !controlled && (
            <button
              className="flex h-8 items-center gap-[7px] rounded-md border border-grass-600/70 bg-grass-600/25 px-3 text-[11px] text-grass-400 disabled:cursor-default disabled:opacity-55"
              type="button"
              disabled={controlBusy || moving}
              onClick={async () => {
                if (!host) return
                setControlBusy(true)
                try {
                  if (agent.tmux_session_name)
                    await api.adoptExternalAgentTmux(
                      host.id,
                      project?.id ?? null,
                      agent.pid,
                      agent.native_session_id,
                    )
                  else {
                    await api.moveExternalAgentToTmux(
                      host.id,
                      project?.id ?? null,
                      agent.pid,
                      agent.native_session_id,
                    )
                    setMoving(true)
                  }
                } catch (cause) {
                  onError(cause instanceof Error ? cause.message : String(cause))
                } finally {
                  setControlBusy(false)
                }
              }}
            >
              {controlBusy ? (
                <RefreshCw className="animate-spin" size={14} />
              ) : (
                <Terminal size={14} />
              )}
              {agent.tmux_session_name
                ? 'Take control'
                : moving
                  ? 'Waiting for idle'
                  : 'Move to tmux'}
            </button>
          )}
          {hasPane && (
            <button
              className="flex h-8 items-center gap-[7px] rounded-md border border-line-strong bg-ink-700 px-3 text-[11px] text-fg-soft hover:bg-ink-600"
              type="button"
              aria-expanded={logOpen}
              onClick={() => setLogOpen((value) => !value)}
            >
              <ScrollText size={14} />
              {logOpen ? 'Hide log' : 'Show log'}
            </button>
          )}
        </div>
        {logOpen && hasPane && (
          <div className="mx-auto mt-3 w-[min(650px,100%)] overflow-hidden rounded-lg border border-line-strong bg-ink-800">
            <header className="flex items-center gap-2 border-b border-line-strong px-3 py-1.5 text-[10.5px] text-dim">
              <ScrollText size={12} />
              <span className="flex-1">
                {agent.tmux_session_name || 'tmux'} · live capture, refreshes every 5s
              </span>
              {log && <span>{new Date(log.capturedAt).toLocaleTimeString()}</span>}
            </header>
            {logError ? (
              <p className="px-3 py-2 text-[11.5px] text-scarlet-400">{logError}</p>
            ) : (
              <pre
                ref={logRef}
                className="max-h-[320px] overflow-auto px-3 py-2 text-left font-mono text-[10.5px] leading-[1.5] whitespace-pre-wrap text-fg-soft"
              >
                {log ? log.text || '(the pane is empty)' : 'Capturing…'}
              </pre>
            )}
          </div>
        )}
      </div>
      {canContinue && (
        <ComposerFrame
          className={cn(threadComposer, 'bottom-3')}
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
          onAttach={(files) => setAttachments((prev) => [...prev, ...files])}
        >
          {queued.length > 0 && (
            <div className={queuePanel}>
              <header>
                <ListPlus size={13} />
                <strong>{queued.length} queued</strong>
              </header>
              {queued.map((item) => (
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
                </div>
              ))}
            </div>
          )}
          <ComposerInput
            className={cn(composerTextarea, historyTextarea)}
            disabled={busy || host?.status !== 'online'}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={keyDown}
            onAttach={(files) => setAttachments((prev) => [...prev, ...files])}
            placeholder={
              canQueue ? 'Steer this session · Tab queues after this turn' : 'Steer this session'
            }
          />
          <ComposerAttachmentsList
            attachments={attachments}
            onRemove={(id) => setAttachments((prev) => prev.filter((a) => a.id !== id))}
          />
          <ComposerFooter className={composerBar}>
            <AttachmentButton
              onAttach={(files) => setAttachments((prev) => [...prev, ...files])}
              disabled={busy || host?.status !== 'online'}
            />
            <span className={deliveryMode}>
              <Send size={13} />
              Enter · Steer
            </span>
            {canQueue && (
              <span className={cn(deliveryMode, deliveryModeQueue)}>
                <ListPlus size={13} />
                Tab · Queue
              </span>
            )}
            <span className="flex-1" />
            <small className={composerHint}>{agent.tmux_session_name}</small>
            <button
              className={cn(sendButton, sendButtonSmall)}
              aria-label="Send message"
              disabled={!message.trim() || busy || host?.status !== 'online'}
            >
              {busy ? <RefreshCw className="animate-spin" size={15} /> : <Send size={17} />}
            </button>
          </ComposerFooter>
        </ComposerFrame>
      )}
    </div>
  )
}
