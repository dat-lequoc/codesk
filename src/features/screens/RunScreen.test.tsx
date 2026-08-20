import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Provider, Run, RunEvent } from '../../types'
import {
  makeEvent,
  makeHost,
  makeProject,
  makeProvider,
  makeRun,
  resetIds,
} from '../../test/factories'

vi.mock('../../api', () => ({
  gatewayOrigin: '',
  api: {
    input: vi.fn(),
    resumeRun: vi.fn(),
    controlRun: vi.fn(),
    startQueued: vi.fn(),
    removeQueued: vi.fn(),
    openPath: vi.fn(),
    file: vi.fn(),
    worktreeStatus: vi.fn(),
    mergeWorktree: vi.fn(),
    removeWorktree: vi.fn(),
    projectContext: vi.fn(),
  },
}))

const { RunScreen } = await import('./RunScreen')
const { api } = await import('../../api')

const host = makeHost({ id: 'host-local', name: 'This Mac' })
const project = makeProject({ id: 'project-1', hostId: 'host-local', name: 'codesk' })
const onStarted = vi.fn()
const onError = vi.fn()

const mount = (run: Run, events: RunEvent[] = [], provider: Provider = makeProvider()) =>
  render(
    <RunScreen
      run={run}
      events={events}
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
  vi.mocked(api.projectContext).mockResolvedValue({
    available: true,
    branch: 'main',
    dirty: false,
    detached: false,
  } as Awaited<ReturnType<typeof api.projectContext>>)
})

describe('RunScreen · thread', () => {
  it('shows the prompt that opened the run when nothing has been said yet', () => {
    mount(makeRun({ id: 'run-1', title: 'Fix the poller', prompt: 'fix the flaky poller' }))
    expect(screen.getByText('Fix the poller')).toBeInTheDocument()
    expect(screen.getByText('fix the flaky poller')).toBeInTheDocument()
  })

  it('drops the synthetic prompt once the transcript carries the user message', () => {
    mount(makeRun({ id: 'run-1', prompt: 'fix the flaky poller' }), [
      makeEvent({
        run_id: 'run-1',
        kind: 'user.message',
        payload: { text: 'fix the flaky poller' },
      }),
    ])
    expect(screen.getAllByText('fix the flaky poller')).toHaveLength(1)
  })

  it('renders assistant output', () => {
    mount(makeRun({ id: 'run-1' }), [
      makeEvent({ run_id: 'run-1', kind: 'assistant.message', payload: { text: 'Fixed it.' } }),
    ])
    expect(screen.getByText('Fixed it.')).toBeInTheDocument()
  })
})

describe('RunScreen · composer', () => {
  it('will not send an empty prompt', async () => {
    mount(makeRun({ id: 'run-1', status: 'running' }))
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()
  })

  it('steers a live run', async () => {
    mount(makeRun({ id: 'run-1', status: 'running' }))
    await userEvent.type(composer(), 'also update the tests')
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() =>
      expect(api.input).toHaveBeenCalledWith('host-local', 'run-1', 'also update the tests'),
    )
    expect(composer()).toHaveValue('')
  })

  it('resumes a finished run through its session instead of steering', async () => {
    const next = makeRun({ id: 'run-2' })
    vi.mocked(api.resumeRun).mockResolvedValue(next)
    mount(makeRun({ id: 'run-1', status: 'completed', sessionId: 'native-a' }))
    await userEvent.type(composer(), 'one more thing')
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith(next))
    expect(api.input).not.toHaveBeenCalled()
  })

  it('cannot be typed into when a finished run has no resumable session', () => {
    mount(makeRun({ id: 'run-1', status: 'completed' }))
    expect(composer()).toBeDisabled()
  })

  it('reports a send failure', async () => {
    vi.mocked(api.input).mockRejectedValue(new Error('host went away'))
    mount(makeRun({ id: 'run-1', status: 'running' }))
    await userEvent.type(composer(), 'hello')
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(onError).toHaveBeenCalledWith('host went away'))
  })

  it('queues instead of steering when the provider takes queued input', async () => {
    mount(makeRun({ id: 'run-1', status: 'running' }), [], makeProvider({ queued_input: true }))
    await userEvent.type(composer(), 'after this turn')
    await userEvent.click(screen.getByRole('button', { name: /Queue/ }))
    await waitFor(() =>
      expect(api.input).toHaveBeenCalledWith('host-local', 'run-1', 'after this turn', 'queue'),
    )
  })

  it('keeps the draft per run, so switching back restores it', async () => {
    const { unmount } = mount(makeRun({ id: 'run-1', status: 'running' }))
    await userEvent.type(composer(), 'half a thought')
    unmount()
    mount(makeRun({ id: 'run-1', status: 'running' }))
    expect(composer()).toHaveValue('half a thought')
  })
})

