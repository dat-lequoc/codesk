import { useState } from 'react'
import {
  AlertCircle,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Compass,
  Copy,
  FileDiff,
  FileText,
  ListTodo,
  Loader2,
  Search,
  Sparkles,
  Target,
  Terminal,
} from 'lucide-react'
import { cn } from '../../lib/cn'
import { middleTruncatePath, pathLike } from '../../lib/format'
import type { TodoItemData } from '../../lib/clean-dsh'
import type { SessionMessage } from '../../types'

/** Clean collapsible Context Injection Card. */
export function ContextInjectionCard({ message }: { message: SessionMessage }) {
  const [open, setOpen] = useState(false)
  const text = message.text

  let category = 'Runtime context'
  if (text.startsWith('Additional instructions from:')) {
    category = 'Instruction overlay'
  } else if (text.startsWith('The approval policy changed')) {
    category = 'Policy update'
  }

  return (
    <div className="my-2 max-w-full min-w-0 overflow-hidden rounded-lg border border-azure-950 bg-ink-850/80 shadow-xs transition-all">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex min-h-[32px] w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left text-xs text-muted hover:bg-ink-800/80 hover:text-fg transition-colors"
        aria-expanded={open}
      >
        <Compass size={13} className="shrink-0 text-azure-400" />
        <span className="font-medium text-azure-400 text-[11px] shrink-0">Context injection</span>
        <span className="text-[10px] text-muted shrink-0">·</span>
        <span className="truncate min-w-0 flex-1 text-[11px] text-fg-soft/80">{category}</span>
        <span className="rounded-sm bg-azure-950/80 px-1.5 py-0.5 font-mono text-[9px] text-azure-400 border border-azure-600/40 shrink-0">
          snapshot
        </span>
        {open ? (
          <ChevronDown size={13} className="text-muted shrink-0 ml-1" />
        ) : (
          <ChevronRight size={13} className="shrink-0 ml-1" />
        )}
      </button>

      {open && (
        <div className="border-t border-ink-700/60 bg-ink-900/90 p-3 font-mono text-[11px]/[1.6] text-fg-soft whitespace-pre-wrap [overflow-wrap:anywhere] break-words select-text max-h-[360px] overflow-y-auto scroll-thin">
          {text}
        </div>
      )}
    </div>
  )
}

