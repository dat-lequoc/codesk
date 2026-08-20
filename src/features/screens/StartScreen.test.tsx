import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AppState, GitContext, Provider } from '../../types'
import {
  makeDraft,
  makeHost,
  makeProject,
  makeRun,
  makeState,
  resetIds,
} from '../../test/factories'

vi.mock('../../api', () => ({
  gatewayOrigin: '',
  api: {
    projectContext: vi.fn(),
    createRun: vi.fn(),
    startDraft: vi.fn(),
    updateDraft: vi.fn(),
  },
}))

const { StartScreen } = await import('./StartScreen')
const { api } = await import('../../api')

const host = makeHost({ id: 'host-local', name: 'This Mac' })
const project = makeProject({ id: 'project-1', hostId: 'host-local', name: 'codesk' })

const provider = (id: string, available: boolean): Provider =>
  ({
    id,
    name: id === 'codex' ? 'Codex' : id === 'claude' ? 'Claude Code' : id,
    available,
  }) as Provider

const gitContext = (overrides: Partial<GitContext> = {}): GitContext =>
  ({ available: true, branch: 'main', dirty: false, detached: false, ...overrides }) as GitContext

const stateWith = (providers: Provider[]): AppState =>
  makeState({ hosts: [host], projects: [project], providersByHost: { 'host-local': providers } })

const onStarted = vi.fn()
const onError = vi.fn()

const mount = (providers: Provider[], extra: Partial<Parameters<typeof StartScreen>[0]> = {}) =>
  render(
    <StartScreen
      state={stateWith(providers)}
      project={project}
      host={host}
      onProject={vi.fn()}
      onStarted={onStarted}
      onError={onError}
      {...extra}
    />,
  )

beforeEach(() => {
  resetIds()
  vi.clearAllMocks()
  vi.mocked(api.projectContext).mockResolvedValue(gitContext())
})

afterEach(() => {
  vi.useRealTimers()
})

describe('StartScreen · harness choice', () => {
  it('lists the host’s harnesses and marks the selected one', async () => {
    mount([provider('codex', true), provider('claude', true)])
    expect(await screen.findByRole('radio', { name: /Codex/ })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    expect(screen.getByRole('radio', { name: /Claude Code/ })).toHaveAttribute(
      'aria-checked',
      'false',
    )
  })

  it('disables a harness the host cannot run', () => {
    mount([provider('codex', true), provider('claude', false)])
    expect(screen.getByRole('radio', { name: /Claude Code/ })).toBeDisabled()
  })

  // The default provider is 'codex'; on a host without it the picker must land
  // on something startable rather than leaving the send button dead.
  it('falls back to the first available harness when the default is missing', async () => {
    mount([provider('codex', false), provider('claude', true)])
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: /Claude Code/ })).toHaveAttribute(
        'aria-checked',
        'true',
      ),
    )
  })

  it('leaves the choice alone when nothing is available', () => {
    mount([provider('codex', false), provider('claude', false)])
    expect(screen.getByRole('radio', { name: /Codex/ })).toHaveAttribute('aria-checked', 'true')
  })

  it('switches when another harness is picked', async () => {
    mount([provider('codex', true), provider('claude', true)])
    await userEvent.click(screen.getByRole('radio', { name: /Claude Code/ }))
    expect(screen.getByRole('radio', { name: /Claude Code/ })).toHaveAttribute(
      'aria-checked',
      'true',
    )
  })
})

describe('StartScreen · workspace', () => {
  it('offers a managed worktree once the project is known to be a git repository', async () => {
    mount([provider('codex', true)])
    await waitFor(() => expect(screen.getByText('main')).toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: /Local/, expanded: false }))
    expect(screen.getByRole('option', { name: /New worktree/ })).toBeEnabled()
  })

  it('refuses a managed worktree outside a git repository', async () => {
    vi.mocked(api.projectContext).mockResolvedValue(gitContext({ available: false }))
    mount([provider('codex', true)])
    await waitFor(() => expect(screen.getByText('No Git repository')).toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: /Local/, expanded: false }))
    expect(screen.getByRole('option', { name: /New worktree/ })).toBeDisabled()
  })

  // The draft can arrive asking for a worktree before the git context is known.
  it('drops back to the current checkout when the repository turns out not to be one', async () => {
    vi.mocked(api.projectContext).mockResolvedValue(gitContext({ available: false }))
    mount([provider('codex', true)], {
      draft: makeDraft({ id: 'draft-1', workspaceMode: 'managed_worktree' }),
    })
    expect(
      screen.getByRole('button', { name: /New worktree/, expanded: false }),
    ).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Local/, expanded: false })).toBeInTheDocument(),
    )
  })

  it('remembers a worktree choice that the repository supports', async () => {
    mount([provider('codex', true)], {
      draft: makeDraft({ id: 'draft-1', workspaceMode: 'managed_worktree' }),
    })
    await waitFor(() => expect(screen.getByText('main')).toBeInTheDocument())
    expect(
      screen.getByRole('button', { name: /New worktree/, expanded: false }),
    ).toBeInTheDocument()
  })
})

