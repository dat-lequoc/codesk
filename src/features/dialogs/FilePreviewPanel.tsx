import { FileText, ImageIcon, RefreshCw, ShieldAlert, X } from 'lucide-react'

import { Button } from '../../components/ui/button'
import { middleTruncatePath } from '../../lib/format'
import type { FilePreviewState } from '../../hooks/useFilePreview'

/* Transparency checkerboard behind previewed images. */
const checkerboard =
  'bg-ink-975 bg-[linear-gradient(45deg,var(--color-ink-850)_25%,transparent_25%),linear-gradient(-45deg,var(--color-ink-850)_25%,transparent_25%),linear-gradient(45deg,transparent_75%,var(--color-ink-850)_75%),linear-gradient(-45deg,transparent_75%,var(--color-ink-850)_75%)] bg-[length:20px_20px] bg-[position:0_0,0_10px,10px_-10px,-10px_0]'

const stateBlock =
  'flex flex-1 flex-col items-center justify-center gap-2.5 p-7 text-center text-muted'

export function FilePreviewPanel({
  state,
  onClose,
}: {
  state: FilePreviewState
  onClose: () => void
}) {
  const isImage = Boolean(state.file?.data_url)
  return (
    <aside className="absolute top-[45px] right-0 bottom-0 z-10 flex w-full md:w-[var(--file-preview-width)] max-w-full md:min-w-[380px] flex-col border-l border-line bg-sunken shadow-[-18px_0_45px_#0003]">
      <header className="flex h-[52px] shrink-0 items-center gap-2.5 border-b border-line px-3 text-muted">
        {isImage ? (
          <ImageIcon size={15} className="shrink-0" />
        ) : (
          <FileText size={15} className="shrink-0" />
        )}
        <span className="min-w-0 flex-1">
          <strong className="block truncate text-xs font-semibold text-fg-soft">
            {state.file?.name || state.requestedPath.split('/').pop()}
          </strong>
          <small
            className="mt-[3px] block truncate font-mono text-[9.5px] text-dim"
            title={state.file?.path || state.requestedPath}
          >
            {middleTruncatePath(state.file?.path || state.requestedPath, 45)}
          </small>
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="rounded-[7px]"
          title="Close file preview"
          aria-label="Close file preview"
          onClick={onClose}
        >
          <X size={16} />
        </Button>
      </header>
      {state.error ? (
        <div className={stateBlock}>
          <ShieldAlert size={20} />
          <strong className="text-[13px] text-fg-soft">Could not preview this file</strong>
          <span className="max-w-[360px] text-[11px] leading-relaxed [overflow-wrap:anywhere]">
            {state.error}
          </span>
        </div>
      ) : state.file ? (
        isImage ? (
          <div
            className={`grid min-h-0 flex-1 place-items-center overflow-auto p-6 ${checkerboard}`}
          >
            <img
              className="max-h-full max-w-full rounded-sm object-contain shadow-2xl shadow-black/50"
              src={state.file.data_url}
              alt={state.file.name}
            />
          </div>
        ) : (
          <>
            <pre className="scroll-thin m-0 min-h-0 flex-1 overflow-auto bg-ink-900 px-5 py-[18px] font-mono text-[11px]/[1.62] whitespace-pre-wrap text-fg-soft [overflow-wrap:anywhere] [tab-size:2]">
              {state.file.content}
            </pre>
            {state.file.truncated && (
              <footer className="min-h-[34px] shrink-0 border-t border-line px-3 py-2 text-[10px] text-muted">
                Preview limited to the first 2 MB of{' '}
                {Math.ceil(state.file.size / 1024).toLocaleString()} KB.
              </footer>
            )}
          </>
        )
      ) : (
        <div className={stateBlock}>
          <RefreshCw className="animate-spin" size={18} />
          <span className="text-[11px]">Loading file from host…</span>
        </div>
      )}
    </aside>
  )
}
