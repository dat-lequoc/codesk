import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AppState, Run, RunEvent } from './types'
import {
  makeEvent,
  makeHost,
  makeProject,
  makeRun,
  makeSession,
  makeState,
  resetIds,
} from './test/factories'

// The screens are covered on their own; here they stand in as markers so the
// assertions are about which one App chose and what it was handed.
vi.mock('./features/screens/RunScreen', () => ({
  RunScreen: ({ run, events }: { run: Run; events: RunEvent[] }) => (
    <div data-testid="run-screen" data-events={events.length}>
      {run.title}
    </div>
  ),
}))
vi.mock('./features/screens/SessionScreen', () => ({
  SessionScreen: ({ session }: { session: { title: string } }) => (
    <div data-testid="session-screen">{session.title}</div>
  ),
}))
vi.mock('./features/screens/StartScreen', () => ({
  StartScreen: () => <div data-testid="start-screen" />,
}))
vi.mock('./features/screens/ObservedScreen', () => ({
  ObservedScreen: () => <div data-testid="observed-screen" />,
}))
vi.mock('./lib/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/notifications')>()),
  notify: vi.fn(),
  prepareNotifications: vi.fn(async () => true),
}))
vi.mock('./api', () => ({
  gatewayOrigin: '',
  api: {
    state: vi.fn(),
    navigation: vi.fn(),
    events: vi.fn(),
    sessionMessages: vi.fn(),
    updateSettings: vi.fn(),
    createDraft: vi.fn(),
    createProject: vi.fn(),
    removeProject: vi.fn(),
    projectSessions: vi.fn(),
    refreshProjectSessions: vi.fn(),
  },
}))

const { App } = await import('./App')
const { api } = await import('./api')
const { notify } = await import('./lib/notifications')

/** Every socket App opens, newest last, so a test can drive it by hand. */
const sockets: FakeSocket[] = []

class FakeSocket {
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  closed = false
  constructor(public url: string) {
    sockets.push(this)
  }
  close() {
    this.closed = true
  }
  /** Deliver a gateway envelope the way the daemon would. */
  deliver(envelope: unknown) {
    this.onmessage?.({ data: JSON.stringify(envelope) })
  }
}

const host = makeHost({ id: 'host-local' })
const project = makeProject({ id: 'project-1', hostId: 'host-local', name: 'codesk' })

const baseState = (overrides: Partial<AppState> = {}) =>
  makeState({ hosts: [host], projects: [project], ...overrides })

/** Resolve the next `api.state()` with this snapshot. */
const serve = (state: AppState) => {
  vi.mocked(api.state).mockResolvedValue(structuredClone(state))
  vi.mocked(api.navigation).mockResolvedValue(structuredClone(state))
}

/** Force the 15s poller to run now instead of waiting for its timer. */
const poll = async () => {
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'))
  })
}

const unreadKeys = () => JSON.parse(localStorage.getItem('codesk.unread-notifications:v1') || '[]')

