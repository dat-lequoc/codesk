import type * as React from 'react'

import { cn } from '../../lib/cn'

export type StatusTone = 'online' | 'connecting' | 'offline' | 'error'

const tones: Record<StatusTone, string> = {
  online: 'bg-grass-500',
  connecting: 'bg-amber-signal-500',
  offline: 'bg-ink-400',
  error: 'bg-scarlet-500',
}

/** Small connection/liveness indicator. */
export function StatusDot({
  tone = 'offline',
  className,
  ...props
}: React.ComponentProps<'i'> & { tone?: StatusTone }) {
  return <i className={cn('size-1.5 shrink-0 rounded-full', tones[tone], className)} {...props} />
}
