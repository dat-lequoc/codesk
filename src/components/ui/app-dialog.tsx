import type * as React from 'react'

import { cn } from '../../lib/cn'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from './dialog'

/**
 * Title + subtitle dialog shell used across the app's modals.
 *
 * Kept as an always-open Radix dialog whose `onOpenChange` reports dismissal,
 * so the caller can keep driving visibility by mounting/unmounting — the
 * pattern the previous hand-rolled dialog used — while Radix supplies the
 * Escape key, backdrop click, focus trap and portal it never had.
 */
export function AppDialog({
  title,
  subtitle,
  onClose,
  className,
  children,
}: {
  title: string
  subtitle?: string
  onClose: () => void
  className?: string
  children: React.ReactNode
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className={cn('max-w-lg', className)}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {subtitle ? <DialogDescription>{subtitle}</DialogDescription> : null}
        </DialogHeader>
        <DialogBody>{children}</DialogBody>
      </DialogContent>
    </Dialog>
  )
}
