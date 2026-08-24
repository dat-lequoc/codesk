import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { observedAgents } from '../../lib/app-state'
import { sessionKey } from '../../lib/keys'
import { hiddenAgentKey } from '../../lib/observed'
import {
  makeAgent,
  makeHost,
  makeProject,
  makeRun,
  makeSession,
  makeState,
  resetIds,
} from '../../test/factories'
import type { AppState } from '../../types'
import { Sidebar } from './Sidebar'

beforeEach(resetIds)

const host = makeHost({ id: 'host-a', name: 'This Mac', status: 'online' })
const project = makeProject({ id: 'p1', hostId: 'host-a', name: 'codesk' })

const setup = (state: AppState, overrides: Record<string, unknown> = {}) => {
  const handlers = {
    onQuery: vi.fn(),
    onSelectRun: vi.fn(),
    onSelectSession: vi.fn(),
    onSelectDraft: vi.fn(),
    onSelectAgent: vi.fn(),
    onSelectProject: vi.fn(),
    onRemoveProject: vi.fn(),
    onArchiveProject: vi.fn().mockResolvedValue(undefined),
    onTogglePin: vi.fn().mockResolvedValue(undefined),
    onToggleArchive: vi.fn().mockResolvedValue(undefined),
    onToggleArchiveRun: vi.fn().mockResolvedValue(undefined),
    onHideAgent: vi.fn().mockResolvedValue(undefined),
    onControlAgent: vi.fn().mockResolvedValue(undefined),
    onRefreshProject: vi.fn().mockResolvedValue(undefined),
    onShowMore: vi.fn().mockResolvedValue(true),
    onNewRun: vi.fn(),
    onNewProject: vi.fn(),
    onRegisterFolder: vi.fn().mockResolvedValue(undefined),
    onSettings: vi.fn(),
    onArchives: vi.fn(),
    onJumpToUnread: vi.fn(),
  }
  const props = {
    state,
    runs: state.runs,
    sessions: state.sessions,
    agents: observedAgents(state),
    unreadKeys: new Set<string>(),
    selectedId: null,
    selectedSessionKey: null,
    selectedAgentKey: null,
    selectedDraftId: null,
    selectedProjectKey: null,
    query: '',
    ...handlers,
    ...overrides,
  }
  const view = render(<Sidebar {...(props as Parameters<typeof Sidebar>[0])} />)
  return { ...view, ...handlers, props }
}

const baseState = (overrides: Partial<AppState> = {}) =>
  makeState({ hosts: [host], projects: [project], ...overrides })

describe('Sidebar — shell', () => {
  it('renders the primary navigation actions', () => {
    setup(baseState())
    for (const label of ['New chat', 'Pull requests', 'Scheduled', 'Plugins'])
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
  })

  it('starts a new chat', async () => {
    const { onNewRun } = setup(baseState())
    await userEvent.click(screen.getByRole('button', { name: 'New chat' }))
    expect(onNewRun).toHaveBeenCalledOnce()
  })

  it('opens settings and archives from the footer', async () => {
    const { onSettings, onArchives } = setup(baseState())
    await userEvent.click(screen.getByRole('button', { name: /Gateway \/ Settings/ }))
    await userEvent.click(screen.getByRole('button', { name: /Archived chats/ }))
    expect(onSettings).toHaveBeenCalledOnce()
    expect(onArchives).toHaveBeenCalledOnce()
  })

  it('counts archived items in the footer badge', () => {
    const state = baseState()
    state.settings.archivedSessionKeys = ['a', 'b']
    state.settings.archivedRunKeys = ['c']
    setup(state)
    expect(screen.getByText('3')).toBeInTheDocument()
  })

  it('omits the archive badge when nothing is archived', () => {
    setup(baseState())
    const archives = screen.getByRole('button', { name: /Archived chats/ })
    expect(within(archives).queryByText(/^\d+$/)).not.toBeInTheDocument()
  })

  it('adds a project from the Projects heading', async () => {
    const { onNewProject } = setup(baseState())
    await userEvent.click(screen.getByTitle('Add project'))
    expect(onNewProject).toHaveBeenCalledOnce()
  })
})

