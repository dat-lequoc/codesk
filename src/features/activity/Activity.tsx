import { cn } from '../../lib/cn'
import { reasoningSummary } from '../thread/thread-styles'
import { Bot, Copy, FileDiff, FileText, FolderOpen, Info, Terminal, X } from 'lucide-react'
import { api } from '../../api'
import {
  activityRowLabel,
  activityText,
  diffCounts,
  historicalActivityItems,
  liveActivityItems,
} from '../../lib/activity'
import type { ActivityEntry, ActivityLedgerItem } from '../../lib/activity'
import type { RunEvent, SessionMessage } from '../../types'
import { MarkdownContent } from '../thread/Markdown'
import { useMemo, useState } from 'react'
const tabButton =
  'h-8 border-b-2 border-transparent px-2 text-[10.5px] text-muted hover:text-fg-soft'
const tabActive = 'border-azure-400 text-fg'
const detailSection = 'mb-3 overflow-hidden rounded-lg border border-ink-650 bg-ink-850'
const detailHeader =
  'flex h-[30px] items-center border-b border-ink-650 px-2.5 font-mono text-[10px] tracking-wider text-muted uppercase'
const detailPre =
  'scroll-thin m-0 max-h-[310px] overflow-auto bg-ink-900 p-2.5 font-mono text-[10.5px]/[1.55] whitespace-pre-wrap text-fg-soft [overflow-wrap:anywhere]'
const fileRow =
  'flex min-h-[35px] items-center gap-[7px] border-b border-ink-700 px-2 text-muted last:border-b-0'
const fileRowButton =
  'grid size-[23px] shrink-0 place-items-center rounded-sm text-muted hover:bg-ink-650 hover:text-fg'

export function ActivityRow({
  entry,
  selected,
  onSelect,
}: {
  entry: ActivityEntry
  selected: boolean
  onSelect: (entry: ActivityEntry) => void
}) {
  const label = activityRowLabel(entry)
  const accessibleLabel = `${entry.type === 'files' ? 'Files' : 'Tool'}: ${label} · ${entry.status}`
  return (
    <button
      className={cn(
        'flex h-[31px] w-full min-w-0 items-center gap-[7px] rounded-md px-1 text-left text-muted hover:bg-ink-850 hover:text-fg-soft',
        entry.status === 'failed' && 'text-scarlet-400',
        selected && 'bg-grass-950 text-grass-400',
      )}
      aria-pressed={selected}
      aria-label={accessibleLabel}
      onClick={() => onSelect(entry)}
      title={label}
    >
      <span
        className={cn(
          'grid size-[22px] shrink-0 place-items-center',
          entry.type === 'files' && 'text-amber-signal-500',
        )}
      >
        {entry.type === 'files' ? <FileDiff size={14} /> : <Terminal size={14} />}
      </span>
      <code className="min-w-0 flex-1 truncate font-mono text-xs/[1.3] text-current">{label}</code>
    </button>
  )
}

export function ActivityLedger({
  items,
  selectedId,
  onSelect,
}: {
  items: ActivityLedgerItem[]
  selectedId: string | null
  onSelect: (entry: ActivityEntry) => void
}) {
  return (
    <div className="my-2.5 mb-6">
      {items.map((item) =>
        item.type === 'reasoning' ? (
          <div className={cn(reasoningSummary, 'my-[3px]')} key={item.id}>
            <Bot size={13} />
            <MarkdownContent text={item.text} />
          </div>
        ) : (
          <ActivityRow
            entry={item.entry}
            selected={selectedId === item.entry.id}
            onSelect={onSelect}
            key={item.entry.id}
          />
        ),
      )}
    </div>
  )
}

