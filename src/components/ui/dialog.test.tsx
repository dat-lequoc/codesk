import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { AppDialog } from './app-dialog'

/**
 * These pin the behaviour the hand-rolled dialog never had: it rendered inline
 * with no portal, trapped focus nowhere, and could not be dismissed with
 * Escape or a backdrop click — which made Connections a keyboard trap.
 */
const open = (onClose = vi.fn()) => {
  render(
    <AppDialog title="Connections" subtitle="Local and SSH execution hosts" onClose={onClose}>
      <button type="button">Inside</button>
    </AppDialog>,
  )
  return onClose
}

describe('AppDialog', () => {
  it('renders its title and subtitle', () => {
    open()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('Connections')).toBeInTheDocument()
    expect(screen.getByText('Local and SSH execution hosts')).toBeInTheDocument()
  })

  it('is labelled by its title and described by its subtitle', () => {
    open()
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAccessibleName('Connections')
    expect(dialog).toHaveAccessibleDescription('Local and SSH execution hosts')
  })

  it('closes on Escape', async () => {
    const onClose = open()
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
  })

  it('closes when the close button is pressed', async () => {
    const onClose = open()
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
  })

  it('does not close on its own', () => {
    const onClose = open()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('moves focus into the dialog on open', async () => {
    open()
    const dialog = screen.getByRole('dialog')
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))
  })

  it('keeps Tab inside the dialog rather than escaping to the page behind', async () => {
    open()
    const dialog = screen.getByRole('dialog')
    for (let press = 0; press < 6; press++) {
      await userEvent.tab()
      expect(dialog.contains(document.activeElement)).toBe(true)
    }
  })

  it('renders in a portal, outside the mount point', () => {
    const { container } = render(
      <AppDialog title="T" onClose={vi.fn()}>
        <span>body</span>
      </AppDialog>,
    )
    expect(container).toBeEmptyDOMElement()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('renders children', () => {
    open()
    expect(screen.getByRole('button', { name: 'Inside' })).toBeInTheDocument()
  })

  it('omits the subtitle element when none is given', () => {
    render(
      <AppDialog title="Only a title" onClose={vi.fn()}>
        <span>body</span>
      </AppDialog>,
    )
    expect(screen.getByText('Only a title')).toBeInTheDocument()
    expect(screen.queryByText('Local and SSH execution hosts')).not.toBeInTheDocument()
  })

  it('marks the rest of the page inert while open', () => {
    open()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    // Radix hides everything outside the dialog from assistive tech.
    expect(document.body).toHaveAttribute('data-scroll-locked')
  })
})
