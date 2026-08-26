import type { SessionMessage } from '../types'

export interface TodoItemData {
  content: string
  status: 'completed' | 'in_progress' | 'pending'
}

/** Check if a session message represents an injected runtime context or system prompt. */
export function isContextInjectionMessage(msg: SessionMessage): boolean {
  if (msg.meta?.is_context_injection) return true
  const text = msg.text.trim()
  return (
    text.startsWith('Current runtime context.') ||
    text.startsWith('The approval policy changed') ||
    text.startsWith('Additional instructions from:') ||
    text.startsWith('<environment_context') ||
    text.includes('Current DSH file policy:')
  )
}

/** Extract todos from a message if present in meta or text. */
export function extractTodosFromMessage(msg: SessionMessage): TodoItemData[] | null {
  if (msg.meta?.todos && Array.isArray(msg.meta.todos)) {
    return msg.meta.todos as TodoItemData[]
  }
  if (msg.meta?.command && typeof msg.meta.command === 'string') {
    try {
      const parsed = JSON.parse(msg.meta.command)
      if (parsed.todos && Array.isArray(parsed.todos)) return parsed.todos
    } catch {}
  }
  return null
}

/** Extract goal data from a message if present. */
export function extractGoalFromMessage(
  msg: SessionMessage,
): { objective?: string; action?: string; status?: string } | null {
  if (msg.meta?.goal && typeof msg.meta.goal === 'object') {
    return msg.meta.goal as { objective?: string; action?: string; status?: string }
  }
  if (msg.meta?.tool === 'create_goal' || msg.meta?.tool === 'update_goal') {
    if (msg.meta?.command && typeof msg.meta.command === 'string') {
      try {
        return JSON.parse(msg.meta.command)
      } catch {}
    }
  }
  return null
}
