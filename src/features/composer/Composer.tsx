import { ChevronDown, ChevronUp, FileText, Plus, Terminal, X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import type { FormEvent } from 'react'

import { Textarea } from '../../components/ui/input'
import { cn } from '../../lib/cn'
import {
  formatFileSize,
  processAttachmentFiles,
  type ComposerAttachment,
} from '../../lib/attachments'
import type { SlashSuggestion } from '../../lib/kiro'

export function ComposerFrame({
  className,
  onSubmit,
  onAttach,
  children,
}: {
  className?: string
  onSubmit: (event: FormEvent) => void
  onAttach?: (attachments: ComposerAttachment[]) => void
  children: React.ReactNode
}) {
  const handleDrop = async (e: React.DragEvent) => {
    if (!onAttach || !e.dataTransfer.files.length) return
    e.preventDefault()
    e.stopPropagation()
    const loaded = await processAttachmentFiles(e.dataTransfer.files)
    if (loaded.length) onAttach(loaded)
  }

  const handleDragOver = (e: React.DragEvent) => {
    if (onAttach && e.dataTransfer.types.includes('Files')) {
      e.preventDefault()
    }
  }

  return (
    <form className={className} onSubmit={onSubmit} onDrop={handleDrop} onDragOver={handleDragOver}>
      {children}
    </form>
  )
}

export function ComposerInput({
  onAttach,
  onPaste,
  ...props
}: React.ComponentProps<'textarea'> & {
  onAttach?: (attachments: ComposerAttachment[]) => void
}) {
  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (onAttach && e.clipboardData.files.length > 0) {
      e.preventDefault()
      const loaded = await processAttachmentFiles(e.clipboardData.files)
      if (loaded.length) onAttach(loaded)
      return
    }
    onPaste?.(e)
  }

  return <Textarea {...props} onPaste={handlePaste} />
}

export function ComposerFooter({
  className,
  children,
}: {
  className?: string
  children: React.ReactNode
}) {
  return <div className={cn('flex h-11 items-center gap-2.5 px-3', className)}>{children}</div>
}

export function AttachmentButton({
  onAttach,
  disabled = false,
  className,
}: {
  onAttach: (attachments: ComposerAttachment[]) => void
  disabled?: boolean
  className?: string
}) {
  const inputRef = useRef<HTMLInputElement>(null)

  const handleFiles = async (files: FileList | null) => {
    if (!files || !files.length) return
    const loaded = await processAttachmentFiles(files)
    if (loaded.length) {
      onAttach(loaded)
    }
    if (inputRef.current) {
      inputRef.current.value = ''
    }
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept="image/*,text/*,.pdf,.md,.txt,.json,.py,.ts,.js,.rs,.c,.cpp,.h,.css,.html,.yaml,.yml,.toml,.sh"
        className="hidden"
        onChange={(e) => void handleFiles(e.target.files)}
      />
      <button
        type="button"
        className={cn(
          'grid size-7 shrink-0 place-items-center rounded-md text-muted hover:bg-ink-650 hover:text-fg transition-colors cursor-pointer',
          className,
        )}
        aria-label="Add attachment"
        title="Add images or text files (or paste/drag into chat)"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
      >
        <Plus size={18} />
      </button>
    </>
  )
}