export function ActivityInspectorPanel({
  entry,
  hostId,
  cwd,
  onClose,
}: {
  entry: ActivityEntry
  hostId: string
  cwd: string
  onClose: () => void
}) {
  const [tab, setTab] = useState<'details' | 'raw'>('details')
  // Inspecting a different entry starts back on the details tab.
  const [tabEntryId, setTabEntryId] = useState(entry.id)
  if (tabEntryId !== entry.id) {
    setTabEntryId(entry.id)
    setTab('details')
  }
  const input = activityText(entry.input)
  const output = activityText(entry.output)
  const raw = activityText(entry.raw)
  const hasDetails = Boolean(input || output || entry.changes.length)
  return (
    <aside className="absolute top-[45px] right-0 bottom-0 z-10 flex w-[var(--file-preview-width)] min-w-[380px] flex-col border-l border-line bg-sunken shadow-[-18px_0_45px_#0003]">
      <header className="flex h-[52px] shrink-0 items-center gap-2.5 border-b border-line px-3 text-muted">
        {entry.type === 'files' ? (
          <FileDiff size={15} className="shrink-0" />
        ) : (
          <Terminal size={15} className="shrink-0" />
        )}
        <span className="min-w-0 flex-1">
          <strong className="block truncate text-xs font-semibold text-fg-soft">
            {entry.label}
          </strong>
          <small className="mt-[3px] block truncate font-mono text-[9.5px] text-dim">
            {entry.type === 'files' ? 'File changes' : 'Tool call'} · {entry.status}
          </small>
        </span>
        <button
          className="grid size-7 shrink-0 place-items-center rounded-[7px] text-muted hover:bg-raised hover:text-fg"
          title="Close activity inspector"
          aria-label="Close activity inspector"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </header>
      <nav className="flex h-[38px] shrink-0 items-end gap-1 border-b border-line bg-ink-850 px-3">
        <button
          className={cn(tabButton, tab === 'details' && tabActive)}
          onClick={() => setTab('details')}
        >
          Details
        </button>
        <button className={cn(tabButton, tab === 'raw' && tabActive)} onClick={() => setTab('raw')}>
          Raw
        </button>
      </nav>
      {tab === 'raw' ? (
        <pre className="scroll-thin m-0 min-h-0 flex-1 overflow-auto bg-ink-900 p-4 font-mono text-[10.5px]/[1.6] whitespace-pre-wrap text-fg-soft [overflow-wrap:anywhere] [tab-size:2]">
          {raw}
        </pre>
      ) : (
        <div className="scroll-thin min-h-0 flex-1 overflow-auto p-3">
          {!hasDetails && (
            <div className="flex min-h-[180px] items-center justify-center gap-2 p-5 text-center text-[11px] text-dim">
              <Info size={18} />
              <span>This tool did not provide additional details.</span>
            </div>
          )}
          {input && (
            <section className={detailSection}>
              <header className={detailHeader}>Input</header>
              <pre className={detailPre}>{input}</pre>
            </section>
          )}
          {output && (
            <section className={detailSection}>
              <header className={detailHeader}>
                {entry.status === 'failed' ? 'Error output' : 'Output'}
              </header>
              <pre className={detailPre}>{output}</pre>
            </section>
          )}
          {entry.changes.length > 0 && (
            <section className={detailSection}>
              <header className={detailHeader}>Changed files</header>
              <div>
                {entry.changes.map((change, index) => {
                  const counts = diffCounts(change.diff)
                  const path = change.path || 'Unknown file'
                  const resolved = path.startsWith('/') ? path : `${cwd.replace(/\/$/, '')}/${path}`
                  return (
                    <div className={fileRow} key={`${path}:${index}`}>
                      <FileText size={13} className="shrink-0" />
                      <code
                        className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-fg-soft"
                        title={path}
                      >
                        {path}
                      </code>
                      <small className="flex shrink-0 gap-1 font-mono text-[10px]">
                        {counts.additions > 0 && (
                          <b className="text-grass-400 not-italic">+{counts.additions}</b>
                        )}
                        {counts.deletions > 0 && (
                          <i className="text-scarlet-400 not-italic">-{counts.deletions}</i>
                        )}
                      </small>
                      {change.path && (
                        <>
                          <button
                            className={fileRowButton}
                            title="Copy path"
                            onClick={() => void navigator.clipboard.writeText(path)}
                          >
                            <Copy size={12} />
                          </button>
                          <button
                            className={fileRowButton}
                            title="Open file"
                            onClick={() => void api.openPath(hostId, resolved)}
                          >
                            <FolderOpen size={12} />
                          </button>
                        </>
                      )}
                    </div>
                  )
                })}
              </div>
            </section>
          )}
        </div>
      )}
    </aside>
  )
}

export function ToolActivityGroup({
  events,
  selectedId,
  onSelect,
}: {
  events: RunEvent[]
  selectedId: string | null
  onSelect: (entry: ActivityEntry) => void
}) {
  return (
    <ActivityLedger items={liveActivityItems(events)} selectedId={selectedId} onSelect={onSelect} />
  )
}

export function HistoricalActivityGroup({
  messages,
  selectedId,
  onSelect,
}: {
  messages: SessionMessage[]
  selectedId: string | null
  onSelect: (entry: ActivityEntry) => void
}) {
  const items = useMemo(() => historicalActivityItems(messages), [messages])
  return <ActivityLedger items={items} selectedId={selectedId} onSelect={onSelect} />
}
