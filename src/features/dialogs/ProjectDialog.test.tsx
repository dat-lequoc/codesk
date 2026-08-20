import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '../../api'
import { makeHost, makeProject, resetIds } from '../../test/factories'
import type { FileEntry, FileListing } from '../../types'
import { ProjectDialog } from './ProjectDialog'

beforeEach(resetIds)

const entry = (name: string, is_git = false): FileEntry => ({
  name,
  path: `/home/dev/${name}`,
  is_dir: true,
  is_git,
})

const listing = (entries: FileEntry[], current_path = '/home/dev'): FileListing => ({
  current_path,
  parent_path: '/home',
  home_path: '/home/dev',
  entries,
})

const local = makeHost({ id: 'host-a', name: 'This Mac', type: 'local', status: 'online' })

const show = (entries = [entry('codesk', true), entry('notes')]) => {
  vi.spyOn(api, 'files').mockResolvedValue(listing(entries))
  const onClose = vi.fn()
  const onCreated = vi.fn()
  render(<ProjectDialog hosts={[local]} onClose={onClose} onCreated={onCreated} />)
  return { onClose, onCreated }
}

describe('ProjectDialog — browsing', () => {
  it('lists folders for the selected host', async () => {
    show()
    expect(await screen.findByText('codesk')).toBeInTheDocument()
    expect(screen.getByText('notes')).toBeInTheDocument()
  })

  it('marks a git repository', async () => {
    show()
    expect(await screen.findByText('Git repository')).toBeInTheDocument()
  })

  it('shows the breadcrumb for the current path', async () => {
    show()
    await screen.findByText('codesk')
    expect(screen.getByRole('button', { name: 'dev' })).toBeInTheDocument()
  })

  it('offers only online hosts to browse', async () => {
    const offline = makeHost({ id: 'host-b', name: 'Server', type: 'ssh', status: 'offline' })
    vi.spyOn(api, 'files').mockResolvedValue(listing([entry('codesk', true)]))
    render(<ProjectDialog hosts={[local, offline]} onClose={vi.fn()} onCreated={vi.fn()} />)
    await screen.findByText('codesk')
    // The local host renders as both its name and its "This Mac" subtitle.
    expect(screen.getAllByText('This Mac').length).toBeGreaterThan(0)
    expect(screen.queryByText('Server')).not.toBeInTheDocument()
  })

  it('navigates into a folder when its open control is used', async () => {
    show()
    await screen.findByText('codesk')
    const files = vi.mocked(api.files)
    files.mockClear()
    await userEvent.click(screen.getByTitle('Open codesk'))
    await waitFor(() => expect(files).toHaveBeenCalledWith('host-a', '/home/dev/codesk'))
  })

  it('goes to the parent folder', async () => {
    show()
    await screen.findByText('codesk')
    const files = vi.mocked(api.files)
    files.mockClear()
    await userEvent.click(screen.getByRole('button', { name: 'Parent folder' }))
    await waitFor(() => expect(files).toHaveBeenCalledWith('host-a', '/home'))
  })

  it('goes to the home folder', async () => {
    show()
    await screen.findByText('codesk')
    const files = vi.mocked(api.files)
    files.mockClear()
    await userEvent.click(screen.getByRole('button', { name: 'Home folder' }))
    await waitFor(() => expect(files).toHaveBeenCalledWith('host-a', '/home/dev'))
  })

  it('refreshes the current folder', async () => {
    show()
    await screen.findByText('codesk')
    const files = vi.mocked(api.files)
    files.mockClear()
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(files).toHaveBeenCalled())
  })
})

describe('ProjectDialog — filtering', () => {
  it('filters the list as the user types', async () => {
    show()
    await screen.findByText('codesk')
    await userEvent.type(screen.getByLabelText(/Search folders/), 'note')
    await waitFor(() => expect(screen.queryByText('codesk')).not.toBeInTheDocument())
    expect(screen.getByText('notes')).toBeInTheDocument()
  })

  it('reports how many folders match', async () => {
    show()
    await screen.findByText('codesk')
    await userEvent.type(screen.getByLabelText(/Search folders/), 'note')
    expect(await screen.findByText('1 matching folder')).toBeInTheDocument()
  })

  it('says so when nothing matches', async () => {
    show()
    await screen.findByText('codesk')
    await userEvent.type(screen.getByLabelText(/Search folders/), 'zzzz')
    expect(await screen.findByText('No matching folders')).toBeInTheDocument()
  })

  it('clears the filter on Escape', async () => {
    show()
    await screen.findByText('codesk')
    const input = screen.getByLabelText(/Search folders/)
    await userEvent.type(input, 'note')
    await userEvent.type(input, '{Escape}')
    expect(input).toHaveValue('')
  })

  it('shows an empty-folder state', async () => {
    show([])
    expect(await screen.findByText('This folder is empty')).toBeInTheDocument()
  })
})

describe('ProjectDialog — adding', () => {
  it('adds the selected folder as a project', async () => {
    const create = vi.spyOn(api, 'createProject').mockResolvedValue(makeProject())
    const { onCreated } = show()
    await screen.findByText('codesk')
    await userEvent.click(screen.getByText('codesk'))
    await userEvent.click(screen.getByRole('button', { name: 'Add folder' }))
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        hostId: 'host-a',
        name: 'codesk',
        path: '/home/dev/codesk',
      }),
    )
    await waitFor(() => expect(onCreated).toHaveBeenCalledOnce())
  })

  it('reports a failure and stays open', async () => {
    vi.spyOn(api, 'createProject').mockRejectedValue(new Error('already registered'))
    const { onCreated } = show()
    await screen.findByText('codesk')
    await userEvent.click(screen.getByText('codesk'))
    await userEvent.click(screen.getByRole('button', { name: 'Add folder' }))
    expect(await screen.findByText('already registered')).toBeInTheDocument()
    expect(onCreated).not.toHaveBeenCalled()
  })

  it('cancels', async () => {
    const { onClose } = show()
    await screen.findByText('codesk')
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('closes on Escape', async () => {
    const { onClose } = show()
    await screen.findByText('codesk')
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
  })

  it('explains that only the selected folder is registered', async () => {
    show()
    await screen.findByText('codesk')
    expect(screen.getByText(/registers only the selected folder/i)).toBeInTheDocument()
  })
})
