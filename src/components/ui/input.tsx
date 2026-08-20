import type * as React from 'react'

import { cn } from '../../lib/cn'

export function Input({ className, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      className={cn(
        'h-9 w-full rounded-md border border-line bg-sunken px-3 text-sm text-fg',
        'placeholder:text-dim',
        'focus:border-grass-600 focus:outline-none',
        'disabled:opacity-45',
        className,
      )}
      {...props}
    />
  )
}

export function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      className={cn(
        'scroll-thin w-full resize-none rounded-md bg-transparent text-sm text-fg',
        'placeholder:text-dim focus:outline-none',
        className,
      )}
      {...props}
    />
  )
}