describe('Sidebar — notifications', () => {
  it('shows no badge when everything is read', () => {
    setup(baseState())
    expect(screen.getByRole('button', { name: 'Notifications' })).toBeInTheDocument()
  })

  it('labels the bell with the unread count', () => {
    setup(baseState(), { unreadKeys: new Set(['run:1', 'run:2']) })
    expect(
      screen.getByRole('button', { name: '2 unread agent updates — click to open' }),
    ).toBeInTheDocument()
  })

  it('jumps to the unread conversation instead of opening archives', async () => {
    const { onJumpToUnread, onArchives } = setup(baseState(), {
      unreadKeys: new Set(['run:1']),
    })
    await userEvent.click(
      screen.getByRole('button', { name: '1 unread agent updates — click to open' }),
    )
    expect(onJumpToUnread).toHaveBeenCalledOnce()
    expect(onArchives).not.toHaveBeenCalled()
  })

  it('opens archives from the bell when nothing is unread', async () => {
    const { onJumpToUnread, onArchives } = setup(baseState())
    await userEvent.click(screen.getByRole('button', { name: 'Notifications' }))
    expect(onArchives).toHaveBeenCalledOnce()
    expect(onJumpToUnread).not.toHaveBeenCalled()
  })

  it('caps the badge at 9+', () => {
    const unreadKeys = new Set(Array.from({ length: 12 }, (_, i) => `run:${i}`))
    setup(baseState(), { unreadKeys })
    expect(screen.getByText('9+')).toBeInTheDocument()
  })
})

describe('Sidebar — projects', () => {
  it('lists projects with their host', () => {
    setup(baseState())
    expect(screen.getByText('codesk')).toBeInTheDocument()
    expect(screen.getByText('This Mac')).toBeInTheDocument()
  })

  it('exposes the project as an expandable tree item', () => {
    setup(baseState())
    expect(screen.getByRole('treeitem')).toHaveAttribute('aria-expanded', 'false')
  })

  it('expands and collapses a project', async () => {
    setup(baseState())
    await userEvent.click(screen.getByRole('button', { name: 'Expand codesk' }))
    expect(screen.getByRole('treeitem')).toHaveAttribute('aria-expanded', 'true')
    await userEvent.click(screen.getByRole('button', { name: 'Collapse codesk' }))
    expect(screen.getByRole('treeitem')).toHaveAttribute('aria-expanded', 'false')
  })

  it('selects a project', async () => {
    const { onSelectProject } = setup(baseState())
    await userEvent.click(screen.getByRole('button', { name: 'codesk' }))
    expect(onSelectProject).toHaveBeenCalledWith(project)
  })

  it('says so when an expanded project has no conversations', async () => {
    setup(baseState())
    await userEvent.click(screen.getByRole('button', { name: 'Expand codesk' }))
    expect(screen.getByText('No chats')).toBeInTheDocument()
  })

  it('refreshes a project', async () => {
    const { onRefreshProject } = setup(baseState())
    await userEvent.click(screen.getByRole('button', { name: 'Refresh sessions for codesk' }))
    await waitFor(() => expect(onRefreshProject).toHaveBeenCalledWith(project))
  })

  it('disables refresh while the host is offline', () => {
    const offline = makeHost({ id: 'host-a', name: 'This Mac', status: 'offline' })
    setup(baseState({ hosts: [offline] }))
    expect(screen.getByRole('button', { name: 'Refresh sessions for codesk' })).toBeDisabled()
  })
})

describe('Sidebar — project actions menu', () => {
  const openMenu = async () => {
    await userEvent.click(screen.getByRole('button', { name: 'Project actions for codesk' }))
    return screen.findByRole('menu')
  }

  it('offers new chat, archive and remove', async () => {
    setup(baseState())
    const menu = await openMenu()
    for (const name of ['New chat', 'Archive chats', 'Remove project'])
      expect(within(menu).getByRole('menuitem', { name })).toBeInTheDocument()
  })

  it('removes a project', async () => {
    const { onRemoveProject } = setup(baseState())
    const menu = await openMenu()
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Remove project' }))
    expect(onRemoveProject).toHaveBeenCalledWith(project)
  })

  it('disables archiving when the project has no conversations', async () => {
    setup(baseState())
    const menu = await openMenu()
    expect(within(menu).getByRole('menuitem', { name: 'Archive chats' })).toHaveAttribute(
      'data-disabled',
    )
  })

  it('closes on Escape', async () => {
    setup(baseState())
    await openMenu()
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
  })
})

