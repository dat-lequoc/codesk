import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Provider, ProviderSession, RunEvent, SessionMessage } from '../../types'
import {
  makeEvent,
  makeHost,
  makeMessage,
  makeProject,
  makeProvider,
  makeRun,
  makeSession,
  resetIds,
} from '../../test/factories'

vi.mock('../../api', () => ({
  gatewayOrigin: '',
  api: {
    input: vi.fn(),
    externalSessionInput: vi.fn(),
    externalSessionQueue: vi.fn(),
    removeExternalQueued: vi.fn(),
    removeQueued: vi.fn(),
    resumeSession: vi.fn(),
    adoptExternalTmux: vi.fn(),
    moveExternalToTmux: vi.fn(),
    providerModels: vi.fn(),
    file: vi.fn(),
  },
}))

const { SessionScreen } = await import('./SessionScreen')
const { api } = await import('../../api')

const host = makeHost({ id: 'host-local', name: 'This Mac' })
const project = makeProject({ id: 'project-1', hostId: 'host-local', name: 'codesk' })
const onStarted = vi.fn()
const onError = vi.fn()

/** A tmux-controlled session: the only shape Codesk will steer directly. */
const controlled = (overrides: Partial<ProviderSession> = {}) =>
  makeSession({
    id: 'session-a',
    title: 'Refactor the sidebar',
    pid: 4242,
    inputTransport: 'tmux',
    tmuxControlled: true,
    tmuxName: 'codesk-a',
    ...overrides,
  })

const mount = (
  session: ProviderSession,
  messages: SessionMessage[] = [],
  provider: Provider = makeProvider(),
  runEvents: RunEvent[] = [],
) =>
  render(
    <SessionScreen
      session={session}
      messages={messages}
      runEvents={runEvents}
      project={project}
      host={host}
      provider={provider}
      onStarted={onStarted}
      onError={onError}
    />,
  )

const composer = () => screen.getByRole('textbox')

beforeEach(() => {
  resetIds()
  vi.clearAllMocks()
  vi.mocked(api.externalSessionQueue).mockResolvedValue([])
  // The screen chains `.catch()` on this one, so the double has to be a promise.
  vi.mocked(api.removeExternalQueued).mockResolvedValue(undefined)
})

describe('SessionScreen · transcript', () => {
  it('renders the conversation', () => {
    mount(controlled(), [
      makeMessage({ role: 'user', text: 'split App.tsx' }),
      makeMessage({ role: 'assistant', text: 'Done — 27 modules.' }),
    ])
    expect(screen.getByText('split App.tsx')).toBeInTheDocument()
    expect(screen.getByText('Done — 27 modules.')).toBeInTheDocument()
  })

  it('shows a running badge while the harness is working', () => {
    mount(controlled({ status: 'running' }))
    expect(screen.getByText('Running')).toBeInTheDocument()
  })

  it('titles the thread after the session', () => {
    mount(controlled())
    expect(screen.getByText('Refactor the sidebar')).toBeInTheDocument()
  })
})

