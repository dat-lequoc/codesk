import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import {
  CleanToolCard,
  ContextInjectionCard,
  GoalCard,
  ProducedFilesCard,
  TodoCard,
} from './CleanDshConversation'
import type { SessionMessage } from '../../types'

describe('CleanDshConversation components', () => {
  it('renders ContextInjectionCard and toggles expanded content', async () => {
    const msg: SessionMessage = {
      id: 'ctx-1',
      timestamp: '2026-08-25T00:00:00Z',
      role: 'user',
      text: 'Current runtime context. Sandbox: danger-full-access.',
      meta: { is_context_injection: true },
    }
    render(<ContextInjectionCard message={msg} />)
    expect(screen.getByText('Context injection')).toBeInTheDocument()
    expect(screen.getByText('Runtime context')).toBeInTheDocument()
    expect(
      screen.queryByText('Current runtime context. Sandbox: danger-full-access.'),
    ).not.toBeInTheDocument()

    // Click to expand
    await userEvent.click(screen.getByRole('button', { name: /Context injection/ }))
    expect(screen.getByText(/Current runtime context/)).toBeInTheDocument()
  })

  it('renders ProducedFilesCard with openable file chips', async () => {
    const openFile = vi.fn()
    const files = ['/home/ubuntu/src/App.tsx', '/home/ubuntu/crates/dsh.rs']
    render(<ProducedFilesCard files={files} onOpenFile={openFile} />)

    expect(screen.getByText('Produced')).toBeInTheDocument()
    expect(screen.getByText('App.tsx')).toBeInTheDocument()
    expect(screen.getByText('dsh.rs')).toBeInTheDocument()

    await userEvent.click(screen.getByText('App.tsx'))
    expect(openFile).toHaveBeenCalledWith('/home/ubuntu/src/App.tsx')
  })

  it('renders TodoCard with in-progress task expanded by default', () => {
    const todos = [
      { content: 'Task 1 done', status: 'completed' as const },
      { content: 'Task 2 active', status: 'in_progress' as const },
      { content: 'Task 3 pending', status: 'pending' as const },
    ]
    render(<TodoCard todos={todos} />)

    expect(screen.getByText('To-dos')).toBeInTheDocument()
    expect(screen.getByText('1 done')).toBeInTheDocument()
    expect(screen.getByText('1 in progress')).toBeInTheDocument()
    expect(screen.getByText('1 pending')).toBeInTheDocument()
    expect(screen.getByText('Task 1 done')).toBeInTheDocument()
    expect(screen.getByText('Task 2 active')).toBeInTheDocument()
    expect(screen.getByText('Task 3 pending')).toBeInTheDocument()
  })

  it('renders TodoCard collapsed when all tasks completed and expands on click', async () => {
    const todos = [
      { content: 'Task 1 done', status: 'completed' as const },
      { content: 'Task 2 done', status: 'completed' as const },
    ]
    render(<TodoCard todos={todos} />)

    expect(screen.getByText('To-dos')).toBeInTheDocument()
    expect(screen.getByText('2 done')).toBeInTheDocument()
    expect(screen.queryByText('Task 1 done')).not.toBeInTheDocument()

    // Click to expand
    await userEvent.click(screen.getByRole('button', { name: /To-dos/ }))
    expect(screen.getByText('Task 1 done')).toBeInTheDocument()
  })

  it('renders GoalCard with objective and action', () => {
    render(
      <GoalCard
        goal={{
          objective: 'Improve codesk fork',
          action: 'active',
        }}
      />,
    )
    expect(screen.getByText('Goal')).toBeInTheDocument()
    expect(screen.getByText('Improve codesk fork')).toBeInTheDocument()
    expect(screen.getByText('active')).toBeInTheDocument()
  })

  it('renders CleanToolCard for bash with expandable output', async () => {
    render(
      <CleanToolCard
        tool="bash"
        command="npm run test"
        output="87 tests passed"
        status="completed"
      />,
    )
    expect(screen.getByText('bash')).toBeInTheDocument()
    expect(screen.getByText('npm run test')).toBeInTheDocument()

    // Expand
    await userEvent.click(screen.getByRole('button', { name: /bash/ }))
    expect(screen.getByText('87 tests passed')).toBeInTheDocument()
  })
})
