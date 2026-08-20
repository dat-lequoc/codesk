import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { cn } from '../../lib/cn'
import { Badge } from './badge'
import { Button } from './button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './dropdown-menu'
import { Input, Textarea } from './input'
import { Spinner } from './spinner'
import { StatusDot } from './status-dot'

describe('cn', () => {
  it('joins class names', () => {
    expect(cn('a', 'b')).toBe('a b')
  })

  it('drops falsy values', () => {
    const off = false as boolean
    expect(cn('a', off && 'b', undefined, null, '', 'c')).toBe('a c')
  })

  it('lets a later Tailwind utility win over an earlier conflicting one', () => {
    expect(cn('max-w-xl', 'max-w-lg')).toBe('max-w-lg')
    expect(cn('p-2', 'p-4')).toBe('p-4')
  })

  it('keeps utilities that do not conflict', () => {
    expect(cn('flex', 'items-center')).toBe('flex items-center')
  })

  it('handles conditional object syntax', () => {
    expect(cn({ a: true, b: false })).toBe('a')
  })
})

describe('Button', () => {
  it('renders its label and responds to a click', async () => {
    const onClick = vi.fn()
    render(<Button onClick={onClick}>Connect</Button>)
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('does not fire while disabled', async () => {
    const onClick = vi.fn()
    render(
      <Button disabled onClick={onClick}>
        Connect
      </Button>,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect(onClick).not.toHaveBeenCalled()
  })

  it('applies a caller class over the variant default', () => {
    render(<Button className="max-w-lg">X</Button>)
    expect(screen.getByRole('button')).toHaveClass('max-w-lg')
  })

  it('forwards arbitrary button attributes', () => {
    render(
      <Button type="submit" aria-label="Send message">
        →
      </Button>,
    )
    expect(screen.getByRole('button', { name: 'Send message' })).toHaveAttribute('type', 'submit')
  })

  it('renders every variant and size without error', () => {
    for (const variant of ['primary', 'secondary', 'outline', 'ghost', 'danger'] as const)
      for (const size of ['sm', 'md', 'lg', 'icon', 'icon-sm'] as const) {
        const { unmount } = render(
          <Button variant={variant} size={size}>
            x
          </Button>,
        )
        expect(screen.getByRole('button')).toBeInTheDocument()
        unmount()
      }
  })
})

describe('Spinner', () => {
  it('exposes itself to assistive tech as a status', () => {
    render(<Spinner />)
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument()
  })

  it('scales with the size prop', () => {
    render(<Spinner size={24} />)
    expect(screen.getByRole('status')).toHaveStyle({ width: '24px', height: '24px' })
  })

  it('keeps a visible border at very small sizes', () => {
    render(<Spinner size={4} />)
    expect(screen.getByRole('status')).toHaveStyle({ borderWidth: '1.5px' })
  })
})

describe('StatusDot', () => {
  it('renders a tone without error and forwards a title', () => {
    for (const tone of ['online', 'connecting', 'offline', 'error'] as const) {
      const { unmount } = render(<StatusDot tone={tone} title={tone} data-testid="dot" />)
      expect(screen.getByTestId('dot')).toHaveAttribute('title', tone)
      unmount()
    }
  })

  it('defaults to offline when no tone is given', () => {
    render(<StatusDot data-testid="dot" />)
    expect(screen.getByTestId('dot')).toBeInTheDocument()
  })
})

describe('Badge', () => {
  it('renders its content', () => {
    render(<Badge tone="success">Managed</Badge>)
    expect(screen.getByText('Managed')).toBeInTheDocument()
  })
})

describe('Input / Textarea', () => {
  it('accepts typing', async () => {
    render(<Input aria-label="Display name" />)
    const input = screen.getByRole('textbox', { name: 'Display name' })
    await userEvent.type(input, 'This Mac')
    expect(input).toHaveValue('This Mac')
  })

  it('renders a placeholder', () => {
    render(<Textarea placeholder="Ask Codex to do anything" />)
    expect(screen.getByPlaceholderText('Ask Codex to do anything')).toBeInTheDocument()
  })

  it('does not accept typing while disabled', async () => {
    render(<Input aria-label="Alias" disabled />)
    const input = screen.getByRole('textbox', { name: 'Alias' })
    await userEvent.type(input, 'x')
    expect(input).toHaveValue('')
  })
})

describe('DropdownMenu', () => {
  const renderMenu = (onSelect = vi.fn()) => {
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Project actions</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onSelect={onSelect}>New chat</DropdownMenuItem>
          <DropdownMenuItem disabled>Archive chats</DropdownMenuItem>
          <DropdownMenuItem destructive>Remove project</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    )
    return onSelect
  }

  it('stays closed until the trigger is used', () => {
    renderMenu()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('opens on click and lists its items', async () => {
    renderMenu()
    await userEvent.click(screen.getByRole('button', { name: 'Project actions' }))
    expect(await screen.findByRole('menu')).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'New chat' })).toBeInTheDocument()
  })

  it('selects an item and closes', async () => {
    const onSelect = renderMenu()
    await userEvent.click(screen.getByRole('button', { name: 'Project actions' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'New chat' }))
    expect(onSelect).toHaveBeenCalledOnce()
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
  })

  // The hand-rolled sidebar menu needed its own pointerdown/keydown/resize
  // listeners for this; Radix owns it now.
  it('closes on Escape', async () => {
    renderMenu()
    await userEvent.click(screen.getByRole('button', { name: 'Project actions' }))
    expect(await screen.findByRole('menu')).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
  })

  it('marks a disabled item as disabled and does not select it', async () => {
    const onSelect = vi.fn()
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem disabled onSelect={onSelect}>
            Archive chats
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Open' }))
    const item = await screen.findByRole('menuitem', { name: 'Archive chats' })
    expect(item).toHaveAttribute('data-disabled')
    await userEvent.click(item)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('navigates items with the keyboard', async () => {
    renderMenu()
    await userEvent.click(screen.getByRole('button', { name: 'Project actions' }))
    await screen.findByRole('menu')
    await userEvent.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitem', { name: 'New chat' })).toHaveFocus()
  })
})
