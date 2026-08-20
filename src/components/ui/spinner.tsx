import { cn } from '../../lib/cn'

/** Indeterminate progress ring. */
export function Spinner({ className, size = 14 }: { className?: string; size?: number }) {
  return (
    <span
      role="status"
      aria-label="Loading"
      style={{ width: size, height: size, borderWidth: Math.max(1.5, size / 9) }}
      className={cn(
        'inline-block shrink-0 animate-spin rounded-full border-current border-t-transparent',
        className,
      )}
    />
  )
}
