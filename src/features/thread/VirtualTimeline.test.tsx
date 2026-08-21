import { render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { describe, expect, it } from 'vitest'

import { VirtualTimeline } from './VirtualTimeline'

const items = (count: number) => Array.from({ length: count }, (_, index) => `item-${index}`)

function renderTimeline(count: number) {
  const scrollRef = createRef<HTMLDivElement>()
  return render(
    <div ref={scrollRef} style={{ height: 400, overflow: 'auto' }}>
      <VirtualTimeline
        items={items(count)}
        scrollRef={scrollRef}
        itemKey={(item) => item}
        renderItem={(item) => <p>{item}</p>}
        before={<p>before-slot</p>}
      />
    </div>,
  )
}

describe('VirtualTimeline', () => {
  it('renders every row without virtualization below the threshold', () => {
    renderTimeline(5)
    for (let index = 0; index < 5; index++)
      expect(screen.getByText(`item-${index}`)).toBeInTheDocument()
    expect(screen.getByText('before-slot')).toBeInTheDocument()
  })

  it('virtualizes above the threshold instead of mounting every row', () => {
    renderTimeline(500)
    // jsdom reports a zero-height viewport, so the virtualizer mounts at most
    // its overscan window (zero rows here). Mounting far fewer than the 500
    // items proves the threshold switched modes; the non-virtual path above
    // proves rows render when active.
    expect(screen.queryAllByText(/^item-/).length).toBeLessThan(100)
    expect(screen.getByText('before-slot')).toBeInTheDocument()
  })
})
