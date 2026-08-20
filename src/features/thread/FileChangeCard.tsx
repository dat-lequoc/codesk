import { ChevronDown, Copy, Eye, FileDiff, FolderOpen } from 'lucide-react'
import { useState } from 'react'

import { api } from '../../api'
import { cn } from '../../lib/cn'
import { changePath, diffCounts } from '../../lib/activity'
import type { FileChange } from '../../lib/activity'
import type { Run } from '../../types'
import {
  addCount,
  delCount,
  fileChangeCard,
  fileChangeCounts,
  fileChangeHeader,
  fileChangeIcon,
  fileChangeList,
  fileChangeMore,
  fileChangePath,
  fileChangeReview,
  fileChangeRow,
  fileChangeRowButton,
} from './file-change-styles'
export function FileChangeCard({
  changes = [],
  text,
  run,
}: {
  changes?: FileChange[]
  text: string
  run: Run
}) {
  const [showAll, setShowAll] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  const stats = changes.reduce(
    (total, change) => {
      const next = diffCounts(change.diff)
      total.additions += next.additions
      total.deletions += next.deletions
      return total
    },
    { additions: 0, deletions: 0 },
  )
  if (!changes.length && text) {
    const fallback = diffCounts(text)
    stats.additions = fallback.additions
    stats.deletions = fallback.deletions
  }
  const visible = showAll ? changes : changes.slice(0, 4)
  const hidden = Math.max(0, changes.length - visible.length)
  const reviewText =
    changes
      .map((change) => (change.diff ? `${change.path || 'Unknown file'}\n${change.diff}` : ''))
      .filter(Boolean)
      .join('\n\n') || text
  const label = changes.length
    ? `Edited ${changes.length} file${changes.length === 1 ? '' : 's'}`
    : 'File changes'
  return (
    <section className={fileChangeCard}>
      <header className={fileChangeHeader}>
        <span className={fileChangeIcon}>
          <FileDiff size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <strong className="block text-[12.5px] font-semibold text-fg-soft">{label}</strong>
          {(stats.additions > 0 || stats.deletions > 0) && (
            <small className="mt-[3px] flex gap-[5px] font-mono text-[11px]">
              <b className={addCount}>+{stats.additions}</b>
              <i className={delCount}>-{stats.deletions}</i>
            </small>
          )}
        </div>
        {reviewText && (
          <button
            className={cn(
              'flex h-[29px] shrink-0 items-center gap-1.5 rounded-md border border-line-strong bg-ink-750 px-2.5 text-[10.5px] text-fg-soft hover:bg-ink-650 hover:text-fg',
              reviewing && 'bg-ink-650 text-fg',
            )}
            onClick={() => setReviewing((value) => !value)}
          >
            <Eye size={13} />
            {reviewing ? 'Hide diff' : 'Review'}
          </button>
        )}
      </header>
      {visible.length > 0 && (
        <div className={fileChangeList}>
          {visible.map((change, index) => {
            const counts = diffCounts(change.diff)
            return (
              <div className={fileChangeRow} key={`${change.path || 'file'}:${index}`}>
                <code className={fileChangePath} title={change.path}>
                  {change.path || 'Unknown file'}
                </code>
                <small className={fileChangeCounts}>
                  {counts.additions > 0 && <b className={addCount}>+{counts.additions}</b>}
                  {counts.deletions > 0 && <i className={delCount}>-{counts.deletions}</i>}
                </small>
                <button
                  className={fileChangeRowButton}
                  title="Copy path"
                  onClick={() => void navigator.clipboard.writeText(change.path || '')}
                >
                  <Copy size={12} />
                </button>
                <button
                  className={fileChangeRowButton}
                  title="Open file"
                  onClick={() => void api.openPath(run.hostId, changePath(run, change.path))}
                >
                  <FolderOpen size={12} />
                </button>
              </div>
            )
          })}
        </div>
      )}
      {hidden > 0 && (
        <button className={fileChangeMore} onClick={() => setShowAll(true)}>
          Show {hidden} more file{hidden === 1 ? '' : 's'}
          <ChevronDown size={13} />
        </button>
      )}
      {showAll && changes.length > 4 && (
        <button className={fileChangeMore} onClick={() => setShowAll(false)}>
          Show fewer
          <ChevronDown className="rotate-180" size={13} />
        </button>
      )}
      {reviewing && reviewText && <pre className={fileChangeReview}>{reviewText}</pre>}
      {!changes.length && text && !reviewing && <pre className={fileChangeReview}>{text}</pre>}
    </section>
  )
}
