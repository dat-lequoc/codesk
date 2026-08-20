import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { FilePreviewContext } from '../../hooks/useFilePreview'
import { ConversationMessage, MarkdownContent } from './Markdown'

describe('MarkdownContent', () => {
  it('renders markdown as HTML', () => {
    render(<MarkdownContent text={'# Title\n\nSome **bold** text'} />)
    expect(screen.getByRole('heading', { name: 'Title' })).toBeInTheDocument()
    expect(screen.getByText('bold')).toBeInTheDocument()
  })

  it('renders GFM tables, so remark-gfm is wired up', () => {
    render(<MarkdownContent text={'| a | b |\n| - | - |\n| 1 | 2 |'} />)
    expect(screen.getByRole('table')).toBeInTheDocument()
  })

  it('renders fenced code', () => {
    render(<MarkdownContent text={'```\nnpm test\n```'} />)
    expect(screen.getByText('npm test')).toBeInTheDocument()
  })

  it('linkifies a bare repository URL', () => {
    render(<MarkdownContent text="see github.com/owner/repo" />)
    expect(screen.getByRole('link', { name: 'github.com/owner/repo' })).toHaveAttribute(
      'href',
      'https://github.com/owner/repo',
    )
  })

  it('opens an external link in a new tab with a safe rel', () => {
    render(<MarkdownContent text="[site](https://example.com)" />)
    const link = screen.getByRole('link', { name: 'site' })
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noreferrer')
  })

  it('leaves an in-page anchor as an ordinary link', () => {
    render(<MarkdownContent text="[jump](#section)" />)
    const link = screen.getByRole('link', { name: 'jump' })
    expect(link).not.toHaveAttribute('target')
  })

  it('routes a relative file link to the preview panel instead of navigating', async () => {
    const openFile = vi.fn()
    render(
      <FilePreviewContext.Provider value={openFile}>
        <MarkdownContent text="[App](src/App.tsx)" />
      </FilePreviewContext.Provider>,
    )
    await userEvent.click(screen.getByRole('link', { name: 'App' }))
    expect(openFile).toHaveBeenCalledWith('src/App.tsx')
  })

  it('leaves relative links alone when no preview handler is available', async () => {
    render(<MarkdownContent text="[App](src/App.tsx)" />)
    const link = screen.getByRole('link', { name: 'App' })
    expect(link).toHaveAttribute('href', 'src/App.tsx')
    expect(link).not.toHaveAttribute('target')
  })

  it('renders an empty string without crashing', () => {
    const { container } = render(<MarkdownContent text="" />)
    expect(container.firstChild).toBeInTheDocument()
  })
})

describe('ConversationMessage', () => {
  it('renders a user message', () => {
    render(<ConversationMessage author="user" text="Do the thing" />)
    expect(screen.getByText('Do the thing')).toBeInTheDocument()
  })

  it('renders an assistant message', () => {
    render(<ConversationMessage author="assistant" text="Done" />)
    expect(screen.getByText('Done')).toBeInTheDocument()
  })

  it('strips an environment_context block from what the user sees', () => {
    render(
      <ConversationMessage
        author="user"
        text="<environment_context>cwd=/tmp</environment_context>Real prompt"
      />,
    )
    expect(screen.getByText('Real prompt')).toBeInTheDocument()
    expect(screen.queryByText(/cwd=\/tmp/)).not.toBeInTheDocument()
  })

  it('shows a note when the message was nothing but context', () => {
    render(
      <ConversationMessage author="user" text="<environment_context>only</environment_context>" />,
    )
    expect(screen.getByText('Environment context attached')).toBeInTheDocument()
  })

  it('renders children alongside a user message, for the rewind control', () => {
    render(
      <ConversationMessage author="user" text="Prompt">
        <button type="button">Edit from here</button>
      </ConversationMessage>,
    )
    expect(screen.getByRole('button', { name: 'Edit from here' })).toBeInTheDocument()
  })

  it('does not render the context note when there is real text', () => {
    render(<ConversationMessage author="user" text="Just text" />)
    expect(screen.queryByText('Environment context attached')).not.toBeInTheDocument()
  })
})
