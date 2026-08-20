// Extracted from App.tsx during the Tailwind/module refactor.

export const loadStringSet = (key: string) => {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '[]')
    return new Set<string>(
      Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [],
    )
  } catch {
    return new Set<string>()
  }
}

export const loadExpandedProjects = () => {
  const current = loadStringSet('codesk.expanded-projects:v1')
  return current.size ? current : loadStringSet('codesk.expanded-projects')
}

export const saveStringSet = (key: string, value: Set<string>) => {
  try {
    localStorage.setItem(key, JSON.stringify([...value]))
  } catch {}
}

export const composerDraftStorageKey = 'codesk.composer-drafts:v1'

export const loadComposerDrafts = () => {
  try {
    const value = JSON.parse(localStorage.getItem(composerDraftStorageKey) || '{}')
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, string>)
      : {}
  } catch {
    return {}
  }
}

export const loadComposerDraft = (key: string) => loadComposerDrafts()[key] || ''

export const saveComposerDraft = (key: string, value: string) => {
  try {
    const drafts = loadComposerDrafts()
    if (value) drafts[key] = value
    else delete drafts[key]
    localStorage.setItem(composerDraftStorageKey, JSON.stringify(drafts))
  } catch {}
}
