// Extracted from App.tsx during the Tailwind/module refactor.

import { useVirtualizer } from '@tanstack/react-virtual'

import { cn } from '../../lib/cn'
import { threadColumn } from './thread-column'

export const virtualRowEstimate = 110

export function VirtualTimeline<T>({
  items,
  scrollRef,
  itemKey,
  renderItem,
  before,
  initialOffset,
}: {
  items: T[]
  scrollRef: React.RefObject<HTMLDivElement | null>
  itemKey: (item: T) => string
  renderItem: (item: T) => React.ReactNode
  before?: React.ReactNode
  initialOffset?: number
}) {
  // Virtualize early: below the threshold every streamed token re-renders all
  // rows, and markdown rows are the most expensive thing in the app. The
  // threshold only exists so short threads keep native layout for measurement.
  const enabled = items.length > 12
  // TanStack Virtual hands back fresh closures on every call, so React Compiler
  // declines to memoize this component rather than risk serving stale rows.
  // That is the right trade here and there is nothing to fix at this site.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: items.length,
    enabled,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => itemKey(items[index]),
    estimateSize: () => virtualRowEstimate,
    initialOffset,
    overscan: 8,
  })
  if (!enabled)
    return (
      <div className={threadColumn}>
        {before}
        {items.map((item) => (
          <div className="min-w-0 max-w-full" key={itemKey(item)}>
            {renderItem(item)}
          </div>
        ))}
      </div>
    )
  return (
    <>
      <div className={threadColumn}>{before}</div>
      <div className={cn(threadColumn, 'relative')} style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((row) => {
          const item = items[row.index]
          return (
            <div
              className="absolute top-0 left-0 w-full min-w-0 max-w-full [will-change:transform]"
              data-index={row.index}
              key={row.key}
              ref={virtualizer.measureElement}
              style={{ transform: `translateY(${row.start}px)` }}
            >
              {renderItem(item)}
            </div>
          )
        })}
      </div>
    </>
  )
}