describe('RunScreen · turn control', () => {
  it('offers an interrupt while the turn is running', async () => {
    mount(makeRun({ id: 'run-1', status: 'running' }))
    await userEvent.click(screen.getByRole('button', { name: /Interrupt/ }))
    expect(api.controlRun).toHaveBeenCalledWith('host-local', 'run-1', 'interrupt')
  })

  it('offers terminate and kill once an interrupt is in flight', () => {
    mount(makeRun({ id: 'run-1', status: 'interrupting' }))
    expect(screen.getByRole('button', { name: 'Terminate' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Kill' })).toBeInTheDocument()
  })

  it('does not offer an interrupt once the run is done', () => {
    mount(makeRun({ id: 'run-1', status: 'completed', sessionId: 'native-a' }))
    expect(screen.queryByRole('button', { name: /Interrupt/ })).not.toBeInTheDocument()
  })
})

describe('RunScreen · queued prompts', () => {
  const queuedRun = () =>
    mount(makeRun({ id: 'run-1', status: 'waiting_for_input' }), [
      makeEvent({
        run_id: 'run-1',
        kind: 'queue.added',
        payload: { queue_id: 'q1', text: 'second thing' },
      }),
    ])

  it('lists what is waiting to run', () => {
    queuedRun()
    expect(screen.getByText('1 queued')).toBeInTheDocument()
    expect(screen.getByText('second thing')).toBeInTheDocument()
  })

  it('starts the next queued prompt on request', async () => {
    queuedRun()
    await userEvent.click(screen.getByRole('button', { name: 'Run next' }))
    expect(api.startQueued).toHaveBeenCalledWith('host-local', 'run-1')
  })

  it('removes a queued prompt', async () => {
    queuedRun()
    await userEvent.click(screen.getByRole('button', { name: 'Remove queued prompt' }))
    expect(api.removeQueued).toHaveBeenCalledWith('host-local', 'run-1', 'q1')
  })
})

describe('RunScreen · environment', () => {
  it('opens on request and describes where the run is executing', async () => {
    mount(makeRun({ id: 'run-1', cwd: '/home/dev/codesk' }))
    expect(screen.queryByText('Environment', { selector: 'header' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /Environment/ }))
    const panel = screen.getByText('Path').closest('div')!.parentElement!
    expect(within(panel).getByText('/home/dev/codesk')).toBeInTheDocument()
    expect(within(panel).getByText('This Mac')).toBeInTheDocument()
  })

  it('reports the project branch once the host answers', async () => {
    mount(makeRun({ id: 'run-1' }))
    await userEvent.click(screen.getByRole('button', { name: /Environment/ }))
    await waitFor(() => expect(screen.getByText('main')).toBeInTheDocument())
  })

  it('opens the run folder', async () => {
    mount(makeRun({ id: 'run-1', cwd: '/home/dev/codesk' }))
    await userEvent.click(screen.getByRole('button', { name: /Environment/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Open folder' }))
    expect(api.openPath).toHaveBeenCalledWith('host-local', '/home/dev/codesk')
  })
})
