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
import { ListPlus, Plus, RefreshCw, Send, Terminal } from 'lucide-react'
import { api } from '../../api'
import { Spinner } from '../../components/ui/spinner'
import { usePersistentComposerDraft } from '../../hooks/usePersistentComposerDraft'
import { providerIcon, providerName } from '../../providerRegistry'
import type {
  DiscoveredAgent,
  ExternalQueuedInput,
  Host,
  Project,
  Provider,
  Run,
} from '../../types'
import { ComposerFooter, ComposerFrame, ComposerInput } from '../composer/Composer'
import { TmuxDetails } from '../environment/Environment'
import { useEffect, useState } from 'react'
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
  const [busy, setBusy] = useState(false)
  const [controlBusy, setControlBusy] = useState(false)
  const [moving, setMoving] = useState(false)
  const [queued, setQueued] = useState<ExternalQueuedInput[]>([])
  const controlled = Boolean(agent.tmux_controlled && agent.tmux_pane_id)
  const canContinue = Boolean(project && agent.native_session_id && controlled)
  const submit = async (delivery: 'steer' | 'queue' = 'steer') => {
    const prompt = message.trim()
    if (!prompt || busy || host?.status !== 'online' || !project || !canContinue) return
    setBusy(true)
    try {
      const result = await api.externalAgentInput(
        host.id,
        project.id,
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
      if (result.run) onStarted(result.run)
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Tab' && controlled) {
      event.preventDefault()
      void submit('queue')
      return
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void submit()
    }
  }
  useEffect(() => {
    if (!host || !agent.pid || !controlled || queued.length === 0 || host.status !== 'online')
      return
    let stopped = false
    let timer = 0
    const poll = async () => {
      try {
        const items = await api.externalSessionQueue(host.id, agent.pid)
        if (stopped) return
        const started = items.find((item) => item.status === 'started' && item.run)
        if (started?.run) {
          void api.removeExternalQueued(host.id, agent.pid, started.id).catch(() => {})
          onStarted(started.run)
          return
        }
        setQueued(items)
      } catch {}
      if (!stopped && !document.hidden) timer = window.setTimeout(poll, 1000)
    }
    const visibility = () => {
      clearTimeout(timer)
      if (!document.hidden) void poll()
    }
    document.addEventListener('visibilitychange', visibility)
    timer = window.setTimeout(poll, 1000)
    return () => {
      stopped = true
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [host?.id, host?.status, agent.pid, queued.length > 0, controlled])
  return (
    <div className={threadScreen}>
      <header className={threadHeader}>
        {providerIcon(agent.provider)}
        <strong className={threadHeaderTitle}>{providerName(agent.provider)} session</strong>
        <span className={observedBadge}>
          <Spinner size={11} />
          Observed
        </span>
        <span className="flex-1" />
        <button className={headerButton} aria-label="Thread actions">
          <MoreHorizontal size={18} />
        </button>
      </header>
      <div className="mx-auto w-[min(720px,calc(100%-100px))] py-24">
        <div className="text-center [&>svg]:mx-auto [&>svg]:size-9 [&>svg]:text-fg-soft">
          {providerIcon(agent.provider)}
          <h1 className="mt-4 mb-2 text-2xl font-medium">
            {providerName(agent.provider)} is running
          </h1>
          <p className="mx-auto max-w-[490px] text-[13px] leading-relaxed text-muted">
            {controlled
              ? 'Codesk can steer this tmux session directly and queue the next turn.'
              : agent.tmux_session_name
                ? 'Codesk found this tmux session. Enable control to send input safely.'
                : 'Move this terminal session to tmux after its active turn becomes idle.'}
          </p>
        </div>
        <div className="mx-auto mt-4 w-[min(650px,100%)] rounded-lg border border-line-strong bg-ink-700 px-3 py-2.5">
          <TmuxDetails name={agent.tmux_session_name} command={agent.tmux_access_command} />
        </div>
        {project && agent.native_session_id && !controlled && (
          <button
            className="mx-auto mt-3 flex h-8 items-center gap-[7px] rounded-md border border-grass-600/70 bg-grass-600/25 px-3 text-[11px] text-grass-400 disabled:cursor-default disabled:opacity-55"
            type="button"
            disabled={controlBusy || moving}
            onClick={async () => {
              if (!host) return
              setControlBusy(true)
              try {
                if (agent.tmux_session_name)
                  await api.adoptExternalAgentTmux(
                    host.id,
                    project.id,
                    agent.pid,
                    agent.native_session_id,
                  )
                else {
                  await api.moveExternalAgentToTmux(
                    host.id,
                    project.id,
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
              ? 'Enable control'
              : moving
                ? 'Waiting for idle'
                : 'Move to tmux'}
          </button>
        )}
      </div>
      {canContinue && (
        <ComposerFrame
          className={cn(threadComposer, 'bottom-3')}
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
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
            placeholder="Steer this session · Tab queues after this turn"
          />
          <ComposerFooter className={composerBar}>
            <button
              type="button"
              className="grid shrink-0 place-items-center text-muted hover:text-fg"
              aria-label="Add attachment"
            >
              <Plus size={18} />
            </button>
            <span className={deliveryMode}>
              <Send size={13} />
              Enter · Steer
            </span>
            <span className={cn(deliveryMode, deliveryModeQueue)}>
              <ListPlus size={13} />
              Tab · Queue
            </span>
            <span className="flex-1" />
            <small className={composerHint}>{agent.tmux_session_name}</small>
            <button
              className={cn(sendButton, sendButtonSmall)}
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
