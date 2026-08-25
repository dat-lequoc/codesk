import { cn } from '../../lib/cn'
import {
  commandCode,
  commandHeader,
  commandPre,
  commandRow,
  reasoningSummary,
  requestActions,
  requestButton,
  requestCard,
  requestCardResolved,
  requestDecline,
  requestTitle,
  requestBody,
  rewindButton,
  rewindable,
  threadStatus,
  threadStatusCode,
  toolOutput,
  toolOutputCode,
  toolOutputFailed,
  turnBoundary,
  turnRule,
  usageCard,
  usageCell,
  usageGrid,
  usageHeader,
  usageLabel,
  usageNote,
  usageValue,
} from './thread-styles'
import {
  fileChangeCard,
  fileChangeHeader,
  fileChangeIcon,
  fileChangeList,
  fileChangePath,
  fileChangeRow,
  fileChangeRowButton,
} from './file-change-styles'
import { CheckCircle2 } from 'lucide-react'
import { Bot, Clock3, FileDiff, FolderOpen, Pencil, ShieldAlert, Terminal } from 'lucide-react'
import { memo, useState } from 'react'
import { api } from '../../api'
import { InputRequestDialog } from './InputRequestDialog'
import { activityText } from '../../lib/activity'
import { conversationText, durationLabel } from '../../lib/format'
import { providerName, providerUi } from '../../lib/providers'
import { ProviderIcon } from '../../components/ProviderIcon'
import type { ProviderSession, Run, RunEvent, SessionMessage } from '../../types'
import { FileChangeCard } from './FileChangeCard'
import { ConversationMessage, MarkdownContent } from './Markdown'
import { ContextInjectionCard } from './CleanDshConversation'
import { isContextInjectionMessage } from '../../lib/clean-dsh'
export function HistoricalOperationalEvent({
  message,
  session,
}: {
  message: SessionMessage
  session: ProviderSession
}) {
  const meta = message.meta || {}
  if (message.kind === 'reasoning')
    return (
      <div className={reasoningSummary}>
        <Bot size={13} />
        <MarkdownContent text={message.text} />
      </div>
    )
  if (message.kind === 'file_change') {
    const changes = meta.changes || []
    return (
      <section className={fileChangeCard}>
        <header className={cn(fileChangeHeader, 'min-h-[45px]')}>
          <span className={fileChangeIcon}>
            <FileDiff size={15} />
          </span>
          <div className="min-w-0 flex-1">
            <strong className="block text-[12.5px] font-semibold text-fg-soft">
              Edited {changes.length || 1} file{changes.length === 1 ? '' : 's'}
            </strong>
          </div>
        </header>
        {changes.length > 0 && (
          <div className={fileChangeList}>
            {changes.map((change, index) => (
              <div
                className={cn(fileChangeRow, 'min-h-[34px]')}
                key={`${change.path || 'file'}:${index}`}
              >
                <code className={fileChangePath} title={change.path}>
                  {change.path || 'Unknown file'}
                </code>
                <button
                  className={cn(fileChangeRowButton, 'opacity-100')}
                  title="Open file"
                  onClick={() =>
                    change.path &&
                    void api.openPath(
                      session.hostId,
                      change.path.startsWith('/')
                        ? change.path
                        : `${session.cwd.replace(/\/$/, '')}/${change.path}`,
                    )
                  }
                >
                  <FolderOpen size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    )
  }
  if (message.kind === 'tool') {
    const command = meta.command || ''
    const label = meta.display || meta.tool || command || 'Tool activity'
    const output = activityText(message.text || meta.output)
    return (
      <div className={commandRow}>
        <header className={commandHeader}>
          <Terminal size={13} className="shrink-0" />
          <code className={commandCode}>{activityText(label)}</code>
          {meta.status === 'failed' ? (
            <ShieldAlert size={13} className="shrink-0 text-scarlet-400" />
          ) : (
            <CheckCircle2 size={13} className="shrink-0 text-grass-400" />
          )}
        </header>
        {output && <pre className={commandPre}>{output}</pre>}
      </div>
    )
  }
  return (
    <div className={toolOutput}>
      <code className={toolOutputCode}>{activityText(meta.tool) || 'Tool output'}</code>
      {message.text && <pre className={commandPre}>{message.text}</pre>}
    </div>
  )
}

export function OperationalEvent({ event, run }: { event: RunEvent; run: Run }) {
  const raw = event.raw_payload as {
    method?: string
    params?: {
      command?: string
      item?: {
        type?: string
        command?: string
        changes?: Array<{ path?: string; kind?: string; diff?: string }>
      }
      update?: { title?: string; kind?: string; status?: string }
    }
  }
  const text = String(event.payload.text || '')
  const method = raw?.method || ''
  const item = raw?.params?.item
  if (event.kind === 'reasoning.message')
    return (
      <div className={reasoningSummary}>
        <Bot size={13} />
        <MarkdownContent text={text} />
      </div>
    )
  const payloadChanges = Array.isArray(event.payload.changes)
    ? (event.payload.changes as Array<{ path?: string; kind?: string; diff?: string }>)
    : []
  if (
    event.kind === 'file.change' ||
    method.includes('fileChange') ||
    item?.type === 'fileChange' ||
    payloadChanges.length > 0
  ) {
    return (
      <FileChangeCard
        changes={payloadChanges.length ? payloadChanges : item?.changes}
        text={text}
        run={run}
      />
    )
  }
  const command = String(
    event.payload.tool_title ||
      raw?.params?.update?.title ||
      raw?.params?.command ||
      item?.command ||
      (method.includes('commandExecution') ? text : ''),
  )
  const toolStatus = String(event.payload.tool_status || raw?.params?.update?.status || '')
  if (command)
    return (
      <div className={commandRow}>
        <header className={commandHeader}>
          <Terminal size={13} className="shrink-0" />
          <code className={commandCode}>{command}</code>
          {event.channel === 'stderr' || toolStatus === 'failed' ? (
            <ShieldAlert size={13} className="shrink-0 text-scarlet-400" />
          ) : toolStatus === 'in_progress' ? (
            <Clock3 size={13} className="shrink-0 text-muted" />
          ) : (
            <CheckCircle2 size={13} className="shrink-0 text-grass-400" />
          )}
        </header>
        {text && text !== command && <pre className={commandPre}>{text}</pre>}
      </div>
    )
  return (
    <div className={cn(toolOutput, event.channel === 'stderr' && toolOutputFailed)}>
      <code className={toolOutputCode}>{event.kind.replaceAll('.', ' ')}</code>
      {text && <pre className={commandPre}>{text}</pre>}
    </div>
  )
}

export function UsageCard({ event }: { event: RunEvent }) {
  const agy =
    event.provider_event_type?.startsWith('agy.') || event.payload.thinking_tokens !== undefined
  if (agy) {
    const input = Number(event.payload.input_tokens)
    const output = Number(event.payload.output_tokens)
    const thinking = Number(event.payload.thinking_tokens)
    const cacheRead = Number(event.payload.cache_read_tokens)
    const total = Number(event.payload.total_tokens)
    const duration = Number(event.payload.duration_seconds)
    const modelTokens = Number.isFinite(total)
      ? total
      : [input, output].filter(Number.isFinite).reduce((sum, value) => sum + value, 0)
    return (
      <section className={usageCard}>
        <header className={usageHeader}>
          <ProviderIcon provider="agy" size={14} />
          <strong className="text-xs font-semibold">Antigravity usage</strong>
          <span className="ml-auto text-[10px] text-grass-400/70">Turn result</span>
        </header>
        <div className={usageGrid}>
          <div className={usageCell}>
            <small className={usageLabel}>Tokens</small>
            <b className={usageValue}>{modelTokens.toLocaleString()} total tokens</b>
            <em className={usageNote}>
              {Number.isFinite(output) ? output.toLocaleString() : 0} output ·{' '}
              {Number.isFinite(thinking) ? thinking.toLocaleString() : 0} thinking
            </em>
          </div>
          <div className={usageCell}>
            <small className={usageLabel}>Cache & time</small>
            <b className={usageValue}>
              {Number.isFinite(cacheRead) ? cacheRead.toLocaleString() : 0} cached tokens
            </b>
            {Number.isFinite(duration) && (
              <em className={usageNote}>{duration.toFixed(2)} seconds</em>
            )}
          </div>
        </div>
      </section>
    )
  }
  const dsh =
    event.provider_event_type?.startsWith('dsh.') || event.payload.context_window !== undefined
  if (dsh) {
    const context = Number(event.payload.context_usage_percentage)
    const pressure = Number(event.payload.pressure_tokens)
    const projected = Number(event.payload.projected_tokens)
    const contextWindow = Number(event.payload.context_window)
    const input = Number(event.payload.uncached_input_tokens)
    const output = Number(event.payload.output_tokens)
    const cacheRead = Number(event.payload.cache_read_tokens)
    const cacheWrite = Number(event.payload.cache_write_tokens)
    const tokenTotal = [input, output]
      .filter(Number.isFinite)
      .reduce((total, value) => total + value, 0)
    const cacheTotal = [cacheRead, cacheWrite]
      .filter(Number.isFinite)
      .reduce((total, value) => total + value, 0)
    return (
      <section className={usageCard}>
        <header className={usageHeader}>
          <ProviderIcon provider="dsh" size={14} />
          <strong className="text-xs font-semibold">DeepSeek Harness usage</strong>
          <span className="ml-auto text-[10px] text-grass-400/70">Session snapshot</span>
        </header>
        <div className={usageGrid}>
          <div className={usageCell}>
            <small className={usageLabel}>Context</small>
            <b className={usageValue}>
              {Number.isFinite(context) ? `${context.toFixed(2)}%` : 'Unavailable'}
            </b>
            {contextWindow > 0 && (
              <em className={usageNote}>
                {(projected || pressure).toLocaleString()} / {contextWindow.toLocaleString()} tokens
              </em>
            )}
          </div>
          <div className={usageCell}>
            <small className={usageLabel}>Tokens</small>
            <b className={usageValue}>{tokenTotal.toLocaleString()} model tokens</b>
            <em className={usageNote}>{cacheTotal.toLocaleString()} cached tokens</em>
          </div>
        </div>
      </section>
    )
  }
  const context = Number(event.payload.context_usage_percentage)
  const size = Number(event.payload.context_size)
  const used = Number(event.payload.context_usage_percentage)
  const metering = Array.isArray(event.payload.metering_usage)
    ? (event.payload.metering_usage as Array<{
        value?: number
        unit?: string
        unitPlural?: string
      }>)
    : []
  const credits = metering
    .map(
      (item) =>
        `${Number(item.value || 0).toFixed(3)} ${item.unitPlural || item.unit || 'credits'}`,
    )
    .join(' + ')
  const plan = typeof event.payload.plan === 'string' ? event.payload.plan : null
  const resetsOn = typeof event.payload.resets_on === 'string' ? event.payload.resets_on : null
  const planPercent = Number(event.payload.plan_usage_percentage)
  const planIncluded = Number(event.payload.credits_included)
  const usageError = typeof event.payload.error === 'string' ? event.payload.error : null
  if (usageError)
    return (
      <section className={usageCard}>
        <header className={usageHeader}>
          <ProviderIcon provider="kiro" size={14} />
          <strong className="text-xs font-semibold">Kiro usage</strong>
          <span className="ml-auto text-[10px] text-grass-400/70">Unavailable</span>
        </header>
        <div className={usageGrid}>
          <div className={usageCell}>
            <small className={usageLabel}>Result</small>
            <b className={usageValue}>No usage reported</b>
            <em className={usageNote}>{usageError}</em>
          </div>
        </div>
      </section>
    )
  if (plan || Number.isFinite(planPercent)) {
    return (
      <section className={usageCard}>
        <header className={usageHeader}>
          <ProviderIcon provider="kiro" size={14} />
          <strong className="text-xs font-semibold">Kiro usage</strong>
          <span className="ml-auto text-[10px] text-grass-400/70">{plan || 'Plan snapshot'}</span>
        </header>
        <div className={usageGrid}>
          <div className={usageCell}>
            <small className={usageLabel}>Plan credits</small>
            <b className={usageValue}>{credits || 'No credit data yet'}</b>
            {planIncluded > 0 && (
              <em className={usageNote}>of {planIncluded.toLocaleString()} covered in plan</em>
            )}
          </div>
          <div className={usageCell}>
            <small className={usageLabel}>Plan used</small>
            <b className={usageValue}>
              {Number.isFinite(planPercent) ? `${planPercent.toFixed(1)}%` : 'Unavailable'}
            </b>
            {resetsOn && <em className={usageNote}>resets on {resetsOn}</em>}
          </div>
        </div>
      </section>
    )
  }
  return (
    <section className={usageCard}>
      <header className={usageHeader}>
        <ProviderIcon provider="kiro" size={14} />
        <strong className="text-xs font-semibold">Kiro usage</strong>
        <span className="ml-auto text-[10px] text-grass-400/70">Session snapshot</span>
      </header>
      <div className={usageGrid}>
        <div className={usageCell}>
          <small className={usageLabel}>Context</small>
          <b className={usageValue}>
            {Number.isFinite(context) ? `${context.toFixed(1)}%` : 'Unavailable'}
          </b>
          {size > 0 && <em className={usageNote}>{size.toLocaleString()} tokens</em>}
        </div>
        <div className={usageCell}>
          <small className={usageLabel}>Metering</small>
          <b className={usageValue}>{credits || 'No credit data yet'}</b>
          {used > 0 && <em className={usageNote}>{used.toFixed(1)}% context used</em>}
        </div>
      </div>
    </section>
  )
}

function InputRequestCard({
  event,
  run,
  rpcId,
  resolved,
  text,
}: {
  event: RunEvent
  run: Run
  rpcId: unknown
  resolved: boolean
  text: string
}) {
  const [answering, setAnswering] = useState(false)
  const raw = event.raw_payload as {
    params?: { questions?: Array<{ id: string; question?: string; header?: string }> }
  }
  const questions = raw?.params?.questions || []
  return (
    <div className={cn(requestCard, resolved && requestCardResolved)}>
      <strong className={requestTitle}>
        {resolved ? 'Input submitted' : `${providerName(run.provider)} needs input`}
      </strong>
      <p className={requestBody}>{text}</p>
      {!resolved && (
        <div className={requestActions}>
          <button className={requestButton} onClick={() => setAnswering(true)}>
            Answer
          </button>
        </div>
      )}
      {answering && (
        <InputRequestDialog
          provider={providerName(run.provider)}
          questions={questions}
          onSubmit={(answers) => void api.providerResponse(run.hostId, run.id, rpcId, { answers })}
          onClose={() => setAnswering(false)}
        />
      )}
    </div>
  )
}

// Memoized: rows are immutable once rendered (events never mutate in place),
// so a streaming append should only mount the new row, not re-render history.
export const ThreadEvent = memo(function ThreadEvent({
  event,
  run,
  cleanView = false,
  durationMs,
  resolved,
  canRewind,
  onRewind,
}: {
  event: RunEvent
  run: Run
  cleanView?: boolean
  durationMs?: number
  resolved: boolean
  canRewind: boolean
  onRewind: (turnId: string, text: string) => void
}) {
  const text = String(event.payload.text || '')
  const rpcId = event.payload.rpc_id
  const raw = event.raw_payload as {
    method?: string
    params?: {
      permissions?: unknown
      options?: Array<{ optionId?: string; name?: string; kind?: string }>
      questions?: Array<{ id: string; question?: string; header?: string }>
    }
  }
  if (event.kind.startsWith('queue.')) return null
  if (event.kind === 'usage.updated') return <UsageCard event={event} />
  if (event.kind === 'commands.updated') return null
  if (
    event.kind === 'approval.required' &&
    providerUi(run.provider).approvalMode === 'acp' &&
    rpcId !== undefined &&
    rpcId !== null
  ) {
    const options = raw.params?.options || []
    return (
      <div className={cn(requestCard, resolved && requestCardResolved)}>
        <strong className={requestTitle}>
          {resolved
            ? 'Permission request resolved'
            : `${providerName(run.provider)} permission required`}
        </strong>
        <p className={requestBody}>{text}</p>
        {!resolved && (
          <div className={requestActions}>
            {options.map((option) => (
              <button
                className={requestButton}
                key={option.optionId}
                onClick={() =>
                  api.providerResponse(run.hostId, run.id, rpcId, {
                    outcome: { outcome: 'selected', optionId: option.optionId },
                  })
                }
              >
                {option.name || option.kind || option.optionId}
              </button>
            ))}
          </div>
        )}
      </div>
    )
  }
  if (
    event.kind === 'approval.required' &&
    rpcId !== undefined &&
    rpcId !== null &&
    raw?.method === 'item/permissions/requestApproval'
  )
    return (
      <div className={cn(requestCard, resolved && requestCardResolved)}>
        <strong className={requestTitle}>
          {resolved ? 'Permission request resolved' : 'Additional permissions required'}
        </strong>
        <p className={requestBody}>{text}</p>
        {!resolved && (
          <div className={requestActions}>
            <button
              className={requestButton}
              onClick={() =>
                api.providerResponse(run.hostId, run.id, rpcId, {
                  permissions: raw.params?.permissions || {},
                  scope: 'turn',
                })
              }
            >
              Grant for turn
            </button>
            <button
              className={requestButton}
              onClick={() =>
                api.providerResponse(run.hostId, run.id, rpcId, {
                  permissions: raw.params?.permissions || {},
                  scope: 'session',
                })
              }
            >
              Grant for session
            </button>
            <button
              className={cn(requestButton, requestDecline)}
              onClick={() => api.providerResponse(run.hostId, run.id, rpcId, { permissions: {} })}
            >
              Decline
            </button>
          </div>
        )}
      </div>
    )
  if (event.kind === 'approval.required' && rpcId !== undefined && rpcId !== null)
    return (
      <div className={cn(requestCard, resolved && requestCardResolved)}>
        <strong className={requestTitle}>
          {resolved ? 'Approval resolved' : 'Approval required'}
        </strong>
        <p className={requestBody}>{text}</p>
        {!resolved && (
          <div className={requestActions}>
            <button
              className={requestButton}
              onClick={() =>
                api.providerResponse(run.hostId, run.id, rpcId, { decision: 'accept' })
              }
            >
              Approve
            </button>
            <button
              className={requestButton}
              onClick={() =>
                api.providerResponse(run.hostId, run.id, rpcId, { decision: 'acceptForSession' })
              }
            >
              Approve for session
            </button>
            <button
              className={cn(requestButton, requestDecline)}
              onClick={() =>
                api.providerResponse(run.hostId, run.id, rpcId, { decision: 'decline' })
              }
            >
              Decline
            </button>
          </div>
        )}
      </div>
    )
  if (event.kind === 'input.required' && rpcId !== undefined && rpcId !== null)
    return (
      <InputRequestCard event={event} run={run} rpcId={rpcId} resolved={resolved} text={text} />
    )
  if (event.kind === 'user.message') {
    if (
      cleanView &&
      isContextInjectionMessage({
        id: event.event_id,
        text,
        role: 'user',
        timestamp: event.timestamp,
      })
    ) {
      return (
        <ContextInjectionCard
          message={{ id: event.event_id, text, role: 'user', timestamp: event.timestamp }}
        />
      )
    }
    return (
      <ConversationMessage author="user" text={text} className={rewindable}>
        {canRewind && typeof event.payload.turn_id === 'string' && (
          <button
            className={rewindButton}
            title="Edit this message and branch from here"
            onClick={() => onRewind(event.payload.turn_id as string, conversationText(text).text)}
          >
            <Pencil size={12} />
            Edit from here
          </button>
        )}
      </ConversationMessage>
    )
  }
  if (event.kind === 'turn.started') return null
  if (event.kind === 'turn.completed')
    return (
      <div className={turnBoundary}>
        <span className={turnRule} />
        {durationMs !== undefined ? `Worked for ${durationLabel(durationMs)}` : 'Turn completed'}
        <span className={turnRule} />
      </div>
    )
  if (
    !text &&
    !event.kind.startsWith('run.') &&
    !event.kind.startsWith('control.') &&
    !event.kind.startsWith('turn.') &&
    !event.kind.startsWith('input.')
  )
    return null
  if (event.kind === 'assistant.message')
    return <ConversationMessage author="assistant" text={text} />
  if (event.kind === 'output' || event.kind.includes('message') || event.kind === 'tool.output')
    return <OperationalEvent event={event} run={run} />
  return (
    <div className={threadStatus}>
      <span>{event.kind.replaceAll('.', ' ')}</span>
      {event.payload.exit_code !== undefined && (
        <code className={threadStatusCode}>{String(event.payload.exit_code)}</code>
      )}
    </div>
  )
})
