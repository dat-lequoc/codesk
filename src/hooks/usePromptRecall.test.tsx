import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'

import { usePromptRecall } from './usePromptRecall'

/** The smallest composer that behaves like the real ones: Enter submits. */
function Composer() {
  const [value, setValue] = useState('')
  const { recall, remember } = usePromptRecall(setValue)
  return (
    <textarea
      aria-label="Message"
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        if (recall(event)) {
          event.preventDefault()
          return
        }
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault()
          remember(value)
          setValue('')
        }
      }}
    />
  )
}

const composer = () => screen.getByRole('textbox') as HTMLTextAreaElement
const up = (init: object = {}) => fireEvent.keyDown(composer(), { key: 'ArrowUp', ...init })
const down = () => fireEvent.keyDown(composer(), { key: 'ArrowDown' })
const submit = async (text: string) => {
  await userEvent.type(composer(), text)
  await userEvent.keyboard('{Enter}')
}

describe('usePromptRecall', () => {
  it('brings back the prompt that was just sent', async () => {
    render(<Composer />)
    await submit('restart the daemon')
    expect(composer()).toHaveValue('')
    up()
    expect(composer()).toHaveValue('restart the daemon')
  })

  it('walks back through older prompts and forward again', async () => {
    render(<Composer />)
    await submit('one')
    await submit('two')
    up()
    expect(composer()).toHaveValue('two')
    up()
    expect(composer()).toHaveValue('one')
    down()
    expect(composer()).toHaveValue('two')
  })

  it('hands the unsent draft back at the end of the walk', async () => {
    render(<Composer />)
    await submit('sent earlier')
    await userEvent.type(composer(), 'half a thought')
    up()
    expect(composer()).toHaveValue('sent earlier')
    down()
    expect(composer()).toHaveValue('half a thought')
  })

  it('stays on the oldest entry instead of wrapping around', async () => {
    render(<Composer />)
    await submit('oldest')
    await submit('newest')
    up()
    up()
    up()
    expect(composer()).toHaveValue('oldest')
  })

  it('does nothing when there is no history to recall', () => {
    render(<Composer />)
    up()
    expect(composer()).toHaveValue('')
  })

  it('restarts from the newest entry once a recalled prompt is edited', async () => {
    render(<Composer />)
    await submit('one')
    await submit('two')
    up()
    up()
    expect(composer()).toHaveValue('one')
    await userEvent.type(composer(), ' more')
    up()
    expect(composer()).toHaveValue('two')
  })

  it('leaves the caret alone inside a multi-line draft', async () => {
    render(<Composer />)
    await submit('sent earlier')
    await userEvent.type(composer(), 'first line{Shift>}{Enter}{/Shift}second line')
    up()
    expect(composer()).toHaveValue('first line\nsecond line')
    // Only the top line hands Up over to history.
    composer().setSelectionRange(2, 2)
    up()
    expect(composer()).toHaveValue('sent earlier')
  })

  it('ignores Up while text is selected or a modifier is held', async () => {
    render(<Composer />)
    await submit('sent earlier')
    await userEvent.type(composer(), 'draft')
    up({ metaKey: true })
    expect(composer()).toHaveValue('draft')
    composer().setSelectionRange(0, 3)
    up()
    expect(composer()).toHaveValue('draft')
  })

  it('does not react to Down while the operator is composing', async () => {
    render(<Composer />)
    await submit('sent earlier')
    await userEvent.type(composer(), 'draft')
    down()
    expect(composer()).toHaveValue('draft')
  })
})
