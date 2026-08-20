// Extracted from App.tsx during the Tailwind/module refactor.

import { api } from '../api'
import { linkedFilePath } from '../lib/links'
import type { FileContent } from '../types'
import { createContext, useEffect, useState } from 'react'
/** Lets nested markdown links open the file preview panel. */
export const FilePreviewContext = createContext<((href: string) => void) | null>(null)

export type FilePreviewState = { requestedPath: string; file?: FileContent; error?: string }

export function useFilePreview(hostId: string, cwd: string) {
  const [preview, setPreview] = useState<FilePreviewState | null>(null)
  useEffect(() => {
    setPreview(null)
  }, [hostId, cwd])
  const open = (href: string) => {
    const path = linkedFilePath(href, cwd)
    setPreview({ requestedPath: path })
    void api
      .file(hostId, path)
      .then((file) => setPreview({ requestedPath: path, file }))
      .catch((cause) =>
        setPreview({
          requestedPath: path,
          error: cause instanceof Error ? cause.message : String(cause),
        }),
      )
  }
  return { preview, open, close: () => setPreview(null) }
}
