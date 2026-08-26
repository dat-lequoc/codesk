import { describe, expect, it } from 'vitest'
import {
  extractGoalFromMessage,
  extractTodosFromMessage,
  isContextInjectionMessage,
} from './clean-dsh'
import type { SessionMessage } from '../types'

describe('clean-dsh utils', () => {
  it('detects context injection messages', () => {
    const normalMsg: SessionMessage = {
      id: '1',
      timestamp: '2026-08-25T00:00:00Z',
      role: 'user',
      text: 'Please write a function',
    }
    expect(isContextInjectionMessage(normalMsg)).toBe(false)

    const runtimeContextMsg: SessionMessage = {
      id: '2',
      timestamp: '2026-08-25T00:00:00Z',
      role: 'user',
      text: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nCurrent DSH file policy: danger-full-access.',
    }
    expect(isContextInjectionMessage(runtimeContextMsg)).toBe(true)

    const metaFlaggedMsg: SessionMessage = {
      id: '3',
      timestamp: '2026-08-25T00:00:00Z',
      role: 'user',
      text: 'Some injected text',
      meta: { is_context_injection: true },
    }
    expect(isContextInjectionMessage(metaFlaggedMsg)).toBe(true)
  })

  it('extracts todos from message meta or command string', () => {
    const msgWithMeta: SessionMessage = {
      id: '1',
      timestamp: '2026-08-25T00:00:00Z',
      role: 'assistant',
      text: '',
      meta: {
        todos: [
          { content: 'Step 1', status: 'completed' },
          { content: 'Step 2', status: 'in_progress' },
        ],
      },
    }
    expect(extractTodosFromMessage(msgWithMeta)).toEqual([
      { content: 'Step 1', status: 'completed' },
      { content: 'Step 2', status: 'in_progress' },
    ])

    const msgWithCommandJson: SessionMessage = {
      id: '2',
      timestamp: '2026-08-25T00:00:00Z',
      role: 'assistant',
      text: '',
      meta: {
        command: JSON.stringify({
          todos: [{ content: 'Task A', status: 'pending' }],
        }),
      },
    }
    expect(extractTodosFromMessage(msgWithCommandJson)).toEqual([
      { content: 'Task A', status: 'pending' },
    ])
  })

  it('extracts goal from message meta', () => {
    const msg: SessionMessage = {
      id: '1',
      timestamp: '2026-08-25T00:00:00Z',
      role: 'assistant',
      text: '',
      meta: {
        goal: { objective: 'Improve codesk fork', action: 'create' },
      },
    }
    expect(extractGoalFromMessage(msg)).toEqual({
      objective: 'Improve codesk fork',
      action: 'create',
    })
  })
})
