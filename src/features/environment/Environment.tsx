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
  'grid min-w-0 grid-cols-[15px_43px_minmax(0,1fr)_auto] items-center gap-[5px] text-[9px] text-muted'
const tmuxValue = 'min-w-0 truncate font-mono text-[10px] leading-tight text-fg-soft'

export function TmuxDetails({ name, command }: { name?: string | null; command?: string | null }) {
  if (!name && !command) return null
  return (
    <div className="flex min-w-0 flex-col gap-[5px]">
      {name && (
        <div className={tmuxRow}>
          <Terminal size={14} />
          <span>tmux</span>
          <strong className={tmuxValue}>{name}</strong>
        </div>
      )}
      {command && (
        <div className={tmuxRow}>
          <Copy size={14} />
          <span>Access</span>
          <code className={cn(tmuxValue, 'block')} title={command}>
            {command}
          </code>
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-[23px] rounded-sm"
            title="Copy tmux access command"
            aria-label="Copy tmux access command"
            onClick={() => void navigator.clipboard.writeText(command)}
          >
            <Copy size={13} />
          </Button>
        </div>
      )}
    </div>
  )
}
