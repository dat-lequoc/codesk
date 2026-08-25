import { useRef } from 'react'
import type { KeyboardEvent } from 'react'

import { promptHistory, rememberPrompt } from '../lib/prompt-history'

// Arrow keys still have to edit multi-line prompts, so recall only takes over
// at the edges: Up when the caret sits on the first line, Down on the last.
const onFirstLine = (value: string, caret: number) => !value.slice(0, caret).includes('\n')
const onLastLine = (value: string, caret: number) => !value.slice(caret).includes('\n')

export function usePromptRecall(setValue: (value: string) => void) {
  // Position in the history list, `null` while the operator is composing, plus
  // the text that was in the box when recall started so Down can hand it back.
  const cursor = useRef<number | null>(null)
  const draft = useRef('')
  const recalled = useRef<string | null>(null)

  const forget = () => {
    cursor.current = null
    draft.current = ''
    recalled.current = null
  }

  const apply = (node: HTMLTextAreaElement, next: string) => {
    recalled.current = next
    setValue(next)
    // The new value only reaches the DOM on the next render; park the caret at
    // the end once it does, so another Up keeps walking history instead of
    // moving around inside the recalled text.
    requestAnimationFrame(() => {
      node.focus()
      node.setSelectionRange(next.length, next.length)
    })
  }

  const recall = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return false
    if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return false
    const node = event.currentTarget
    if (node.selectionStart !== node.selectionEnd) return false
    const value = node.value
    const caret = node.selectionStart ?? value.length
    // Any edit to a recalled prompt means it is a draft again, so the next Up
    // restarts from the newest entry rather than from where we left off.
    if (cursor.current !== null && value !== recalled.current) forget()
    const history = promptHistory()
    if (event.key === 'ArrowUp') {
      if (!onFirstLine(value, caret)) return false
      const index = cursor.current === null ? history.length - 1 : cursor.current - 1
      // Past the oldest entry: stay on it, but keep swallowing the key so the
      // caret does not suddenly jump out of the recalled prompt.
      if (index < 0) return cursor.current !== null
      if (cursor.current === null) draft.current = value
      cursor.current = index
      apply(node, history[index])
      return true
    }
    if (cursor.current === null || !onLastLine(value, caret)) return false
    const index = cursor.current + 1
    const done = index >= history.length
    cursor.current = done ? null : index
    apply(node, done ? draft.current : history[index])
    return true
  }

  // Recording on submit rather than on success: the prompt is worth keeping
  // even when the send fails, and especially when it succeeds but the harness
  // never shows it.
  const remember = (prompt: string) => {
    rememberPrompt(prompt)
    forget()
  }

  return { recall, remember }
}
