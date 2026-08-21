import { describe, expect, it } from 'vitest'

import { makeAgent } from '../test/factories'
import { hashCommand, hiddenAgentKey, observedAgentTitle, observedAgentTooltip } from './observed'

describe('hiddenAgentKey', () => {
  it('scopes by host, pid, and command so a recycled pid does not stay hidden', () => {
    const agent = makeAgent({ pid: 44002, command: 'kiro-cli chat' })
    expect(hiddenAgentKey('host-a', agent)).toBe(`host-a:44002:${hashCommand('kiro-cli chat')}`)
    expect(hiddenAgentKey('host-a', agent)).not.toBe(hiddenAgentKey('host-b', agent))
    expect(hiddenAgentKey('host-a', agent)).not.toBe(
      hiddenAgentKey('host-a', { ...agent, command: 'pi' }),
    )
  })
})

describe('observedAgentTitle', () => {
  it('names the row after the provider and the folder basename', () => {
    expect(
      observedAgentTitle(
        makeAgent({
          provider: 'kiro',
          cwd: '/Users/me/proj/agy-mcp',
          command: 'kiro-cli chat',
        }),
      ),
    ).toBe('Kiro · agy-mcp')
  })

  it('falls back to the short command when there is no cwd', () => {
    expect(
      observedAgentTitle(
        makeAgent({
          provider: 'pi',
          cwd: null,
          command: '/usr/local/bin/pi --model opus',
        }),
      ),
    ).toBe('Pi · pi')
  })
})

describe('observedAgentTooltip', () => {
  it('lists cwd, pid, and the full command', () => {
    expect(
      observedAgentTooltip(
        makeAgent({
          pid: 12,
          cwd: '/home/dev/codesk',
          command: 'kiro-cli chat',
        }),
      ),
    ).toBe('/home/dev/codesk\npid 12\nkiro-cli chat')
  })
})
