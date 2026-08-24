import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { TmuxDetails } from './Environment'

describe('TmuxDetails', () => {
  it('shows the access command and hides a duplicate on-host command', () => {
    render(
      <TmuxDetails
        name="codesk-a"
        command="tmux attach-session -t codesk-a"
        hostCommand="tmux attach-session -t codesk-a"
      />,
    )
    expect(screen.getByText('codesk-a')).toBeInTheDocument()
    expect(screen.getByText('tmux attach-session -t codesk-a')).toBeInTheDocument()
    expect(screen.queryByText('On host')).not.toBeInTheDocument()
  })

  it('adds the unwrapped command when the access command is SSH-wrapped', () => {
    const hostCommand =
      'tmux -S /root/.local/share/codesk/tmux/codesk.sock attach-session -t codesk-codex-4c92e1d5'
    render(
      <TmuxDetails
        name="codesk-codex-4c92e1d5"
        command={`ssh -t 'kortix-prod' '${hostCommand}'`}
        hostCommand={hostCommand}
      />,
    )
    expect(screen.getByText('Access')).toBeInTheDocument()
    expect(screen.getByText('On host')).toBeInTheDocument()
    expect(screen.getByText(hostCommand)).toBeInTheDocument()
    expect(screen.getByLabelText('Copy tmux command for this host')).toBeInTheDocument()
  })

  it('copies the on-host command', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const hostCommand = 'tmux -S /tmp/codesk.sock attach-session -t work'
    render(
      <TmuxDetails
        name="work"
        command="ssh -t 'kortix-prod' 'tmux -S /tmp/codesk.sock attach-session -t work'"
        hostCommand={hostCommand}
      />,
    )
    await userEvent.click(screen.getByLabelText('Copy tmux command for this host'))
    expect(writeText).toHaveBeenCalledWith(hostCommand)
    vi.unstubAllGlobals()
  })
})