describe('SessionScreen · steering an attached session', () => {
  it('sends through the external session API', async () => {
    vi.mocked(api.externalSessionInput).mockResolvedValue({ ok: true, delivery: 'steer' })
    mount(controlled())
    await userEvent.type(composer(), 'keep going')
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() =>
      expect(api.externalSessionInput).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'session-a' }),
        'keep going',
        'steer',
      ),
    )
    expect(composer()).toHaveValue('')
  })

  // A managed run owns the harness's stdin; the external path refuses to
  // write behind it.
  it('routes through the managed run when Codesk started the session', async () => {
    mount(controlled({ managedRunId: 'run-managed' }))
    await userEvent.type(composer(), 'keep going')
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() =>
      expect(api.input).toHaveBeenCalledWith('host-local', 'run-managed', 'keep going', 'steer'),
    )
    expect(api.externalSessionInput).not.toHaveBeenCalled()
  })

  it('queues on Tab instead of steering', async () => {
    vi.mocked(api.externalSessionInput).mockResolvedValue({ ok: true, delivery: 'steer' })
    mount(controlled())
    await userEvent.type(composer(), 'after this turn')
    await userEvent.tab()
    await waitFor(() =>
      expect(api.externalSessionInput).toHaveBeenCalledWith(
        expect.anything(),
        'after this turn',
        'queue',
      ),
    )
  })

  it('queues from the Queue button', async () => {
    vi.mocked(api.externalSessionInput).mockResolvedValue({ ok: true, delivery: 'queue' })
    mount(controlled())
    await userEvent.type(composer(), 'after this turn')
    await userEvent.click(screen.getByRole('button', { name: 'Queue' }))
    await waitFor(() =>
      expect(api.externalSessionInput).toHaveBeenCalledWith(
        expect.anything(),
        'after this turn',
        'queue',
      ),
    )
  })

  it('queues a managed run through the run input API', async () => {
    vi.mocked(api.input).mockResolvedValue({ ok: true })
    mount(controlled({ managedRunId: 'run-managed' }))
    await userEvent.type(composer(), 'after compact')
    await userEvent.click(screen.getByRole('button', { name: 'Queue' }))
    await waitFor(() =>
      expect(api.input).toHaveBeenCalledWith('host-local', 'run-managed', 'after compact', 'queue'),
    )
    expect(api.externalSessionInput).not.toHaveBeenCalled()
  })

  it('reports a send failure', async () => {
    vi.mocked(api.externalSessionInput).mockRejectedValue(new Error('tmux pane is gone'))
    mount(controlled())
    await userEvent.type(composer(), 'hello')
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(onError).toHaveBeenCalledWith('tmux pane is gone'))
  })
})

describe('SessionScreen · resuming a detached session', () => {
  it('starts a new run from the conversation', async () => {
    const run = makeRun({ id: 'run-1' })
    vi.mocked(api.resumeSession).mockResolvedValue(run)
    mount(makeSession({ id: 'session-a', status: 'idle' }))
    await userEvent.type(composer(), 'pick this back up')
    await userEvent.click(screen.getByRole('button', { name: 'Resume conversation' }))
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith(run))
  })

  it('offers no composer when the provider cannot resume', () => {
    mount(makeSession({ id: 'session-a', status: 'idle' }), [], makeProvider({ resume: false }))
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('offers no composer while the session is still running elsewhere', () => {
    mount(makeSession({ id: 'session-a', status: 'running' }))
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })
})

describe('SessionScreen · taking control of a terminal session', () => {
  it('offers to move a bare terminal session into tmux', async () => {
    mount(makeSession({ id: 'session-a', pid: 4242 }))
    await userEvent.click(screen.getByRole('button', { name: /Move to tmux/ }))
    await waitFor(() => expect(api.moveExternalToTmux).toHaveBeenCalled())
    expect(await screen.findByText(/Waiting for idle/)).toBeInTheDocument()
  })

  it('offers to adopt a session that is already in tmux', async () => {
    mount(makeSession({ id: 'session-a', pid: 4242, tmuxName: 'codesk-a' }))
    await userEvent.click(screen.getByRole('button', { name: /Enable control/ }))
    await waitFor(() => expect(api.adoptExternalTmux).toHaveBeenCalled())
  })

  it('adopts then steers when the pane is known but not yet controlled', async () => {
    vi.mocked(api.adoptExternalTmux).mockResolvedValue({
      ok: true,
      tmux_name: 'codesk-a',
      tmux_access_command: 'tmux attach-session -t codesk-a',
    })
    vi.mocked(api.externalSessionInput).mockResolvedValue({ ok: true, delivery: 'steer' })
    mount(
      makeSession({
        id: 'session-a',
        pid: 4242,
        tmuxName: 'codesk-a',
        tmuxAccessCommand: 'tmux attach-session -t codesk-a',
      }),
    )
    await userEvent.type(composer(), 'keep going')
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(api.adoptExternalTmux).toHaveBeenCalled())
    expect(api.externalSessionInput).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'session-a' }),
      'keep going',
      'steer',
    )
  })

  it('reports a failure to take control', async () => {
    vi.mocked(api.adoptExternalTmux).mockRejectedValue(new Error('no such pane'))
    mount(makeSession({ id: 'session-a', pid: 4242, tmuxName: 'codesk-a' }))
    await userEvent.click(screen.getByRole('button', { name: /Enable control/ }))
    await waitFor(() => expect(onError).toHaveBeenCalledWith('no such pane'))
  })

  it('says nothing about tmux once the session is controlled', () => {
    mount(controlled())
    expect(screen.queryByText(/Move to tmux|Enable control/)).not.toBeInTheDocument()
  })
})

