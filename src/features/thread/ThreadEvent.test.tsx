import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { makeEvent, makeRun, resetIds } from '../../test/factories'
import type { RunEvent } from '../../types'
import { ThreadEvent } from './ThreadEvent'

beforeEach(resetIds)

const show = (event: RunEvent, overrides: Record<string, unknown> = {}) => {
  const onRewind = vi.fn()
  const view = render(
    <ThreadEvent
      event={event}
      run={makeRun({ hostId: 'host-a', cwd: '/home/dev/codesk' })}
      resolved={false}
      canRewind={false}
      onRewind={onRewind}
      {...overrides}
    />,
  )
  return { ...view, onRewind }
}

describe('ThreadEvent — messages', () => {
  it('renders an assistant message', () => {
    show(makeEvent({ kind: 'assistant.message', payload: { text: 'All done' } }))
    expect(screen.getByText('All done')).toBeInTheDocument()
  })

  it('renders a user message', () => {
    show(makeEvent({ kind: 'user.message', payload: { text: 'Do the thing' } }))
    expect(screen.getByText('Do the thing')).toBeInTheDocument()
  })

  it('renders reasoning', () => {
    show(makeEvent({ kind: 'reasoning.message', payload: { text: 'Considering options' } }))
    expect(screen.getByText('Considering options')).toBeInTheDocument()
  })
})

describe('ThreadEvent — rewind', () => {
  const userEventWithTurn = () =>
    makeEvent({ kind: 'user.message', payload: { text: 'Original', turn_id: 'turn-1' } })

  it('offers to branch from a user message when rewinding is possible', () => {
    show(userEventWithTurn(), { canRewind: true })
    expect(screen.getByTitle('Edit this message and branch from here')).toBeInTheDocument()
  })

  it('hides the control when rewinding is not available', () => {
    show(userEventWithTurn(), { canRewind: false })
    expect(screen.queryByTitle('Edit this message and branch from here')).not.toBeInTheDocument()
  })

  it('reports the turn and its text when used', async () => {
    const { onRewind } = show(userEventWithTurn(), { canRewind: true })
    await userEvent.click(screen.getByTitle('Edit this message and branch from here'))
    expect(onRewind).toHaveBeenCalledWith('turn-1', 'Original')
  })

  it('hides the control on a message with no turn id', () => {
    show(makeEvent({ kind: 'user.message', payload: { text: 'x' } }), { canRewind: true })
    expect(screen.queryByTitle('Edit this message and branch from here')).not.toBeInTheDocument()
  })
})

describe('ThreadEvent — turn boundaries', () => {
  it('renders nothing for a turn start', () => {
    const { container } = show(makeEvent({ kind: 'turn.started' }))
    expect(container).toBeEmptyDOMElement()
  })

  it('reports how long a completed turn took', () => {
    show(makeEvent({ kind: 'turn.completed' }), { durationMs: 90_000 })
    expect(screen.getByText('Worked for 1m 30s')).toBeInTheDocument()
  })

  it('falls back to a plain label with no duration', () => {
    show(makeEvent({ kind: 'turn.completed' }))
    expect(screen.getByText('Turn completed')).toBeInTheDocument()
  })
})

describe('ThreadEvent — commands and tools', () => {
  it('renders a command with its output', () => {
    show(makeEvent({ kind: 'tool.output', payload: { tool_title: 'npm test', text: 'ok' } }))
    expect(screen.getByText('npm test')).toBeInTheDocument()
    expect(screen.getByText('ok')).toBeInTheDocument()
  })

  it('does not repeat the command as its own output', () => {
    show(makeEvent({ kind: 'tool.output', payload: { tool_title: 'ls', text: 'ls' } }))
    expect(screen.getAllByText('ls')).toHaveLength(1)
  })

  it('marks a stderr command as failed', () => {
    show(
      makeEvent({
        kind: 'tool.output',
        channel: 'stderr',
        payload: { tool_title: 'build', text: 'boom' },
      }),
    )
    expect(screen.getByText('build')).toBeInTheDocument()
  })

  it('renders a generic tool output row for anything unrecognised', () => {
    show(makeEvent({ kind: 'provider.custom', payload: { text: 'raw' } }))
    expect(screen.getByText('provider custom')).toBeInTheDocument()
  })
})

describe('ThreadEvent — file changes', () => {
  // Live `file.change` events are grouped into the activity ledger before they
  // reach ThreadEvent; what arrives here carries the changes on a tool event.
  it('renders a file-change card when changes ride along with tool output', () => {
    show(
      makeEvent({
        kind: 'tool.output',
        payload: { text: 'edited', changes: [{ path: 'src/App.tsx', diff: '+a' }] },
      }),
    )
    expect(screen.getByText('src/App.tsx')).toBeInTheDocument()
  })
})

describe('ThreadEvent — noise', () => {
  it('renders nothing for a command list update', () => {
    const { container } = show(makeEvent({ kind: 'commands.updated' }))
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing for an unknown kind with no text', () => {
    const { container } = show(makeEvent({ kind: 'provider.noise', payload: {} }))
    expect(container).toBeEmptyDOMElement()
  })

  it('renders a lifecycle status row even without text', () => {
    show(makeEvent({ kind: 'run.completed', payload: { exit_code: 0 } }))
    expect(screen.getByText('run completed')).toBeInTheDocument()
    expect(screen.getByText('0')).toBeInTheDocument()
  })
})
