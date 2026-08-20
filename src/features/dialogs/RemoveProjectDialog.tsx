import { RefreshCw, Trash2 } from 'lucide-react'

import { AppDialog } from '../../components/ui/app-dialog'
import { Button } from '../../components/ui/button'
import type { Project } from '../../types'

export function RemoveProjectDialog({
  project,
  busy,
  onClose,
  onConfirm,
}: {
  project: Project
  busy: boolean
  onClose: () => void
  onConfirm: () => void
}) {
  return (
    <AppDialog
      title={`Remove ${project.name}?`}
      subtitle="This only removes the project from Codesk."
      onClose={onClose}
    >
      <div className="flex min-h-[82px] items-start gap-3 rounded-xl border border-scarlet-950 bg-scarlet-950/70 p-4 text-scarlet-400">
        <Trash2 size={19} className="mt-0.5 shrink-0" />
        <span className="min-w-0">
          <strong className="block truncate font-mono text-[11px] font-normal text-fg">
            {project.path}
          </strong>
          <small className="mt-2 block text-[11px] leading-relaxed text-muted">
            The folder and its files will not be deleted. Re-adding it later restores its Codesk
            history.
          </small>
        </span>
      </div>
      <footer className="mt-[18px] flex justify-end gap-2.5">
        <Button variant="ghost" size="lg" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        <Button variant="danger" size="lg" disabled={busy} onClick={onConfirm}>
          {busy ? (
            <>
              <RefreshCw className="animate-spin" size={14} />
              Removing…
            </>
          ) : (
            <>
              <Trash2 size={14} />
              Remove project
            </>
          )}
        </Button>
      </footer>
    </AppDialog>
  )
}