describe('SessionScreen · queued prompts', () => {
  it('lists a managed run queue from run events', () => {
    mount(
      controlled({ managedRunId: 'run-managed' }),
      [],
      makeProvider(),
      [
        makeEvent({
          kind: 'queue.added',
          payload: { queue_id: 'q-run', text: 'after compact' },
        }),
      ],
    )
    expect(screen.getByText('1 queued')).toBeInTheDocument()
    expect(screen.getByText(/after compact/)).toBeInTheDocument()
  })

  it('lists what the harness has not picked up yet', async () => {
    vi.mocked(api.externalSessionQueue).mockResolvedValue([
      { id: 'q1', pid: 4242, message: 'second thing', status: 'queued' },
    ] as Awaited<ReturnType<typeof api.externalSessionQueue>>)
    mount(controlled())
    expect(await screen.findByText('1 queued')).toBeInTheDocument()
    expect(screen.getByText(/second thing/)).toBeInTheDocument()
  })

  it('removes a queued prompt', async () => {
    vi.mocked(api.externalSessionQueue).mockResolvedValue([
      { id: 'q1', pid: 4242, message: 'second thing', status: 'queued' },
    ] as Awaited<ReturnType<typeof api.externalSessionQueue>>)
    mount(controlled())
    await userEvent.click(await screen.findByRole('button', { name: 'Remove queued prompt' }))
    await waitFor(() =>
      expect(api.removeExternalQueued).toHaveBeenCalledWith('host-local', 4242, 'q1'),
    )
  })

  // The daemon promotes a queued prompt into a run; the screen must hand that
  // run up rather than keep showing it as pending.
  it('adopts a queued prompt that has become a run', async () => {
    const run = makeRun({ id: 'run-1' })
    vi.mocked(api.externalSessionQueue).mockResolvedValue([
      { id: 'q1', pid: 4242, message: 'second thing', status: 'started', run },
    ] as Awaited<ReturnType<typeof api.externalSessionQueue>>)
    mount(controlled())
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith(run))
    expect(api.removeExternalQueued).toHaveBeenCalledWith('host-local', 4242, 'q1')
  })
})

describe('SessionScreen · environment', () => {
  it('describes where the session is running', async () => {
    mount(
      controlled({
        tmuxAccessCommand: 'tmux attach-session -t codesk-a',
      }),
    )
    await userEvent.click(screen.getByRole('button', { name: /Environment/ }))
    const panel = screen.getByText('Project').closest('div')!.parentElement!
    expect(within(panel).getByText('codesk')).toBeInTheDocument()
    expect(within(panel).getByText('This Mac')).toBeInTheDocument()
    expect(within(panel).getByText('codesk-a')).toBeInTheDocument()
    expect(within(panel).getByText('tmux attach-session -t codesk-a')).toBeInTheDocument()
    expect(within(panel).queryByText('On host')).not.toBeInTheDocument()
  })

  it('shows the on-host tmux command for a remote session', async () => {
    const remote = makeHost({
      id: 'host-kortix',
      name: 'kortix-prod',
      type: 'ssh',
      sshAlias: 'kortix-prod',
    })
    const hostCommand =
      'tmux -S /root/.local/share/codesk/tmux/codesk.sock attach-session -t codesk-codex-4c92e1d5'
    render(
      <SessionScreen
        session={controlled({
          hostId: remote.id,
          tmuxName: 'codesk-codex-4c92e1d5',
          tmuxAccessCommand: `ssh -t 'kortix-prod' '${hostCommand}'`,
          tmuxHostAccessCommand: hostCommand,
        })}
        messages={[]}
        runEvents={[]}
        project={project}
        host={remote}
        provider={makeProvider()}
        onStarted={onStarted}
        onError={onError}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: /Environment/ }))
    const panel = screen.getByText('Project').closest('div')!.parentElement!
    expect(within(panel).getByText('kortix-prod')).toBeInTheDocument()
    expect(within(panel).getByText('Access')).toBeInTheDocument()
    expect(within(panel).getByText('On host')).toBeInTheDocument()
    expect(within(panel).getByText(hostCommand)).toBeInTheDocument()
  })
})
