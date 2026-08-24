import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { sessionNotificationKey } from '../../lib/keys'
import { markSessionFinishSeen, resetSessionFinishSeen } from '../../lib/session-finish'
import { makeSession } from '../../test/factories'
import { SessionRow } from './SessionRow'

beforeEach(resetSessionFinishSeen)

const mount = (session = makeSession({ status: 'stopped', title: 'Just finished' })) =>
  render(
    <SessionRow
      session={session}
      sessionId={`${session.hostId}:${session.id}`}
      selected={false}
      unread={false}
      pinned={false}
      onSelect={vi.fn()}
      onTogglePin={vi.fn()}
      onArchive={vi.fn()}
    />,
  )

describe('SessionRow', () => {
  it('shows a just-finished marker until the thread has been checked', () => {
    const session = makeSession({ status: 'stopped', title: 'Just finished' })
    mount(session)
    expect(screen.getByLabelText('Just finished')).toBeInTheDocument()
    act(() => {
      markSessionFinishSeen(sessionNotificationKey(session))
    })
    expect(screen.queryByLabelText('Just finished')).not.toBeInTheDocument()
  })

  it('does not mark an idle conversation as just finished', () => {
    mount(makeSession({ status: 'idle', title: 'Idle chat' }))
    expect(screen.queryByLabelText('Just finished')).not.toBeInTheDocument()
  })
})
