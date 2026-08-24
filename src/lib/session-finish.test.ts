import { describe, expect, it } from 'vitest'

import {
  forgetSessionFinishSeen,
  markSessionFinishSeen,
  resetSessionFinishSeen,
  sessionFinishSeen,
  subscribeSessionFinishSeen,
} from './session-finish'

describe('session finish seen', () => {
  it('remembers a checked conversation until the next run', () => {
    resetSessionFinishSeen()
    markSessionFinishSeen('session:a')
    expect(sessionFinishSeen('session:a')).toBe(true)
    expect(sessionFinishSeen('session:b')).toBe(false)
    forgetSessionFinishSeen('session:a')
    expect(sessionFinishSeen('session:a')).toBe(false)
  })

  it('notifies subscribers only when the set actually changes', () => {
    resetSessionFinishSeen()
    const listener = { calls: 0, fn: () => listener.calls++ }
    const unsubscribe = subscribeSessionFinishSeen(listener.fn)
    markSessionFinishSeen('session:a')
    markSessionFinishSeen('session:a')
    forgetSessionFinishSeen('session:a')
    forgetSessionFinishSeen('session:a')
    expect(listener.calls).toBe(2)
    unsubscribe()
  })
})
