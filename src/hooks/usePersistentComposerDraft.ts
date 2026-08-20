// Extracted from App.tsx during the Tailwind/module refactor.

import { loadComposerDraft, saveComposerDraft } from '../lib/storage'
import { useState } from 'react'
export function usePersistentComposerDraft(key: string) {
  const [value, setValueState] = useState(() => loadComposerDraft(key))
  const setValue = (next: string | ((current: string) => string)) =>
    setValueState((current) => {
      const resolved = typeof next === 'function' ? next(current) : next
      saveComposerDraft(key, resolved)
      return resolved
    })
  return [value, setValue] as const
}