export function ComposerAttachmentsList({
  attachments,
  onRemove,
}: {
  attachments: ComposerAttachment[]
  onRemove: (id: string) => void
}) {
  if (!attachments.length) return null
  return (
    <div className="flex flex-wrap gap-2 px-3 pt-2 pb-1">
      {attachments.map((att) => (
        <div
          key={att.id}
          className="group flex items-center gap-2 rounded-lg border border-ink-650 bg-ink-800 py-1 pr-2 pl-1.5 text-xs text-fg shadow-xs transition-all hover:border-ink-500"
        >
          {att.dataUrl ? (
            <img
              src={att.dataUrl}
              alt={att.name}
              className="size-7 rounded object-cover border border-ink-700"
            />
          ) : (
            <span className="grid size-7 place-items-center rounded bg-ink-700 text-muted">
              <FileText size={14} />
            </span>
          )}
          <div className="min-w-0 max-w-[140px]">
            <p className="truncate font-medium text-[11px] leading-tight text-fg-soft">
              {att.name}
            </p>
            <p className="text-[10px] text-muted">{formatFileSize(att.size)}</p>
          </div>
          <button
            type="button"
            onClick={() => onRemove(att.id)}
            className="ml-0.5 grid size-4.5 place-items-center rounded text-muted opacity-60 hover:bg-ink-700 hover:text-fg hover:opacity-100 transition-opacity cursor-pointer"
            title="Remove attachment"
            aria-label={`Remove ${att.name}`}
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  )
}

export function SlashCommandMenu({
  suggestions,
  selected,
  onSelect,
  onChoose,
}: {
  suggestions: SlashSuggestion[]
  selected: number
  onSelect: (index: number) => void
  onChoose: (suggestion: SlashSuggestion) => void
}) {
  const selectedOption = useRef<HTMLButtonElement>(null)
  // The list scrolls once a catalog is longer than the overlay, so keep the
  // keyboard selection visible instead of letting it walk out of view.
  useEffect(() => {
    selectedOption.current?.scrollIntoView({ block: 'nearest' })
  }, [selected, suggestions.length])
  if (!suggestions.length) return null
  return (
    <div className="absolute inset-x-0 bottom-[calc(100%+8px)] z-20 flex flex-col overflow-hidden rounded-xl border border-line-strong bg-ink-700 shadow-2xl shadow-black/55">
      {/* ~5.5 rows stay visible so the list reads as scrollable */}
      <div
        className="scroll-thin flex max-h-[248px] min-h-0 shrink flex-col overflow-x-hidden overflow-y-auto p-1.5"
        role="listbox"
        aria-label="Kiro commands"
      >
        {suggestions.map((suggestion, index) => (
          <button
            key={suggestion.value}
            ref={index === selected ? selectedOption : undefined}
            type="button"
            role="option"
            aria-selected={index === selected}
            onMouseEnter={() => onSelect(index)}
            onClick={() => onChoose(suggestion)}
            className={cn(
              'flex min-h-11 w-full shrink-0 items-center gap-[7px] rounded-md px-2.5 py-1.5 text-left text-fg-soft',
              'hover:bg-ink-600 hover:text-fg aria-selected:bg-ink-600 aria-selected:text-fg',
            )}
          >
            <Terminal size={14} className="shrink-0 text-grass-400/80" />
            <span className="min-w-0 flex-1 overflow-hidden">
              <strong className="block truncate font-mono text-xs font-medium">
                {suggestion.label}
              </strong>
              <small className="mt-[3px] block truncate text-[10px] text-muted">
                {suggestion.description}
              </small>
            </span>
            {suggestion.detail && (
              <em className="flex h-5 shrink-0 items-center rounded-full border border-line-strong px-[7px] text-[9px] whitespace-nowrap text-grass-400/90 not-italic">
                {suggestion.detail}
              </em>
            )}
          </button>
        ))}
      </div>
      {suggestions.length > 1 && (
        <footer className="flex h-[27px] shrink-0 items-center gap-3 border-t border-line-strong bg-ink-850 px-[11px] text-[10px] text-dim">
          <span className="flex items-center gap-[3px]">
            <ChevronUp size={11} />
            <ChevronDown size={11} />
            to navigate
          </span>
          <span className="flex items-center gap-[3px]">↵ to select</span>
          <span className="flex items-center gap-[3px]">Tab to complete</span>
          <small className="ml-auto text-ink-300">
            {selected + 1} of {suggestions.length}
          </small>
        </footer>
      )}
    </div>
  )
}