describe('Sidebar — conversations', () => {
  const session = makeSession({
    id: 's1',
    hostId: 'host-a',
    projectId: 'p1',
    title: 'Fix the build',
  })
  const withSession = () => baseState({ sessions: [session] })

  const expand = async () => {
    const toggle = screen.queryByRole('button', { name: 'Expand codesk' })
    if (toggle) await userEvent.click(toggle)
  }

  it('lists a conversation once the project is expanded', async () => {
    setup(withSession())
    await expand()
    expect(screen.getByText('Fix the build')).toBeInTheDocument()
  })

  it('selects a conversation', async () => {
    const { onSelectSession } = setup(withSession())
    await expand()
    await userEvent.click(screen.getByText('Fix the build'))
    expect(onSelectSession).toHaveBeenCalledWith(session)
  })

  it('archives a conversation', async () => {
    const { onToggleArchive } = setup(withSession())
    await expand()
    await userEvent.click(screen.getByTitle('Archive conversation'))
    await waitFor(() => expect(onToggleArchive).toHaveBeenCalledWith(session))
  })

  it('pins a conversation', async () => {
    const { onTogglePin } = setup(withSession())
    await expand()
    await userEvent.click(screen.getByTitle('Pin conversation'))
    await waitFor(() => expect(onTogglePin).toHaveBeenCalledWith(session))
  })

  it('hides an archived conversation', async () => {
    const state = withSession()
    state.settings.archivedSessionKeys = [sessionKey(session)]
    setup(state)
    await expand()
    expect(screen.queryByText('Fix the build')).not.toBeInTheDocument()
  })

  it('shows a running count on the project row', async () => {
    const running = makeSession({ id: 's2', projectId: 'p1', hostId: 'host-a', status: 'running' })
    setup(baseState({ sessions: [running] }))
    expect(
      screen.getByRole('button', { name: /Open running conversation|running conversations/ }),
    ).toBeInTheDocument()
  })

  it('surfaces pinned conversations in their own section', () => {
    const state = withSession()
    state.settings.pinnedSessionKeys = [sessionKey(session)]
    setup(state)
    expect(screen.getByLabelText('Pinned conversations')).toBeInTheDocument()
  })
})

describe('Sidebar — runs', () => {
  it('lists a run and selects it', async () => {
    const run = makeRun({ id: 'r1', hostId: 'host-a', projectId: 'p1', title: 'Build the thing' })
    const { onSelectRun } = setup(baseState({ runs: [run] }))
    await userEvent.click(screen.getByRole('button', { name: 'Expand codesk' }))
    await userEvent.click(screen.getByText('Build the thing'))
    expect(onSelectRun).toHaveBeenCalledWith(run)
  })

  it('archives a run from its own control', async () => {
    const run = makeRun({ id: 'r1', hostId: 'host-a', projectId: 'p1', title: 'Build the thing' })
    const { onToggleArchiveRun } = setup(baseState({ runs: [run] }))
    await userEvent.click(screen.getByRole('button', { name: 'Expand codesk' }))
    await userEvent.click(screen.getByTitle('Archive run'))
    await waitFor(() => expect(onToggleArchiveRun).toHaveBeenCalledWith(run))
  })
})

describe('Sidebar — agents outside projects', () => {
  const detached = () =>
    baseState({
      discoveredAgentsByHost: {
        'host-a': [makeAgent({ pid: 99, process_group_id: 99, cwd: '/home/dev/elsewhere' })],
      },
    })

  const expandDetached = async () => {
    await userEvent.click(screen.getByRole('button', { name: /Outside your projects/ }))
  }

  it('lists a folder that is not a registered project, collapsed until opened', async () => {
    setup(detached())
    expect(screen.getByLabelText('Agents outside your projects')).toBeInTheDocument()
    expect(screen.queryByText('Codex · elsewhere')).not.toBeInTheDocument()
    await expandDetached()
    expect(screen.getByText('Codex · elsewhere')).toBeInTheDocument()
  })

  it('registers the folder as a project', async () => {
    const { onRegisterFolder } = setup(detached())
    await expandDetached()
    await userEvent.click(screen.getByLabelText('Add /home/dev/elsewhere as a project'))
    await waitFor(() =>
      expect(onRegisterFolder).toHaveBeenCalledWith('host-a', '/home/dev/elsewhere'),
    )
  })

  it('cannot register an agent that reported no working directory', async () => {
    const state = baseState({
      discoveredAgentsByHost: {
        'host-a': [makeAgent({ pid: 99, process_group_id: 99, cwd: null })],
      },
    })
    setup(state)
    await expandDetached()
    expect(screen.getByLabelText('No working directory to add')).toBeDisabled()
  })

  it('selects an observed agent', async () => {
    const { onSelectAgent } = setup(detached())
    await expandDetached()
    await userEvent.click(screen.getByText('Codex · elsewhere'))
    expect(onSelectAgent).toHaveBeenCalled()
  })
})

