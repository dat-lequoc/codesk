import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '../../api'
import { ModelMenu } from './ModelMenu'

vi.mock('../../api', () => ({
  api: { providerModels: vi.fn(), setProviderModel: vi.fn() },
}))

const providerModels = vi.mocked(api.providerModels)
const setProviderModel = vi.mocked(api.setProviderModel)

const catalog = {
  models: [
    { id: 'gpt-5.6-sol', description: 'Latest frontier agentic coding model.' },
    { id: 'gpt-5.6-terra', description: 'Balanced agentic coding model.' },
  ],
  efforts: [
    { id: 'high', label: 'High' },
    { id: 'xhigh', label: 'Extra high' },
  ],
}

let hosts = 0
const renderMenu = (overrides: Partial<Parameters<typeof ModelMenu>[0]> = {}) => {
  hosts += 1
  const props = {
    hostId: `host-${hosts}`,
    runId: 'run-1',
    provider: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'high',
    onApplied: vi.fn(),
    ...overrides,
  }
  render(<ModelMenu {...props} />)
  return props
}

const open = async (name = /gpt-5.6-sol/) => {
  await userEvent.click(screen.getByRole('button', { name }))
  return screen.findByRole('menu')
}

beforeEach(() => {
  vi.clearAllMocks()
  providerModels.mockResolvedValue(catalog)
  setProviderModel.mockResolvedValue({ model: 'gpt-5.6-terra', effort: 'high' })
})

describe('ModelMenu', () => {
  it('shows the live model and effort of the session', () => {
    renderMenu()
    expect(screen.getByRole('button', { name: /gpt-5.6-sol · high/ })).toBeInTheDocument()
  })

  it('falls back to the tmux session name until the harness reports a model', () => {
    renderMenu({ model: undefined, effort: undefined, fallback: 'codesk-codex-5ded1bf3' })
    expect(screen.getByRole('button', { name: /codesk-codex-5ded1bf3/ })).toBeInTheDocument()
  })

  it('reads the catalog only when the menu is opened', async () => {
    renderMenu()
    expect(providerModels).not.toHaveBeenCalled()
    await open()
    expect(providerModels).toHaveBeenCalledWith(expect.stringMatching(/^host-/), 'run-1')
    expect(await screen.findByRole('menuitemradio', { name: /gpt-5.6-terra/ })).toBeInTheDocument()
    expect(screen.getByRole('menuitemradio', { name: /Extra high/ })).toBeInTheDocument()
  })

  it('marks the model and effort in use', async () => {
    renderMenu()
    await open()
    expect(await screen.findByRole('menuitemradio', { name: /gpt-5.6-sol/ })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    expect(screen.getByRole('menuitemradio', { name: /gpt-5.6-terra/ })).toHaveAttribute(
      'aria-checked',
      'false',
    )
    expect(screen.getByRole('menuitemradio', { name: /^High/ })).toHaveAttribute(
      'aria-checked',
      'true',
    )
  })

  it('changes the model and reports what the harness applied', async () => {
    const props = renderMenu()
    await open()
    await userEvent.click(await screen.findByRole('menuitemradio', { name: /gpt-5.6-terra/ }))
    expect(setProviderModel).toHaveBeenCalledWith(props.hostId, 'run-1', {
      model: 'gpt-5.6-terra',
    })
    expect(props.onApplied).toHaveBeenCalledWith({ model: 'gpt-5.6-terra', effort: 'high' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('changes the effort on its own', async () => {
    setProviderModel.mockResolvedValue({ model: 'gpt-5.6-sol', effort: 'xhigh' })
    const props = renderMenu()
    await open()
    await userEvent.click(await screen.findByRole('menuitemradio', { name: /Extra high/ }))
    expect(setProviderModel).toHaveBeenCalledWith(props.hostId, 'run-1', { effort: 'xhigh' })
    expect(props.onApplied).toHaveBeenCalledWith({ model: 'gpt-5.6-sol', effort: 'xhigh' })
  })

  it('keeps the menu open and explains why a change was refused', async () => {
    setProviderModel.mockRejectedValue(
      new Error('the harness is busy; wait for the turn to finish'),
    )
    const props = renderMenu()
    await open()
    await userEvent.click(await screen.findByRole('menuitemradio', { name: /gpt-5.6-terra/ }))
    expect(await screen.findByText(/the harness is busy/)).toBeInTheDocument()
    expect(props.onApplied).not.toHaveBeenCalled()
    expect(screen.getByRole('menu')).toBeInTheDocument()
  })

  it('reports a catalog that could not be read', async () => {
    providerModels.mockRejectedValue(new Error('this run is not attached to a tmux pane'))
    renderMenu()
    await open()
    expect(await screen.findByText(/not attached to a tmux pane/)).toBeInTheDocument()
  })

  it('reads the catalog once per host and provider', async () => {
    const props = renderMenu()
    await open()
    expect(await screen.findByRole('menuitemradio', { name: /gpt-5.6-terra/ })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /gpt-5.6-sol · high/ }))
    render(<ModelMenu {...props} runId="run-2" />)
    await userEvent.click(screen.getAllByRole('button', { name: /gpt-5.6-sol · high/ })[1])
    expect(await screen.findByRole('menuitemradio', { name: /gpt-5.6-terra/ })).toBeInTheDocument()
    expect(providerModels).toHaveBeenCalledOnce()
  })

  it('closes on Escape', async () => {
    renderMenu()
    await open()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
})
