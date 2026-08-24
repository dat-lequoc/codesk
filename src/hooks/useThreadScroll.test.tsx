import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { rememberThreadScroll } from '../lib/thread-scroll'
import { useThreadScroll } from './useThreadScroll'

function Scroller({
  threadKey,
  contentKey,
  ready,
  onAtEnd,
}: {
  threadKey: string
  contentKey: string
  ready?: boolean
  onAtEnd?: () => void
}) {
  const { scroll, onScroll } = useThreadScroll(threadKey, contentKey, { ready, onAtEnd })
  return <div data-testid="scroller" ref={scroll} onScroll={onScroll} />
}

const nextFrame = () =>
  act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))

const size = (element: HTMLElement, height: number, view: number) => {
  Object.defineProperty(element, 'scrollHeight', { configurable: true, value: height })
  Object.defineProperty(element, 'clientHeight', { configurable: true, value: view })
}

describe('useThreadScroll', () => {
  it('pins a first visit to the bottom once the thread has size', () => {
    const { rerender } = render(<Scroller threadKey="thread-a" contentKey="0" />)
    const element = screen.getByTestId('scroller')
    size(element, 4000, 400)
    rerender(<Scroller threadKey="thread-a" contentKey="1" />)
    expect(element.scrollTop).toBe(4000)
  })

  it('restores a mid-thread offset after the screen remounts', () => {
    rememberThreadScroll('thread-a', { following: false, top: 640 })
    const { rerender } = render(<Scroller threadKey="thread-a" contentKey="0" />)
    const element = screen.getByTestId('scroller')
    size(element, 4000, 400)
    rerender(<Scroller threadKey="thread-a" contentKey="ready" />)
    expect(element.scrollTop).toBe(640)
  })

  it('remembers leaving the bottom so the next mount does not jump there', () => {
    const { rerender, unmount } = render(<Scroller threadKey="thread-a" contentKey="0" />)
    const first = screen.getByTestId('scroller')
    size(first, 4000, 400)
    rerender(<Scroller threadKey="thread-a" contentKey="1" />)
    first.scrollTop = 200
    fireEvent.scroll(first)
    unmount()

    const { rerender: rerenderAgain } = render(<Scroller threadKey="thread-a" contentKey="2" />)
    const again = screen.getByTestId('scroller')
    size(again, 4000, 400)
    rerenderAgain(<Scroller threadKey="thread-a" contentKey="3" />)
    expect(again.scrollTop).toBe(200)
  })

  it('notifies once the restored position is the bottom', async () => {
    const onAtEnd = vi.fn()
    const { rerender } = render(
      <Scroller threadKey="thread-end" contentKey="0" onAtEnd={onAtEnd} />,
    )
    const element = screen.getByTestId('scroller')
    size(element, 4000, 400)
    rerender(<Scroller threadKey="thread-end" contentKey="1" onAtEnd={onAtEnd} />)
    await nextFrame()
    expect(onAtEnd).toHaveBeenCalled()
  })

  it('does not notify while the thread is still loading', async () => {
    const onAtEnd = vi.fn()
    const { rerender } = render(
      <Scroller threadKey="thread-load" contentKey="0" ready={false} onAtEnd={onAtEnd} />,
    )
    const element = screen.getByTestId('scroller')
    size(element, 400, 400)
    rerender(<Scroller threadKey="thread-load" contentKey="1" ready={false} onAtEnd={onAtEnd} />)
    await nextFrame()
    expect(onAtEnd).not.toHaveBeenCalled()
  })

  it('does not notify when restoring a mid-thread offset', async () => {
    rememberThreadScroll('thread-mid', { following: false, top: 640 })
    const onAtEnd = vi.fn()
    const { rerender } = render(
      <Scroller threadKey="thread-mid" contentKey="0" onAtEnd={onAtEnd} />,
    )
    const element = screen.getByTestId('scroller')
    size(element, 4000, 400)
    rerender(<Scroller threadKey="thread-mid" contentKey="ready" onAtEnd={onAtEnd} />)
    await nextFrame()
    expect(onAtEnd).not.toHaveBeenCalled()
  })

  it('notifies after the user scrolls to the bottom', async () => {
    rememberThreadScroll('thread-scroll-end', { following: false, top: 200 })
    const onAtEnd = vi.fn()
    const { rerender } = render(
      <Scroller threadKey="thread-scroll-end" contentKey="0" onAtEnd={onAtEnd} />,
    )
    const element = screen.getByTestId('scroller')
    size(element, 4000, 400)
    rerender(<Scroller threadKey="thread-scroll-end" contentKey="1" onAtEnd={onAtEnd} />)
    await nextFrame()
    element.scrollTop = 3600
    fireEvent.scroll(element)
    expect(onAtEnd).toHaveBeenCalled()
  })
})
