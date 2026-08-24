import { Copy, Terminal, X } from 'lucide-react'
import type * as React from 'react'

import { Button } from '../../components/ui/button'
import { cn } from '../../lib/cn'

export function EnvironmentPopover({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
}) {
  return (
    <aside className="absolute top-[54px] right-3.5 z-10 w-[330px] rounded-xl border border-line-strong bg-ink-700 py-2 shadow-2xl shadow-black/50">
      <header className="flex h-8 items-center gap-2 pr-3 pl-3.5 text-xs text-muted">
        <span className="flex-1">{title}</span>
        <Button
          variant="ghost"
          size="icon-sm"
          title="Close environment inspector"
          aria-label="Close environment inspector"
          onClick={onClose}
        >
          <X size={14} />
        </Button>
      </header>
      {children}
    </aside>
  )
}

export function EnvironmentRow({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode
  label: string
  value?: React.ReactNode
}) {
  return (
    <div className="grid min-h-[38px] grid-cols-[21px_76px_minmax(0,1fr)] items-center gap-1 px-3.5 py-1.5">
      {icon}
      <span className="text-[11px] text-muted">{label}</span>
      <strong className="min-w-0 truncate text-right text-[11px] font-medium text-fg-soft">
        {value || 'Unknown'}
      </strong>
    </div>
  )
}

const tmuxRow =
  'grid min-w-0 grid-cols-[15px_48px_minmax(0,1fr)_auto] items-center gap-[5px] text-[9px] text-muted'
const tmuxValue = 'min-w-0 truncate font-mono text-[10px] leading-tight text-fg-soft'

function TmuxCommandRow({
  label,
  command,
  copyLabel,
}: {
  label: string
  command: string
  copyLabel: string
}) {
  return (
    <div className={tmuxRow}>
      <Copy size={14} />
      <span>{label}</span>
      <code className={cn(tmuxValue, 'block')} title={command}>
        {command}
      </code>
      <Button
        variant="ghost"
        size="icon-sm"
        className="size-[23px] rounded-sm"
        title={copyLabel}
        aria-label={copyLabel}
        onClick={() => void navigator.clipboard.writeText(command)}
      >
        <Copy size={13} />
      </Button>
    </div>
  )
}

export function TmuxDetails({
  name,
  command,
  hostCommand,
  emptyLabel = 'Not detected',
  note,
}: {
  name?: string | null
  command?: string | null
  hostCommand?: string | null
  /// Shown in place of a pane name. "Not detected" reads as a fault, which is
  /// wrong for a conversation whose process has simply exited.
  emptyLabel?: string
  /// One line of context for that absence, such as what sending will do.
  note?: string
}) {
  const onHost = hostCommand && hostCommand !== command ? hostCommand : null
  return (
    <div className="flex min-w-0 flex-col gap-[5px] px-3.5 py-1.5">
      <div className={tmuxRow}>
        <Terminal size={14} />
        <span>tmux</span>
        <strong className={tmuxValue}>{name || emptyLabel}</strong>
      </div>
      {!name && note ? (
        <small className="pl-[68px] text-[9px] leading-tight text-muted">{note}</small>
      ) : null}
      {command ? (
        <TmuxCommandRow label="Access" command={command} copyLabel="Copy tmux access command" />
      ) : null}
      {onHost ? (
        <TmuxCommandRow
          label="On host"
          command={onHost}
          copyLabel="Copy tmux command for this host"
        />
      ) : null}
    </div>
  )
}
