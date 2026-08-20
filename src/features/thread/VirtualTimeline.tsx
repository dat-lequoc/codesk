// Extracted from App.tsx during the Tailwind/module refactor.

import { useVirtualizer } from '@tanstack/react-virtual'

import { cn } from '../../lib/cn'
import { threadColumn } from './thread-column'
export function VirtualTimeline<T>({
  items,
  scrollRef,
  itemKey,
  renderItem,
  before,
}: {
  items: T[]
  scrollRef: React.RefObject<HTMLDivElement | null>
  itemKey: (item: T) => string
  renderItem: (item: T) => React.ReactNode
  before?: React.ReactNode
}) {
  const enabled = items.length > 40
  const virtualizer = useVirtualizer({
    count: items.length,
    enabled,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => itemKey(items[index]),
    estimateSize: () => 110,
    overscan: 8,
  })
  if (!enabled)
    return (
      <div className={threadColumn}>
        {before}
        {items.map((item) => (
          <div className="min-w-0" key={itemKey(item)}>
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
              className="absolute top-0 left-0 w-full [will-change:transform]"
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
