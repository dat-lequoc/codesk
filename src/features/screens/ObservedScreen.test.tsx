import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { DiscoveredAgent } from '../../types'
import { makeAgent, makeHost, makeProject, makeRun, resetIds } from '../../test/factories'

vi.mock('../../api', () => ({
  gatewayOrigin: '',
  api: {
    externalAgentInput: vi.fn(),
    externalSessionQueue: vi.fn(),
    removeExternalQueued: vi.fn(),
    adoptExternalAgentTmux: vi.fn(),
    moveExternalAgentToTmux: vi.fn(),
  },
}))

const { ObservedScreen } = await import('./ObservedScreen')
const { api } = await import('../../api')

const host = makeHost({ id: 'host-local', name: 'This Mac' })
const project = makeProject({ id: 'project-1', hostId: 'host-local', name: 'codesk' })
const onStarted = vi.fn()
const onError = vi.fn()

/** An agent Codesk has taken control of: the only shape it will steer. */
const steerable = (overrides: Partial<DiscoveredAgent> = {}) =>
  makeAgent({
    id: 'agent-a',
    pid: 4242,
    native_session_id: 'native-a',
    tmux_controlled: true,
    tmux_pane_id: '%1',
    tmux_session_name: 'codesk-a',
    ...overrides,
  })

const mount = (agent: DiscoveredAgent, overrides: { host?: typeof host } = {}) =>
  render(
    <ObservedScreen
      host={'host' in overrides ? overrides.host : host}
      project={project}
      agent={agent}
      onStarted={onStarted}
      onError={onError}
    />,
  )

beforeEach(() => {
  resetIds()
  vi.clearAllMocks()
  vi.mocked(api.externalSessionQueue).mockResolvedValue([])
  vi.mocked(api.removeExternalQueued).mockResolvedValue(undefined)
})

describe('ObservedScreen', () => {
  it('marks the agent as observed rather than owned', () => {
    mount(steerable())
    expect(screen.getByText('Observed')).toBeInTheDocument()
    expect(screen.getByText('Codex is running')).toBeInTheDocument()
  })

  it('steers a controlled agent', async () => {
    vi.mocked(api.externalAgentInput).mockResolvedValue({ ok: true, delivery: 'steer' })
    mount(steerable())
    await userEvent.type(screen.getByRole('textbox'), 'keep going')
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() =>
      expect(api.externalAgentInput).toHaveBeenCalledWith(
        'host-local',
        'project-1',
        4242,
        'native-a',
        'keep going',
        'steer',
      ),
    )
    expect(screen.getByRole('textbox')).toHaveValue('')
  })

  it('queues on Tab', async () => {
    vi.mocked(api.externalAgentInput).mockResolvedValue({ ok: true, delivery: 'steer' })
    mount(steerable())
    await userEvent.type(screen.getByRole('textbox'), 'after this turn')
    await userEvent.tab()
    await waitFor(() =>
      expect(api.externalAgentInput).toHaveBeenCalledWith(
        'host-local',
        'project-1',
        4242,
        'native-a',
        'after this turn',
        'queue',
      ),
    )
  })

  it('reports a send failure', async () => {
    vi.mocked(api.externalAgentInput).mockRejectedValue(new Error('pane vanished'))
    mount(steerable())
    await userEvent.type(screen.getByRole('textbox'), 'hello')
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(onError).toHaveBeenCalledWith('pane vanished'))
  })

  it('will not steer while the host is offline', async () => {
    mount(steerable(), { host: makeHost({ id: 'host-local', status: 'offline' }) })
    expect(screen.getByRole('textbox')).toBeDisabled()
  })

  it('offers no composer until Codesk controls the session', () => {
    mount(steerable({ tmux_controlled: false, tmux_pane_id: undefined }))
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Enable control/ })).toBeInTheDocument()
  })

  it('offers to move a bare terminal agent into tmux', async () => {
    mount(
      steerable({ tmux_controlled: false, tmux_pane_id: undefined, tmux_session_name: undefined }),
    )
    await userEvent.click(screen.getByRole('button', { name: /Move to tmux/ }))
    await waitFor(() =>
      expect(api.moveExternalAgentToTmux).toHaveBeenCalledWith(
        'host-local',
        'project-1',
        4242,
        'native-a',
      ),
    )
    expect(await screen.findByText(/Waiting for idle/)).toBeInTheDocument()
  })

  it('adopts an agent that is already in tmux', async () => {
    mount(steerable({ tmux_controlled: false, tmux_pane_id: undefined }))
    await userEvent.click(screen.getByRole('button', { name: /Enable control/ }))
    await waitFor(() =>
      expect(api.adoptExternalAgentTmux).toHaveBeenCalledWith(
        'host-local',
        'project-1',
        4242,
        'native-a',
      ),
    )
  })

  it('reports a failure to take control', async () => {
    vi.mocked(api.adoptExternalAgentTmux).mockRejectedValue(new Error('no such pane'))
    mount(steerable({ tmux_controlled: false, tmux_pane_id: undefined }))
    await userEvent.click(screen.getByRole('button', { name: /Enable control/ }))
    await waitFor(() => expect(onError).toHaveBeenCalledWith('no such pane'))
  })

  it('shows what is queued behind the current turn', async () => {
    vi.mocked(api.externalAgentInput).mockResolvedValue({
      queued: { id: 'q1', pid: 4242, message: 'second thing', status: 'queued' },
    } as Awaited<ReturnType<typeof api.externalAgentInput>>)
    mount(steerable())
    await userEvent.type(screen.getByRole('textbox'), 'second thing')
    await userEvent.tab()
    expect(await screen.findByText('1 queued')).toBeInTheDocument()
    expect(screen.getByText(/after this turn/)).toBeInTheDocument()
  })

  // The daemon turns a queued prompt into a run; the screen hands it up so the
  // shell can switch to the real thread.
  it('adopts a queued prompt that has become a run', async () => {
    const run = makeRun({ id: 'run-1' })
    vi.mocked(api.externalAgentInput).mockResolvedValue({
      queued: { id: 'q1', pid: 4242, message: 'second thing', status: 'queued' },
    } as Awaited<ReturnType<typeof api.externalAgentInput>>)
    vi.mocked(api.externalSessionQueue).mockResolvedValue([
      { id: 'q1', pid: 4242, message: 'second thing', status: 'started', run },
    ] as Awaited<ReturnType<typeof api.externalSessionQueue>>)
    mount(steerable())
    await userEvent.type(screen.getByRole('textbox'), 'second thing')
    await userEvent.tab()
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith(run), { timeout: 3000 })
  })
})
