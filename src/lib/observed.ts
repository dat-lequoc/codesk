import { providerUi } from './providers'
import type { DiscoveredAgent } from '../types'

/// djb2, compact enough to sit in a settings key without storing the full argv.
export const hashCommand = (command: string) => {
  let hash = 5381
  for (let index = 0; index < command.length; index++)
    hash = ((hash << 5) + hash + command.charCodeAt(index)) >>> 0
  return hash.toString(16)
}

/// Stable hide-key for a discovered process: host, pid, and a hash of argv so a
/// recycled pid with a different command does not stay hidden.
export const hiddenAgentKey = (hostId: string, agent: Pick<DiscoveredAgent, 'pid' | 'command'>) =>
  `${hostId}:${agent.pid}:${hashCommand(agent.command)}`

const folderBasename = (cwd?: string | null) => cwd?.split('/').filter(Boolean).at(-1)

const commandBasename = (command: string) =>
  command.split(/\s+/)[0]?.split('/').filter(Boolean).at(-1)

export const observedAgentTitle = (agent: DiscoveredAgent) => {
  const provider = providerUi(agent.provider).shortName
  const folder = folderBasename(agent.cwd)
  if (folder) return `${provider} · ${folder}`
  const binary = commandBasename(agent.command)
  return binary ? `${provider} · ${binary}` : provider
}

export const observedAgentTooltip = (agent: DiscoveredAgent) => {
  const cwd = agent.cwd || 'no working directory'
  return `${cwd}\npid ${agent.pid}\n${agent.command}`
}
