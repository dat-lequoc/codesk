import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { SlashSuggestion } from '../../lib/kiro'
import { ComposerFooter, ComposerFrame, ComposerInput, SlashCommandMenu } from './Composer'

const suggestions: SlashSuggestion[] = [
  { value: '/usage', label: '/usage', description: 'Show token usage' },
  { value: '/model ', label: '/model', description: 'Switch model', detail: 'Model' },
]

const renderMenu = (overrides: Partial<Parameters<typeof SlashCommandMenu>[0]> = {}) => {
  const props = {
    suggestions,
    selected: 0,
    onSelect: vi.fn(),
    onChoose: vi.fn(),
    ...overrides,
  }
  render(<SlashCommandMenu {...props} />)
  return props
}

describe('SlashCommandMenu', () => {
  it('renders nothing when there are no suggestions', () => {
    const { container } = render(
      <SlashCommandMenu suggestions={[]} selected={0} onSelect={vi.fn()} onChoose={vi.fn()} />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('exposes the list to assistive tech', () => {
    renderMenu()
    expect(screen.getByRole('listbox', { name: 'Kiro commands' })).toBeInTheDocument()
    expect(screen.getAllByRole('option')).toHaveLength(2)
  })

  it('shows each command with its description', () => {
    renderMenu()
    expect(screen.getByText('/usage')).toBeInTheDocument()
    expect(screen.getByText('Show token usage')).toBeInTheDocument()
  })

  it('marks the selected option and only that one', () => {
    renderMenu({ selected: 1 })
    const options = screen.getAllByRole('option')
    expect(options[0]).toHaveAttribute('aria-selected', 'false')
    expect(options[1]).toHaveAttribute('aria-selected', 'true')
  })

  it('chooses a suggestion on click', async () => {
    const props = renderMenu()
    await userEvent.click(screen.getByRole('option', { name: /\/usage/ }))
    expect(props.onChoose).toHaveBeenCalledWith(suggestions[0])
  })

  it('reports hover so the keyboard selection follows the pointer', async () => {
    const props = renderMenu()
    await userEvent.hover(screen.getByRole('option', { name: /\/model/ }))
    expect(props.onSelect).toHaveBeenCalledWith(1)
  })

  it('renders the optional detail badge only when present', () => {
    renderMenu()
    expect(screen.getByText('Model')).toBeInTheDocument()
  })

  it('shows the keyboard hint footer and the position counter', () => {
    renderMenu({ selected: 1 })
    expect(screen.getByText('to navigate')).toBeInTheDocument()
    expect(screen.getByText('2 of 2')).toBeInTheDocument()
  })

  it('hides the hint footer for a single suggestion', () => {
    renderMenu({ suggestions: [suggestions[0]] })
    expect(screen.queryByText('to navigate')).not.toBeInTheDocument()
  })
})

describe('ComposerFrame', () => {
  it('submits the form', async () => {
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault())
    render(
      <ComposerFrame onSubmit={onSubmit}>
        <button type="submit">Send</button>
      </ComposerFrame>,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(onSubmit).toHaveBeenCalledOnce()
  })
})

describe('ComposerInput', () => {
  it('accepts typing and reports changes', async () => {
    const onChange = vi.fn()
    render(<ComposerInput aria-label="Message" onChange={onChange} />)
    await userEvent.type(screen.getByRole('textbox', { name: 'Message' }), 'hi')
    expect(onChange).toHaveBeenCalled()
  })

  it('forwards a ref so the screen can focus it', () => {
    const ref = { current: null as HTMLTextAreaElement | null }
    render(<ComposerInput ref={ref} aria-label="Message" />)
    expect(ref.current).toBeInstanceOf(HTMLTextAreaElement)
  })
})

describe('ComposerFooter', () => {
  it('renders its children', () => {
    render(
      <ComposerFooter>
        <span>Resume · Codex</span>
      </ComposerFooter>,
    )
    expect(screen.getByText('Resume · Codex')).toBeInTheDocument()
  })
})
