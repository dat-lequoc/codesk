import { useState } from 'react'

import { AppDialog } from '../../components/ui/app-dialog'
import { Button } from '../../components/ui/button'

/// A confirm or plain message the app renders in place of the native
/// `confirm()`/`alert()` dialogs, which block the event loop and cannot be
/// styled or read by assistive tech consistently.
export type AppDialogRequest =
  | { kind: 'message'; title: string; body: string }
  | {
      kind: 'confirm'
      title: string
      body?: string
      confirmLabel?: string
      danger?: boolean
      action: () => unknown | Promise<unknown>
    }

export function ConfirmDialog({
  request,
  onClose,
  onError,
}: {
  request: AppDialogRequest
  onClose: () => void
  onError?: (message: string) => void
}) {
  const [busy, setBusy] = useState(false)
  if (request.kind === 'message')
    return (
      <AppDialog title={request.title} onClose={onClose}>
        <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-muted">{request.body}</p>
        <footer className="mt-[18px] flex justify-end">
          <Button variant="ghost" size="lg" onClick={onClose}>
            Close
          </Button>
        </footer>
      </AppDialog>
    )
  const confirm = async () => {
    setBusy(true)
    try {
      await request.action()
      onClose()
    } catch (cause) {
      onClose()
      onError?.(cause instanceof Error ? cause.message : String(cause))
    }
  }
  return (
    <AppDialog title={request.title} onClose={busy ? () => {} : onClose}>
      {request.body && (
        <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-muted">{request.body}</p>
      )}
      <footer className="mt-[18px] flex justify-end gap-2.5">
        <Button variant="ghost" size="lg" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant={request.danger ? 'danger' : 'primary'}
          size="lg"
          disabled={busy}
          onClick={() => void confirm()}
        >
          {busy ? 'Working…' : request.confirmLabel || 'Confirm'}
        </Button>
      </footer>
    </AppDialog>
  )
}