describe('StartScreen · starting a run', () => {
  it('does not start on an empty prompt', async () => {
    mount([provider('codex', true)])
    await userEvent.click(screen.getByRole('button', { name: 'Start chat' }))
    expect(api.createRun).not.toHaveBeenCalled()
  })

  it('creates a run from the composer', async () => {
    const run = makeRun({ id: 'run-1' })
    vi.mocked(api.createRun).mockResolvedValue(run)
    mount([provider('codex', true)])
    await waitFor(() => expect(screen.getByText('main')).toBeInTheDocument())
    await userEvent.type(screen.getByRole('textbox'), 'ship it')
    await userEvent.click(screen.getByRole('button', { name: 'Start chat' }))
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith(run))
    expect(api.createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        hostId: 'host-local',
        project_id: 'project-1',
        provider: 'codex',
        prompt: 'ship it',
        workspace_mode: 'current_checkout',
      }),
    )
  })

  it('starts the draft instead of a bare run when there is one', async () => {
    const run = makeRun({ id: 'run-1' })
    vi.mocked(api.startDraft).mockResolvedValue(run)
    mount([provider('codex', true)], { draft: makeDraft({ id: 'draft-1' }) })
    await userEvent.type(screen.getByRole('textbox'), 'ship it')
    await userEvent.click(screen.getByRole('button', { name: 'Start chat' }))
    await waitFor(() => expect(api.startDraft).toHaveBeenCalledWith('draft-1', expect.anything()))
    expect(api.createRun).not.toHaveBeenCalled()
  })

  it('reports a failure to start rather than swallowing it', async () => {
    vi.mocked(api.createRun).mockRejectedValue(new Error('daemon offline'))
    mount([provider('codex', true)])
    await userEvent.type(screen.getByRole('textbox'), 'ship it')
    await userEvent.click(screen.getByRole('button', { name: 'Start chat' }))
    await waitFor(() => expect(onError).toHaveBeenCalledWith('daemon offline'))
  })

  it('will not start against an offline host', async () => {
    mount([provider('codex', true)], { host: makeHost({ id: 'host-local', status: 'offline' }) })
    await userEvent.type(screen.getByRole('textbox'), 'ship it')
    await userEvent.click(screen.getByRole('button', { name: 'Start chat' }))
    expect(api.createRun).not.toHaveBeenCalled()
  })

  it('fills the composer from a starter card', async () => {
    mount([provider('codex', true)])
    await userEvent.click(screen.getByRole('button', { name: /Explore and.*understand code/s }))
    expect(screen.getByRole('textbox')).toHaveValue('Explore and explain this codebase')
  })
})

describe('StartScreen · drafts', () => {
  it('saves the draft after the composer settles', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.mocked(api.updateDraft).mockResolvedValue(makeDraft({ id: 'draft-1' }))
    mount([provider('codex', true)], { draft: makeDraft({ id: 'draft-1' }) })
    await userEvent.type(screen.getByRole('textbox'), 'wip')
    await vi.advanceTimersByTimeAsync(300)
    await waitFor(() =>
      expect(api.updateDraft).toHaveBeenCalledWith(
        'draft-1',
        expect.objectContaining({ prompt: 'wip', provider: 'codex' }),
      ),
    )
  })

  it('does not try to save when there is no draft', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    mount([provider('codex', true)])
    await userEvent.type(screen.getByRole('textbox'), 'wip')
    await vi.advanceTimersByTimeAsync(300)
    expect(api.updateDraft).not.toHaveBeenCalled()
  })
})

describe('StartScreen · without a project', () => {
  it('asks for a project instead of showing the composer', () => {
    mount([provider('codex', true)], { project: undefined, host: undefined })
    expect(screen.getByText('Add a project to get started')).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })
})
