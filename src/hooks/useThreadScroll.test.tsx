import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { rememberThreadScroll } from '../lib/thread-scroll'
import { useThreadScroll } from './useThreadScroll'

function Scroller({ threadKey, contentKey }: { threadKey: string; contentKey: string }) {
  const { scroll, onScroll } = useThreadScroll(threadKey, contentKey)
  return <div data-testid="scroller" ref={scroll} onScroll={onScroll} />
}

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
})
