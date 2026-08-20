import { describe, expect, it, vi } from 'vitest'

import {
  composerDraftStorageKey,
  loadComposerDraft,
  loadComposerDrafts,
  loadExpandedProjects,
  loadStringSet,
  saveComposerDraft,
  saveStringSet,
} from './storage'

describe('loadStringSet / saveStringSet', () => {
  it('round-trips a set', () => {
    saveStringSet('k', new Set(['a', 'b']))
    expect(loadStringSet('k')).toEqual(new Set(['a', 'b']))
  })

  it('returns an empty set for a key that was never written', () => {
    expect(loadStringSet('missing')).toEqual(new Set())
  })

  it('survives malformed JSON rather than throwing during render', () => {
    localStorage.setItem('k', 'not json{')
    expect(loadStringSet('k')).toEqual(new Set())
  })

  it('ignores a stored value that is not an array', () => {
    localStorage.setItem('k', '{"a":1}')
    expect(loadStringSet('k')).toEqual(new Set())
  })

  it('filters out non-string members', () => {
    localStorage.setItem('k', '["a", 1, null, "b"]')
    expect(loadStringSet('k')).toEqual(new Set(['a', 'b']))
  })

  it('writes an empty set without error', () => {
    saveStringSet('k', new Set())
    expect(loadStringSet('k')).toEqual(new Set())
  })

  it('swallows a storage write failure instead of breaking the caller', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    expect(() => saveStringSet('k', new Set(['a']))).not.toThrow()
  })
})

describe('loadExpandedProjects', () => {
  it('reads the versioned key', () => {
    saveStringSet('codesk.expanded-projects:v1', new Set(['host:p1']))
    expect(loadExpandedProjects()).toEqual(new Set(['host:p1']))
  })

  it('falls back to the pre-version key so existing users keep their tree open', () => {
    saveStringSet('codesk.expanded-projects', new Set(['host:legacy']))
    expect(loadExpandedProjects()).toEqual(new Set(['host:legacy']))
  })

  it('prefers the versioned key when both exist', () => {
    saveStringSet('codesk.expanded-projects', new Set(['legacy']))
    saveStringSet('codesk.expanded-projects:v1', new Set(['current']))
    expect(loadExpandedProjects()).toEqual(new Set(['current']))
  })

  it('returns an empty set when neither key exists', () => {
    expect(loadExpandedProjects()).toEqual(new Set())
  })
})

describe('composer drafts', () => {
  it('round-trips a draft for a key', () => {
    saveComposerDraft('run:1', 'half a thought')
    expect(loadComposerDraft('run:1')).toBe('half a thought')
  })

  it('keeps drafts for different conversations separate', () => {
    saveComposerDraft('run:1', 'one')
    saveComposerDraft('run:2', 'two')
    expect(loadComposerDraft('run:1')).toBe('one')
    expect(loadComposerDraft('run:2')).toBe('two')
  })

  it('deletes the entry when the draft is cleared, rather than storing empty', () => {
    saveComposerDraft('run:1', 'text')
    saveComposerDraft('run:1', '')
    expect(loadComposerDrafts()).not.toHaveProperty('run:1')
    expect(loadComposerDraft('run:1')).toBe('')
  })

  it('returns empty string for an unknown key', () => {
    expect(loadComposerDraft('nope')).toBe('')
  })

  it('recovers from malformed stored drafts', () => {
    localStorage.setItem(composerDraftStorageKey, '[]')
    expect(loadComposerDrafts()).toEqual({})
    localStorage.setItem(composerDraftStorageKey, 'broken{')
    expect(loadComposerDrafts()).toEqual({})
  })

  it('does not let one bad write lose the other drafts', () => {
    saveComposerDraft('run:1', 'keep me')
    vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
      throw new Error('nope')
    })
    expect(() => saveComposerDraft('run:2', 'lost')).not.toThrow()
    vi.restoreAllMocks()
    expect(loadComposerDraft('run:1')).toBe('keep me')
  })
})
