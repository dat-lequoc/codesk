import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '../../api'
import type { FileChange } from '../../lib/activity'
import { makeRun, resetIds } from '../../test/factories'
import { FileChangeCard } from './FileChangeCard'

beforeEach(resetIds)

const run = () => makeRun({ hostId: 'host-a', cwd: '/home/dev/codesk' })
const changes = (count: number): FileChange[] =>
  Array.from({ length: count }, (_, index) => ({
    path: `src/file${index}.ts`,
    diff: '+added\n-removed',
  }))

const renderCard = (props: Partial<Parameters<typeof FileChangeCard>[0]> = {}) =>
  render(<FileChangeCard changes={changes(2)} text="" run={run()} {...props} />)

describe('FileChangeCard', () => {
  it('summarises how many files changed', () => {
    renderCard()
    expect(screen.getByText('Edited 2 files')).toBeInTheDocument()
  })

  it('uses the singular for one file', () => {
    renderCard({ changes: changes(1) })
    expect(screen.getByText('Edited 1 file')).toBeInTheDocument()
  })

  it('totals additions and deletions across the changes', () => {
    renderCard()
    expect(screen.getByText('+2')).toBeInTheDocument()
    expect(screen.getByText('-2')).toBeInTheDocument()
  })

  it('lists each changed path', () => {
    renderCard()
    expect(screen.getByText('src/file0.ts')).toBeInTheDocument()
    expect(screen.getByText('src/file1.ts')).toBeInTheDocument()
  })

  it('shows at most four files before offering to expand', () => {
    renderCard({ changes: changes(6) })
    expect(screen.getAllByTitle('Copy path')).toHaveLength(4)
    expect(screen.getByRole('button', { name: /Show 2 more files/ })).toBeInTheDocument()
  })

  it('expands to the full list and back', async () => {
    renderCard({ changes: changes(6) })
    await userEvent.click(screen.getByRole('button', { name: /Show 2 more files/ }))
    expect(screen.getAllByTitle('Copy path')).toHaveLength(6)
    await userEvent.click(screen.getByRole('button', { name: /Show fewer/ }))
    expect(screen.getAllByTitle('Copy path')).toHaveLength(4)
  })

  it('does not offer to expand when everything already fits', () => {
    renderCard({ changes: changes(3) })
    expect(screen.queryByRole('button', { name: /Show/ })).not.toBeInTheDocument()
  })

  it('toggles the diff open and closed', async () => {
    renderCard()
    const review = screen.getByRole('button', { name: /Review/ })
    await userEvent.click(review)
    expect(screen.getByRole('button', { name: /Hide diff/ })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /Hide diff/ }))
    expect(screen.getByRole('button', { name: /Review/ })).toBeInTheDocument()
  })

  it('hides the review control when there is no diff to show', () => {
    renderCard({ changes: [{ path: 'a.ts' }], text: '' })
    expect(screen.queryByRole('button', { name: /Review/ })).not.toBeInTheDocument()
  })

  it('copies a path to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    renderCard({ changes: changes(1) })
    await userEvent.click(screen.getByTitle('Copy path'))
    expect(writeText).toHaveBeenCalledWith('src/file0.ts')
  })

  it('resolves a relative path against the run cwd when opening a file', async () => {
    const openPath = vi.spyOn(api, 'openPath').mockResolvedValue(undefined as never)
    renderCard({ changes: changes(1) })
    await userEvent.click(screen.getByTitle('Open file'))
    expect(openPath).toHaveBeenCalledWith('host-a', '/home/dev/codesk/src/file0.ts')
  })

  it('falls back to raw diff text when no structured changes arrived', () => {
    render(<FileChangeCard changes={[]} text={'+one\n-two'} run={run()} />)
    expect(screen.getByText('File changes')).toBeInTheDocument()
  })

  it('names a change with no path rather than rendering a blank row', () => {
    renderCard({ changes: [{ diff: '+a' }] })
    expect(screen.getByText('Unknown file')).toBeInTheDocument()
  })
})
