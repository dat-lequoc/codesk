import { ChevronDown, ChevronUp, Terminal } from 'lucide-react'
import { useEffect, useRef } from 'react'
import type { FormEvent } from 'react'

import { Textarea } from '../../components/ui/input'
import { cn } from '../../lib/cn'
import type { SlashSuggestion } from '../../lib/kiro'

export function ComposerFrame({
  className,
  onSubmit,
  children,
}: {
  className?: string
  onSubmit: (event: FormEvent) => void
  children: React.ReactNode
}) {
  return (
    <form className={className} onSubmit={onSubmit}>
      {children}
    </form>
  )
}

export function ComposerInput(props: React.ComponentProps<'textarea'>) {
  return <Textarea {...props} />
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