beforeEach(() => {
  resetIds()
  // The api and notification doubles live at module scope, so their call logs
  // would otherwise carry across tests.
  vi.clearAllMocks()
  sockets.length = 0
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.mocked(api.events).mockResolvedValue([])
  vi.mocked(api.sessionMessages).mockResolvedValue([])
  // jsdom reports the document as focused, which is what "the user is looking
  // at this" means to App.
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  serve(baseState())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const mount = async () => {
  const view = render(<App />)
  await waitFor(() => expect(api.state).toHaveBeenCalled())
  return view
}

describe('App · initial load', () => {
  it('renders the navigation snapshot and opens the newest session', async () => {
    const session = makeSession({ id: 'session-a', title: 'Refactor the sidebar' })
    serve(baseState({ sessions: [session] }))
    await mount()
    expect(await screen.findByTestId('session-screen')).toHaveTextContent('Refactor the sidebar')
    expect(screen.getByRole('button', { name: 'codesk' })).toBeInTheDocument()
  })

  it('falls back to the start screen when there is nothing to open', async () => {
    await mount()
    expect(await screen.findByTestId('start-screen')).toBeInTheDocument()
  })

  it('opens the newest run when there is no session', async () => {
    serve(baseState({ runs: [makeRun({ id: 'run-a', title: 'Fix the poller' })] }))
    await mount()
    expect(await screen.findByTestId('run-screen')).toHaveTextContent('Fix the poller')
  })
})

describe('App · run event loading', () => {
  it('fetches the selected run’s events exactly once across repeated polls', async () => {
    const run = makeRun({ id: 'run-a' })
    serve(baseState({ runs: [run] }))
    vi.mocked(api.events).mockResolvedValue([makeEvent({ run_id: 'run-a' })])
    await mount()
    await waitFor(() =>
      expect(screen.getByTestId('run-screen')).toHaveAttribute('data-events', '1'),
    )
    await poll()
    await poll()
    expect(vi.mocked(api.events).mock.calls.filter(([, id]) => id === 'run-a')).toHaveLength(1)
  })
})

describe('App · status transitions', () => {
  it('announces a run that finishes and records it as unread', async () => {
    const open = makeRun({ id: 'run-open', title: 'Open run' })
    const run = makeRun({ id: 'run-a', title: 'Fix the poller', status: 'running' })
    serve(baseState({ runs: [open, run] }))
    await mount()
    expect(notify).not.toHaveBeenCalled()

    serve(baseState({ runs: [open, { ...run, status: 'completed' }] }))
    await poll()
    await waitFor(() => expect(notify).toHaveBeenCalledOnce())
    expect(vi.mocked(notify).mock.calls[0][0]).toBe('Codesk · Run completed')
    expect(unreadKeys()).toContain('run:run-a')
  })

  // Watching a run finish is reading it. This is why the unread assertions
  // above all use a run that is not the one on screen.
  it('does not mark the run you are watching unread when it finishes', async () => {
    const run = makeRun({ id: 'run-a', title: 'Fix the poller', status: 'running' })
    serve(baseState({ runs: [run] }))
    await mount()
    await waitFor(() => expect(screen.getByTestId('run-screen')).toBeInTheDocument())

    serve(baseState({ runs: [{ ...run, status: 'completed' }] }))
    await poll()
    await waitFor(() => expect(notify).toHaveBeenCalledOnce())
    expect(unreadKeys()).toEqual([])
  })

  it('does not announce the same terminal status twice', async () => {
    const open = makeRun({ id: 'run-open', title: 'Open run' })
    const run = makeRun({ id: 'run-a', status: 'running' })
    serve(baseState({ runs: [open, run] }))
    await mount()
    serve(baseState({ runs: [open, { ...run, status: 'completed' }] }))
    await poll()
    await waitFor(() => expect(notify).toHaveBeenCalledOnce())
    await poll()
    await poll()
    expect(notify).toHaveBeenCalledOnce()
  })

  it('says nothing about a run that was already finished on the first snapshot', async () => {
    serve(baseState({ runs: [makeRun({ id: 'run-a', status: 'completed' })] }))
    await mount()
    await poll()
    expect(notify).not.toHaveBeenCalled()
    expect(unreadKeys()).toEqual([])
  })

  it('announces an external agent that stops, and marks its session unread', async () => {
    const session = makeSession({ id: 'session-a', title: 'Nightly sweep', status: 'running' })
    serve(baseState({ sessions: [session] }))
    await mount()

    serve(baseState({ sessions: [{ ...session, status: 'stopped' }] }))
    await poll()
    await waitFor(() => expect(notify).toHaveBeenCalledOnce())
    expect(vi.mocked(notify).mock.calls[0][0]).toBe('Codesk · Agent stopped')
  })

  it('stays silent when notifications are switched off, but still tracks unread', async () => {
    const open = makeRun({ id: 'run-open', title: 'Open run' })
    const run = makeRun({ id: 'run-a', status: 'running' })
    const off = (state: AppState) => ({
      ...state,
      settings: { ...state.settings, notifications: false },
    })
    serve(off(baseState({ runs: [open, run] })))
    await mount()
    serve(off(baseState({ runs: [open, { ...run, status: 'completed' }] })))
    await poll()
    await waitFor(() => expect(unreadKeys()).toContain('run:run-a'))
    expect(notify).not.toHaveBeenCalled()
  })
})

describe('App · websocket', () => {
  it('connects once and stays connected across polls', async () => {
    await mount()
    expect(sockets).toHaveLength(1)
    await poll()
    await poll()
    expect(sockets).toHaveLength(1)
    expect(sockets[0].closed).toBe(false)
  })

  it('appends a streamed event to the open run', async () => {
    const run = makeRun({ id: 'run-a' })
    serve(baseState({ runs: [run] }))
    await mount()
    await waitFor(() => expect(screen.getByTestId('run-screen')).toBeInTheDocument())
    await act(async () => {
      sockets[0].deliver({
        type: 'daemon.event',
        payload: { event: makeEvent({ run_id: 'run-a', event_id: 'event-live' }) },
      })
    })
    await waitFor(() =>
      expect(screen.getByTestId('run-screen')).toHaveAttribute('data-events', '1'),
    )
  })

  it('ignores a repeat of an event it already has', async () => {
    const run = makeRun({ id: 'run-a' })
    serve(baseState({ runs: [run] }))
    await mount()
    const event = makeEvent({ run_id: 'run-a', event_id: 'event-live' })
    await act(async () => {
      sockets[0].deliver({ type: 'daemon.event', payload: { event } })
      sockets[0].deliver({ type: 'daemon.event', payload: { event } })
    })
    await waitFor(() =>
      expect(screen.getByTestId('run-screen')).toHaveAttribute('data-events', '1'),
    )
  })

  it('marks a run unread when it asks for input while another is open', async () => {
    const open = makeRun({ id: 'run-open', title: 'Open run' })
    const other = makeRun({ id: 'run-other', title: 'Background run' })
    serve(baseState({ runs: [open, other] }))
    await mount()
    await act(async () => {
      sockets[0].deliver({
        type: 'daemon.event',
        payload: {
          event: makeEvent({
            run_id: 'run-other',
            kind: 'input.required',
            payload: { text: 'Approve?' },
          }),
        },
      })
    })
    await waitFor(() => expect(unreadKeys()).toContain('run:run-other'))
    expect(notify).toHaveBeenCalledWith('Codesk · Input required', 'Approve?', expect.any(String))
  })
})

describe('App · reading and selection', () => {
  it('clears the unread mark when the run is selected in the sidebar', async () => {
    const open = makeRun({ id: 'run-open', title: 'Open run' })
    const other = makeRun({ id: 'run-other', title: 'Background run' })
    localStorage.setItem('codesk.unread-notifications:v1', JSON.stringify(['run:run-other']))
    serve(baseState({ runs: [open, other] }))
    await mount()
    expect(await screen.findByLabelText('1 unread agent updates')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /Background run/ }))
    await waitFor(() => expect(unreadKeys()).toEqual([]))
    expect(screen.getByTestId('run-screen')).toHaveTextContent('Background run')
  })

  it('clears the unread mark on the open run when the window regains focus', async () => {
    vi.mocked(document.hasFocus).mockReturnValue(false)
    const run = makeRun({ id: 'run-a', title: 'Fix the poller', status: 'running' })
    serve(baseState({ runs: [run] }))
    await mount()
    await waitFor(() => expect(screen.getByTestId('run-screen')).toBeInTheDocument())

    serve(baseState({ runs: [{ ...run, status: 'completed' }] }))
    await poll()
    await waitFor(() => expect(unreadKeys()).toContain('run:run-a'))

    vi.mocked(document.hasFocus).mockReturnValue(true)
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => expect(unreadKeys()).toEqual([]))
  })

  it('leaves the unread mark alone while the window is in the background', async () => {
    vi.mocked(document.hasFocus).mockReturnValue(false)
    const run = makeRun({ id: 'run-a', status: 'running' })
    serve(baseState({ runs: [run] }))
    await mount()
    serve(baseState({ runs: [{ ...run, status: 'completed' }] }))
    await poll()
    await waitFor(() => expect(unreadKeys()).toContain('run:run-a'))
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(unreadKeys()).toContain('run:run-a')
  })

  it('redirects a tmux-backed run to the conversation that renders it', async () => {
    const session = makeSession({
      id: 'session-a',
      title: 'Attached tmux chat',
      nativeSessionId: 'native-a',
    })
    const run = makeRun({
      id: 'run-a',
      title: 'Tmux run',
      inputTransport: 'tmux',
      sessionId: 'native-a',
    })
    serve(baseState({ runs: [run], sessions: [session] }))
    await mount()
    expect(await screen.findByTestId('session-screen')).toHaveTextContent('Attached tmux chat')
    expect(screen.queryByTestId('run-screen')).not.toBeInTheDocument()
  })
})
