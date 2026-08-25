import { describe, expect, it, vi } from 'vitest'

import { forgetPromptHistory, promptHistory, rememberPrompt } from './prompt-history'

describe('prompt history', () => {
  it('keeps submitted prompts oldest first', () => {
    rememberPrompt('first')
    rememberPrompt('second')
    expect(promptHistory()).toEqual(['first', 'second'])
  })

  it('trims the prompt and ignores an empty one', () => {
    rememberPrompt('  spaced  ')
    rememberPrompt('   ')
    expect(promptHistory()).toEqual(['spaced'])
  })

  it('moves a repeated prompt to the newest slot instead of duplicating it', () => {
    rememberPrompt('one')
    rememberPrompt('two')
    rememberPrompt('one')
    expect(promptHistory()).toEqual(['two', 'one'])
  })

  it('drops the oldest entries past the cap', () => {
    for (let index = 0; index < 205; index += 1) rememberPrompt(`prompt ${index}`)
    const history = promptHistory()
    expect(history).toHaveLength(200)
    expect(history[0]).toBe('prompt 5')
    expect(history.at(-1)).toBe('prompt 204')
  })

  it('survives malformed storage rather than throwing mid-keystroke', () => {
    localStorage.setItem('codesk.prompt-history:v1', 'not json{')
    expect(promptHistory()).toEqual([])
    localStorage.setItem('codesk.prompt-history:v1', '{"a":1}')
    expect(promptHistory()).toEqual([])
    localStorage.setItem('codesk.prompt-history:v1', '["keep", 7, "", null]')
    expect(promptHistory()).toEqual(['keep'])
  })

  it('does not let a failed write break the submit it came from', () => {
    rememberPrompt('kept')
    vi.spyOn(localStorage, 'setItem').mockImplementationOnce(() => {
      throw new Error('quota')
    })
    expect(() => rememberPrompt('lost')).not.toThrow()
    vi.restoreAllMocks()
    expect(promptHistory()).toEqual(['kept'])
  })

  it('forgets everything on request', () => {
    rememberPrompt('one')
    forgetPromptHistory()
    expect(promptHistory()).toEqual([])
  })
})
