import { cva, type VariantProps } from 'class-variance-authority'
import type * as React from 'react'

import { cn } from '../../lib/cn'

const badge = cva(
  'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap',
  {
    variants: {
      tone: {
        neutral: 'bg-raised text-muted',
        success: 'bg-grass-950 text-grass-400',
        warning: 'bg-amber-signal-950 text-amber-signal-400',
        danger: 'bg-scarlet-950 text-scarlet-400',
        info: 'bg-azure-950 text-azure-400',
        brand: 'bg-ember-950 text-ember-400',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
)

export type BadgeProps = React.ComponentProps<'span'> & VariantProps<typeof badge>

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badge({ tone }), className)} {...props} />
}