/** Clean Produced Files Card. */
export function ProducedFilesCard({
  files,
  onOpenFile,
}: {
  files: string[]
  onOpenFile?: (path: string) => void
}) {
  if (!files.length) return null

  return (
    <div className="my-3 flex max-w-full flex-wrap items-center gap-1.5 rounded-lg border border-grass-600/40 bg-grass-950/40 px-3 py-2 text-xs">
      <span className="flex items-center gap-1.5 text-[11px] font-semibold text-grass-400 shrink-0">
        <Sparkles size={13} />
        Produced
      </span>
      <span className="text-muted text-[10px] shrink-0">·</span>
      <div className="flex max-w-full min-w-0 flex-wrap gap-1.5">
        {files.map((path) => {
          const basename = path.split('/').pop() || path
          return (
            <button
              key={path}
              type="button"
              onClick={() => onOpenFile?.(path)}
              className="flex max-w-full items-center gap-1 rounded-md border border-grass-600/50 bg-grass-950 px-2 py-0.5 font-mono text-[10.5px] text-grass-400 hover:bg-grass-600/30 hover:text-fg transition-colors truncate"
              title={`Open ${path}`}
            >
              <FileText size={11} className="opacity-70 shrink-0" />
              <span className="truncate">{basename}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** Clean Todo List Card. */
export function TodoCard({ todos, defaultOpen }: { todos: TodoItemData[]; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(
    () => defaultOpen ?? todos.some((t) => t.status === 'in_progress'),
  )
  if (!todos || !todos.length) return null

  const completedCount = todos.filter((t) => t.status === 'completed').length
  const inProgressCount = todos.filter((t) => t.status === 'in_progress').length
  const pendingCount = todos.length - completedCount - inProgressCount

  return (
    <div className="my-3 max-w-full min-w-0 overflow-hidden rounded-xl border border-ink-650 bg-ink-850/90 shadow-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-[36px] w-full min-w-0 items-center gap-2 px-3 py-2 text-left hover:bg-ink-800 transition-colors"
        aria-expanded={open}
      >
        <ListTodo size={14} className="text-azure-400 shrink-0" />
        <strong className="text-xs font-semibold text-fg shrink-0">To-dos</strong>
        <span className="text-[10px] text-muted shrink-0">·</span>
        <span className="truncate min-w-0 text-[11px] text-fg-soft">
          {completedCount > 0 && <span className="text-grass-400">{completedCount} done</span>}
          {completedCount > 0 && (inProgressCount > 0 || pendingCount > 0) && ' · '}
          {inProgressCount > 0 && (
            <span className="text-azure-400">{inProgressCount} in progress</span>
          )}
          {inProgressCount > 0 && pendingCount > 0 && ' · '}
          {pendingCount > 0 && <span className="text-muted">{pendingCount} pending</span>}
        </span>
        <span className="flex-1" />
        {open ? (
          <ChevronDown size={13} className="text-muted shrink-0 ml-1" />
        ) : (
          <ChevronRight size={13} className="shrink-0 ml-1" />
        )}
      </button>

      {open && (
        <div className="border-t border-ink-700 bg-ink-900/60 p-2.5 space-y-1.5">
          {todos.map((todo, idx) => (
            <div
              key={`${todo.content}:${idx}`}
              className={cn(
                'flex items-start gap-2.5 rounded-md px-2 py-1 text-xs transition-colors',
                todo.status === 'completed' && 'text-muted line-through opacity-80',
                todo.status === 'in_progress' &&
                  'bg-azure-950/40 text-fg font-medium border border-azure-600/40',
                todo.status === 'pending' && 'text-fg-soft',
              )}
            >
              {todo.status === 'completed' && (
                <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-grass-400" />
              )}
              {todo.status === 'in_progress' && (
                <Loader2 size={13} className="mt-0.5 shrink-0 animate-spin text-azure-400" />
              )}
              {todo.status === 'pending' && (
                <span className="mt-0.5 inline-block size-3 rounded-full border border-dashed border-ink-400 shrink-0" />
              )}
              <span className="leading-tight [overflow-wrap:anywhere] break-words">
                {todo.content}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** Clean Ongoing Goal Card. */
export function GoalCard({
  goal,
}: {
  goal: { objective?: string; action?: string; status?: string }
}) {
  return (
    <div className="my-2.5 flex max-w-full min-w-0 items-center gap-2 rounded-lg border border-amber-signal-600/50 bg-amber-signal-950/60 px-3 py-2 text-xs">
      <Target size={14} className="text-amber-signal-400 shrink-0" />
      <span className="font-semibold text-amber-signal-400 text-[11.5px] shrink-0">Goal</span>
      <span className="text-[10px] text-muted shrink-0">·</span>
      <span className="truncate min-w-0 flex-1 font-medium text-fg-soft text-[11.5px]">
        {goal.objective || 'Active objective'}
      </span>
      <span className="rounded bg-amber-signal-950 px-1.5 py-0.5 font-mono text-[9px] text-amber-signal-400 uppercase shrink-0">
        {goal.action || 'active'}
      </span>
    </div>
  )
}

/** Clean Tool Call Card (Bash, Edit, Read, etc.). */
export function CleanToolCard({
  tool,
  command,
  output,
  status = 'completed',
  onOpenFile,
}: {
  tool: string
  command?: string
  output?: string
  status?: string
  onOpenFile?: (path: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)

  const isBash = tool === 'bash'
  const isEdit = tool === 'edit' || tool === 'write' || tool === 'delete'
  const isRead = tool === 'read' || tool === 'read_image'
  const isSearch = tool === 'glob' || tool === 'grep' || tool === 'web_search'
  const isSubagent =
    tool === 'subagent' || tool === 'subagent_fork' || tool === 'workflow' || tool === 'ralph'

  let displayLabel = command || ''
  if (command && command.startsWith('{')) {
    try {
      const parsed = JSON.parse(command)
      displayLabel = parsed.file_path || parsed.path || parsed.command || parsed.pattern || command
    } catch {}
  }

  const copyOutput = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!output) return
    void navigator.clipboard.writeText(output)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="my-1.5 max-w-full min-w-0 overflow-hidden rounded-lg border border-ink-650 bg-ink-850 shadow-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-[33px] w-full min-w-0 items-center gap-2 px-2.5 py-1.5 text-left text-xs text-muted hover:bg-ink-800 hover:text-fg transition-colors"
        aria-expanded={open}
      >
        <span className="grid size-5 place-items-center rounded shrink-0">
          {isBash && <Terminal size={13} className="text-grass-400" />}
          {isEdit && <FileDiff size={13} className="text-amber-signal-400" />}
          {isRead && <FileText size={13} className="text-azure-400" />}
          {isSearch && <Search size={13} className="text-ember-400" />}
          {isSubagent && <Bot size={13} className="text-fg-soft" />}
          {!isBash && !isEdit && !isRead && !isSearch && !isSubagent && (
            <Terminal size={13} className="text-muted" />
          )}
        </span>

        <span className="font-mono text-[11px] font-medium text-fg-soft shrink-0">{tool}</span>

        {displayLabel && (
          <code
            className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-muted"
            title={displayLabel}
          >
            {pathLike(displayLabel) ? middleTruncatePath(displayLabel, 38) : displayLabel}
          </code>
        )}
        {!displayLabel && <span className="flex-1" />}

        {status === 'completed' && (
          <span className="inline-flex items-center gap-1 text-[10px] text-grass-400 shrink-0">
            <Check size={11} />
          </span>
        )}
        {status === 'failed' && (
          <span className="inline-flex items-center gap-1 text-[10px] text-scarlet-400 shrink-0">
            <AlertCircle size={11} />
          </span>
        )}
        {status === 'in_progress' && (
          <Loader2 size={11} className="animate-spin text-azure-400 shrink-0" />
        )}

        {open ? (
          <ChevronDown size={13} className="text-muted shrink-0 ml-1" />
        ) : (
          <ChevronRight size={13} className="shrink-0 ml-1" />
        )}
      </button>

      {open && (
        <div className="border-t border-ink-700 bg-ink-900 p-2.5 font-mono text-[10.5px]/[1.5] text-fg-soft">
          {command && (
            <div className="mb-2 max-w-full min-w-0">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[9.5px] font-semibold text-muted uppercase tracking-wider block">
                  Command / Input
                </span>
                {(isEdit || isRead) && onOpenFile && displayLabel && (
                  <button
                    type="button"
                    onClick={() => onOpenFile(displayLabel)}
                    className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] text-azure-400 hover:bg-ink-800 hover:text-azure-500 transition-colors"
                  >
                    <FileText size={10} />
                    <span>Open file</span>
                  </button>
                )}
              </div>
              <pre className="m-0 max-w-full rounded bg-ink-950 p-2 text-fg-soft whitespace-pre-wrap [overflow-wrap:anywhere] break-words overflow-x-auto">
                {command}
              </pre>
            </div>
          )}
          {output && (
            <div className="max-w-full min-w-0">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[9.5px] font-semibold text-muted uppercase tracking-wider">
                  Output
                </span>
                <button
                  type="button"
                  onClick={copyOutput}
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] text-muted hover:bg-ink-800 hover:text-fg transition-colors"
                >
                  {copied ? <Check size={10} className="text-grass-400" /> : <Copy size={10} />}
                  <span>{copied ? 'Copied' : 'Copy'}</span>
                </button>
              </div>
              <pre className="scroll-thin m-0 max-h-[280px] max-w-full overflow-auto rounded bg-ink-950 p-2 text-fg-soft whitespace-pre-wrap [overflow-wrap:anywhere] break-words">
                {output}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