describe('Sidebar — observed sessions', () => {
  it('never lists observed agents inside project rows', async () => {
    const agent = makeAgent({
      provider: 'kiro',
      pid: 44002,
      process_group_id: 44002,
      cwd: '/home/dev/codesk',
      command: 'kiro-cli chat',
    })
    setup(baseState({ discoveredAgentsByHost: { 'host-a': [agent] } }))
    await userEvent.click(screen.getByRole('button', { name: 'Expand codesk' }))
    expect(screen.queryByText('Kiro · codesk')).not.toBeInTheDocument()
    expect(screen.queryByText(/pid 44002/)).not.toBeInTheDocument()
    // In a project folder, so it does not belong to "Outside your projects" either.
    expect(screen.queryByLabelText('Agents outside your projects')).not.toBeInTheDocument()
  })

  it('hides and interrupts a detached agent via the menu', async () => {
    const agent = makeAgent({
      provider: 'kiro',
      pid: 44002,
      process_group_id: 44002,
      cwd: '/home/dev/elsewhere',
      command: 'kiro-cli chat',
    })
    const { onHideAgent, onControlAgent } = setup(
      baseState({ discoveredAgentsByHost: { 'host-a': [agent] } }),
    )
    await userEvent.click(screen.getByRole('button', { name: /Outside your projects/ }))
    expect(screen.getByText('Kiro · elsewhere')).toBeInTheDocument()
    fireEvent.contextMenu(screen.getByText('Kiro · elsewhere'))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Hide' }))
    expect(onHideAgent).toHaveBeenCalledWith('host-a', agent)
    fireEvent.contextMenu(screen.getByText('Kiro · elsewhere'))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Interrupt' }))
    expect(onControlAgent).toHaveBeenCalledWith('host-a', agent, 'interrupt')
  })

  it('excludes a hidden agent and offers to show it again', async () => {
    const agent = makeAgent({
      provider: 'kiro',
      pid: 44002,
      process_group_id: 44002,
      cwd: '/home/dev/elsewhere',
      command: 'kiro-cli chat',
    })
    const state = baseState({ discoveredAgentsByHost: { 'host-a': [agent] } })
    state.settings.hiddenAgentKeys = [hiddenAgentKey('host-a', agent)]
    setup(state)
    await userEvent.click(screen.getByRole('button', { name: /Outside your projects/ }))
    expect(screen.queryByText('Kiro · elsewhere')).not.toBeInTheDocument()
    expect(screen.getByText('Show hidden (1)')).toBeInTheDocument()
  })

  it('groups detached agents under their host and marks remotes', async () => {
    const remote = makeHost({ id: 'host-b', name: 'vps-1', type: 'ssh', status: 'online' })
    const localAgent = makeAgent({ pid: 71, process_group_id: 71, cwd: '/home/dev/scratch' })
    const remoteAgent = makeAgent({ pid: 77, process_group_id: 77, cwd: '/srv/elsewhere' })
    setup(
      baseState({
        hosts: [host, remote],
        discoveredAgentsByHost: { 'host-a': [localAgent], 'host-b': [remoteAgent] },
      }),
    )
    await userEvent.click(screen.getByRole('button', { name: /Outside your projects/ }))
    const section = screen.getByLabelText('Agents outside your projects')
    expect(within(section).getByText('This Mac')).toBeInTheDocument()
    expect(within(section).getByText('vps-1')).toBeInTheDocument()
    expect(within(section).getByText('· remote')).toBeInTheDocument()
    expect(within(section).getByText('Codex · scratch')).toBeInTheDocument()
    expect(within(section).getByText('Codex · elsewhere')).toBeInTheDocument()
  })
})

describe('Sidebar — search', () => {
  it('reports what the user typed', async () => {
    const { onQuery } = setup(baseState())
    await userEvent.click(screen.getByTitle('Search conversations'))
    await userEvent.type(screen.getByLabelText('Search projects and conversations'), 'fix')
    expect(onQuery).toHaveBeenCalled()
  })

  it('filters projects out when nothing matches', () => {
    setup(baseState(), { query: 'nothing-matches-this' })
    expect(screen.getByText('No matching projects or conversations')).toBeInTheDocument()
  })

  it('keeps a project whose name matches', () => {
    setup(baseState(), { query: 'codesk' })
    expect(screen.getByText('codesk')).toBeInTheDocument()
  })

  it('offers to clear an active query', async () => {
    const { onQuery } = setup(baseState(), { query: 'fix' })
    await userEvent.click(screen.getByTitle('Clear search'))
    expect(onQuery).toHaveBeenCalledWith('')
  })
})
