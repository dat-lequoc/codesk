import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '../../api'
import { makeHost, makeProject, makeRun, makeSession, resetIds } from '../../test/factories'
import { ArchivedChatsDialog } from './ArchivedChatsDialog'
import { ConnectionsDialog } from './ConnectionsDialog'
import { RemoveProjectDialog } from './RemoveProjectDialog'

beforeEach(resetIds)

describe('RemoveProjectDialog', () => {
  const project = makeProject({ name: 'codesk', path: '/home/dev/codesk' })
  const show = (busy = false) => {
    const onClose = vi.fn()
    const onConfirm = vi.fn()
    render(
      <RemoveProjectDialog project={project} busy={busy} onClose={onClose} onConfirm={onConfirm} />,
    )
    return { onClose, onConfirm }
  }

  it('names the project and reassures about the folder', () => {
    show()
    expect(screen.getByText('Remove codesk?')).toBeInTheDocument()
    expect(screen.getByText('/home/dev/codesk')).toBeInTheDocument()
    expect(screen.getByText(/folder and its files will not be deleted/i)).toBeInTheDocument()
  })

  it('confirms removal', async () => {
    const { onConfirm } = show()
    await userEvent.click(screen.getByRole('button', { name: /Remove project/ }))
    expect(onConfirm).toHaveBeenCalledOnce()
  })

  it('cancels', async () => {
    const { onClose } = show()
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('closes on Escape', async () => {
    const { onClose } = show()
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
  })

  it('shows progress and blocks both buttons while removing', () => {
    show(true)
    expect(screen.getByText('Removing…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
  })
})

describe('ArchivedChatsDialog', () => {
  const session = makeSession({ id: 's1', hostId: 'host-a', title: 'Old conversation' })
  const project = makeProject({ id: 'project-1', hostId: 'host-a', name: 'codesk' })
  const host = makeHost({ id: 'host-a', name: 'This Mac' })

  const show = (overrides: Record<string, unknown> = {}) => {
    const handlers = {
      onOpen: vi.fn(),
      onOpenRun: vi.fn(),
      onRestore: vi.fn().mockResolvedValue(undefined),
      onRestoreRun: vi.fn().mockResolvedValue(undefined),
      onClose: vi.fn(),
    }
    render(
      <ArchivedChatsDialog
        sessions={[session]}
        archivedRuns={[]}
        runs={[]}
        unreadKeys={new Set()}
        projects={[project]}
        hosts={[host]}
        {...handlers}
        {...overrides}
      />,
    )
    return handlers
  }

  it('lists an archived conversation with its project and host', () => {
    show()
    expect(screen.getByText('Old conversation')).toBeInTheDocument()
    expect(screen.getByText(/codesk · This Mac/)).toBeInTheDocument()
  })

  it('opens an archived conversation', async () => {
    const { onOpen } = show()
    await userEvent.click(screen.getByText('Old conversation'))
    expect(onOpen).toHaveBeenCalledWith(session)
  })

  it('unarchives a conversation', async () => {
    const { onRestore } = show()
    await userEvent.click(screen.getByRole('button', { name: 'Unarchive' }))
    await waitFor(() => expect(onRestore).toHaveBeenCalledWith(session))
  })

  it('lists an archived run', () => {
    const run = makeRun({ id: 'r1', hostId: 'host-a', title: 'Old run', status: 'completed' })
    show({ sessions: [], archivedRuns: [run] })
    expect(screen.getByText('Old run')).toBeInTheDocument()
  })

  it('shows an empty state when nothing is archived', () => {
    show({ sessions: [], archivedRuns: [] })
    expect(screen.getByText('No archived chats')).toBeInTheDocument()
  })

  it('closes on Escape', async () => {
    const { onClose } = show()
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
  })
})

describe('ConnectionsDialog', () => {
  const local = makeHost({ id: 'host-a', name: 'This Mac', type: 'local', status: 'online' })
  const remote = makeHost({
    id: 'host-b',
    name: 'Server',
    type: 'ssh',
    sshAlias: 'srv',
    status: 'offline',
  })

  const show = (hosts = [local]) => {
    const onClose = vi.fn()
    const onChanged = vi.fn().mockResolvedValue(undefined)
    render(<ConnectionsDialog hosts={hosts} onClose={onClose} onChanged={onChanged} />)
    return { onClose, onChanged }
  }

  beforeEach(() => {
    vi.spyOn(api, 'sshAliases').mockResolvedValue([])
  })

  it('lists a local host', () => {
    show()
    expect(screen.getByText('This Mac')).toBeInTheDocument()
    expect(screen.getByText('Local daemon')).toBeInTheDocument()
  })

  it('lists an ssh host by its alias', () => {
    show([remote])
    expect(screen.getByText('Server')).toBeInTheDocument()
    expect(screen.getByText('srv')).toBeInTheDocument()
  })

  it('offers reconnect only for ssh hosts', () => {
    show([local])
    expect(screen.queryByTitle('Install or reconnect')).not.toBeInTheDocument()
    show([remote])
    expect(screen.getByTitle('Install or reconnect')).toBeInTheDocument()
  })

  it('disables agent discovery while a host is offline', () => {
    show([remote])
    expect(screen.getByRole('button', { name: 'Discover running agents' })).toBeDisabled()
  })

  it('discovers running agents on an online host', async () => {
    const discovered = vi.spyOn(api, 'discoveredAgents').mockResolvedValue([])
    show()
    await userEvent.click(screen.getByRole('button', { name: 'Discover running agents' }))
    await waitFor(() => expect(discovered).toHaveBeenCalledWith('host-a'))
  })

  it('surfaces a discovery failure to the user', async () => {
    vi.spyOn(api, 'discoveredAgents').mockRejectedValue(new Error('daemon unreachable'))
    show()
    await userEvent.click(screen.getByRole('button', { name: 'Discover running agents' }))
    expect(await screen.findByText('daemon unreachable')).toBeInTheDocument()
  })

  it('creates a host from the form', async () => {
    const created = vi.spyOn(api, 'createHost').mockResolvedValue(remote)
    vi.spyOn(api, 'bootstrapHost').mockResolvedValue(undefined as never)
    show()
    await userEvent.type(screen.getByLabelText('Display name'), 'Server')
    await userEvent.type(screen.getByLabelText('SSH alias'), 'srv')
    await userEvent.click(screen.getByRole('button', { name: /Connect/ }))
    await waitFor(() => expect(created).toHaveBeenCalledWith({ name: 'Server', sshAlias: 'srv' }))
  })

  it('falls back to the alias when no display name is given', async () => {
    const created = vi.spyOn(api, 'createHost').mockResolvedValue(remote)
    vi.spyOn(api, 'bootstrapHost').mockResolvedValue(undefined as never)
    show()
    await userEvent.type(screen.getByLabelText('SSH alias'), 'srv')
    await userEvent.click(screen.getByRole('button', { name: /Connect/ }))
    await waitFor(() => expect(created).toHaveBeenCalledWith({ name: 'srv', sshAlias: 'srv' }))
  })

  it('reports a creation failure', async () => {
    vi.spyOn(api, 'createHost').mockRejectedValue(new Error('alias not found'))
    show()
    await userEvent.type(screen.getByLabelText('SSH alias'), 'nope')
    await userEvent.click(screen.getByRole('button', { name: /Connect/ }))
    expect(await screen.findByText('alias not found')).toBeInTheDocument()
  })

  it('closes on Escape', async () => {
    const { onClose } = show()
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
  })
})
