import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { ActivityEntry, ActivityLedgerItem } from '../../lib/activity'
import { ActivityInspectorPanel, ActivityLedger, ActivityRow } from './Activity'

const entry = (overrides: Partial<ActivityEntry> = {}): ActivityEntry => ({
  id: 'entry-1',
  type: 'tool',
  label: 'npm test',
  status: 'completed',
  changes: [],
  timestamp: new Date(1_700_000_000_000).toISOString(),
  raw: { some: 'payload' },
  ...overrides,
})

describe('ActivityRow', () => {
  it('renders the row label', () => {
    render(<ActivityRow entry={entry()} selected={false} onSelect={vi.fn()} />)
    expect(screen.getByRole('button', { name: /npm test/ })).toBeInTheDocument()
  })

  it('reports the entry when picked', async () => {
    const onSelect = vi.fn()
    const item = entry()
    render(<ActivityRow entry={item} selected={false} onSelect={onSelect} />)
    await userEvent.click(screen.getByRole('button'))
    expect(onSelect).toHaveBeenCalledWith(item)
  })

  it('renders a files entry with its summary', () => {
    render(
      <ActivityRow
        entry={entry({ type: 'files', label: 'Edited', changes: [{ path: 'a.ts', diff: '+1' }] })}
        selected={false}
        onSelect={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name: /Edited/ })).toBeInTheDocument()
  })

  it('renders a failed entry', () => {
    render(<ActivityRow entry={entry({ status: 'failed' })} selected={false} onSelect={vi.fn()} />)
    expect(screen.getByRole('button')).toBeInTheDocument()
  })
})

describe('ActivityLedger', () => {
  const items: ActivityLedgerItem[] = [
    { type: 'reasoning', id: 'r1', text: 'Thinking about it' },
    { type: 'entry', entry: entry({ id: 'e1', label: 'npm test' }) },
  ]

  it('renders reasoning and entries together', () => {
    render(<ActivityLedger items={items} selectedId={null} onSelect={vi.fn()} />)
    expect(screen.getByText('Thinking about it')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /npm test/ })).toBeInTheDocument()
  })

  it('renders nothing for an empty ledger', () => {
    const { container } = render(<ActivityLedger items={[]} selectedId={null} onSelect={vi.fn()} />)
    expect(container.querySelectorAll('button')).toHaveLength(0)
  })

  it('passes the selection down', () => {
    render(<ActivityLedger items={items} selectedId="e1" onSelect={vi.fn()} />)
    expect(screen.getByRole('button', { name: /npm test/ })).toBeInTheDocument()
  })
})

describe('ActivityInspectorPanel', () => {
  const show = (overrides: Partial<ActivityEntry> = {}) => {
    const onClose = vi.fn()
    render(
      <ActivityInspectorPanel
        entry={entry(overrides)}
        hostId="host-a"
        cwd="/home/dev/codesk"
        onClose={onClose}
      />,
    )
    return onClose
  }

  it('titles the panel with the entry label', () => {
    show()
    expect(screen.getByText('npm test')).toBeInTheDocument()
  })

  it('closes', async () => {
    const onClose = show()
    await userEvent.click(screen.getByRole('button', { name: 'Close activity inspector' }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('opens on the details tab', () => {
    show({ input: 'npm test', output: 'all good' })
    expect(screen.getByText('Input')).toBeInTheDocument()
    expect(screen.getByText('all good')).toBeInTheDocument()
  })

  it('switches to the raw payload tab', async () => {
    show()
    await userEvent.click(screen.getByRole('button', { name: 'Raw' }))
    expect(screen.getByText(/"some": "payload"/)).toBeInTheDocument()
  })

  it('says so when a tool reported no detail', () => {
    show({ input: undefined, output: undefined, changes: [] })
    expect(screen.getByText('This tool did not provide additional details.')).toBeInTheDocument()
  })

  it('labels failed output as an error', () => {
    show({ status: 'failed', output: 'boom' })
    expect(screen.getByText('Error output')).toBeInTheDocument()
  })

  it('lists changed files with their added and removed line counts', () => {
    // Two added lines and one removed line, so the badges read +2 and -1.
    show({ type: 'files', changes: [{ path: 'src/App.tsx', diff: '+a\n+b\n-c' }] })
    expect(screen.getByText('src/App.tsx')).toBeInTheDocument()
    expect(screen.getByText('+2')).toBeInTheDocument()
    expect(screen.getByText('-1')).toBeInTheDocument()
  })

  it('offers copy and open for a change with a path', () => {
    show({ type: 'files', changes: [{ path: 'src/App.tsx' }] })
    expect(screen.getByTitle('Copy path')).toBeInTheDocument()
    expect(screen.getByTitle('Open file')).toBeInTheDocument()
  })

  it('omits those controls for a change with no path', () => {
    show({ type: 'files', changes: [{ diff: '+1' }] })
    expect(screen.queryByTitle('Copy path')).not.toBeInTheDocument()
  })
})
