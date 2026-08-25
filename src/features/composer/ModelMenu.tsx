import { Check, ChevronDown, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { api } from '../../api'
import { cn } from '../../lib/cn'

type Model = { id: string; description: string }
type Effort = { id: string; label: string }
type Catalog = { models: Model[]; efforts: Effort[] }

// Reading a catalog drives the harness's own picker in its pane, so the answer
// is kept per host and provider instead of being re-read every time the menu
// opens. The model in use is not cached with it: that is read live.
const catalogs = new Map<string, Catalog>()

export function ModelMenu({
  hostId,
  runId,
  provider,
  model,
  effort,
  fallback,
  disabled,
  onApplied,
  onOpenChange,
}: {
  hostId: string
  runId: string
  provider: string
  model?: string | null
  effort?: string | null
  // What to show when the harness has not reported a model yet.
  fallback?: string | null
  disabled?: boolean
  onApplied?: (applied: { model?: string; effort?: string }) => void
  // The composer clips its own overflow, so it has to be told to stop while
  // this menu is up or the list is cut off at the composer's edge.
  onOpenChange?: (open: boolean) => void
}) {
  const key = `${hostId}:${provider}`
  const [open, setOpen] = useState(false)
  const [catalog, setCatalog] = useState<Catalog | null>(() => catalogs.get(key) || null)
  const [reading, setReading] = useState(false)
  const [applying, setApplying] = useState('')
  const [error, setError] = useState('')
  const menu = useRef<HTMLDivElement>(null)
  const label = [model, effort].filter(Boolean).join(' · ') || fallback || 'Model'
  const show = useCallback(
    (next: boolean) => {
      setOpen(next)
      onOpenChange?.(next)
    },
    [onOpenChange],
  )

  useEffect(() => {
    if (!open) return
    const dismiss = (event: MouseEvent) => {
      if (!menu.current?.contains(event.target as Node)) show(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') show(false)
    }
    document.addEventListener('mousedown', dismiss)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('mousedown', dismiss)
      document.removeEventListener('keydown', escape)
    }
  }, [open, show])

  const toggle = async () => {
    if (open) return show(false)
    show(true)
    if (catalog || reading) return
    setReading(true)
    setError('')
    try {
      const result = await api.providerModels(hostId, runId)
      const read = {
        models: result.models.map((item) => ({
          id: item.id,
          description: item.description || '',
        })),
        efforts: result.efforts || [],
      }
      if (!read.models.length && !read.efforts.length) return
      catalogs.set(key, read)
      setCatalog(read)
    } catch (failure) {
      setError((failure as Error).message)
    } finally {
      setReading(false)
    }
  }

  const apply = async (change: { model?: string; effort?: string }) => {
    setApplying(change.model || change.effort || '')
    setError('')
    try {
      const applied = await api.setProviderModel(hostId, runId, change)
      onApplied?.({ model: applied.model || undefined, effort: applied.effort || undefined })
      show(false)
    } catch (failure) {
      setError((failure as Error).message)
    } finally {
      setApplying('')
    }
  }

  return (
    <div className="relative" ref={menu}>
      <button
        type="button"
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="menu"
        title="Change the model and reasoning effort"
        className={cn(
          'flex h-6 max-w-[220px] items-center gap-1 rounded-md px-1.5 text-[10px] text-muted',
          'hover:bg-ink-600 hover:text-fg-soft disabled:pointer-events-none disabled:opacity-60',
          open && 'bg-ink-600 text-fg-soft',
        )}
        onClick={() => void toggle()}
      >
        <span className="min-w-0 truncate font-mono">{label}</span>
        <ChevronDown size={11} className="shrink-0" />
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Model and reasoning effort"
          className="absolute right-0 bottom-[calc(100%+8px)] z-30 flex w-[290px] flex-col overflow-hidden rounded-xl border border-line-strong bg-ink-700 shadow-2xl shadow-black/55"
        >
          {/* Tall enough that a short catalog shows its reasoning levels
              without scrolling, and still bounded for a long one. */}
          <div className="scroll-thin flex max-h-[min(70vh,520px)] min-h-0 flex-col overflow-x-hidden overflow-y-auto p-1.5">
            {reading && (
              <span className="flex items-center gap-2 px-2.5 py-3 text-[10.5px] text-muted">
                <RefreshCw size={12} className="animate-spin" />
                Reading the harness&apos;s model list
              </span>
            )}
            {catalog?.models.length ? (
              <>
                <small className="px-2.5 pt-1 pb-1.5 text-[9.5px] tracking-wide text-dim uppercase">
                  Model
                </small>
                {catalog.models.map((item) => (
                  <MenuRow
                    key={item.id}
                    label={item.id}
                    description={item.description}
                    current={item.id === model}
                    busy={applying === item.id}
                    onSelect={() => void apply({ model: item.id })}
                  />
                ))}
              </>
            ) : null}
            {catalog?.efforts.length ? (
              <>
                <small className="px-2.5 pt-2 pb-1.5 text-[9.5px] tracking-wide text-dim uppercase">
                  Reasoning effort
                </small>
                {catalog.efforts.map((item) => (
                  <MenuRow
                    key={item.id}
                    label={item.label}
                    current={item.id === effort}
                    busy={applying === item.id}
                    onSelect={() => void apply({ effort: item.id })}
                  />
                ))}
              </>
            ) : null}
            {!reading && !error && !catalog?.models.length && !catalog?.efforts.length && (
              <span className="px-2.5 py-3 text-[10.5px] text-muted">
                This harness listed no models.
              </span>
            )}
          </div>
          {error && (
            <p className="border-t border-line-strong bg-ink-850 px-3 py-2 text-[10px] leading-relaxed text-scarlet-400">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function MenuRow({
  label,
  description,
  current,
  busy,
  onSelect,
}: {
  label: string
  description?: string
  current: boolean
  busy: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={current}
      disabled={busy}
      onClick={onSelect}
      className={cn(
        'flex min-h-8 w-full shrink-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-fg-soft',
        'hover:bg-ink-600 hover:text-fg disabled:opacity-70',
        current && 'text-grass-400',
      )}
    >
      <span className="min-w-0 flex-1 overflow-hidden">
        <strong className="block truncate font-mono text-[11px] font-medium">{label}</strong>
        {description && (
          <small className="mt-[3px] block truncate text-[10px] text-muted">{description}</small>
        )}
      </span>
      {busy ? (
        <RefreshCw size={12} className="shrink-0 animate-spin text-muted" />
      ) : current ? (
        <Check size={12} className="shrink-0" />
      ) : null}
    </button>
  )
}
