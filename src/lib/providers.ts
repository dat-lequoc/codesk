// The provider registry: display metadata and the per-harness capability
// flags the UI keys off. Pure data, so editing it hot-reloads.
export type ProviderUi = {
  id: string
  name: string
  shortName: string
  color: string
  order: number
  queuedInput: boolean
  turnRewind: boolean
  closeAttached: boolean
  approvalMode: 'acp' | 'native'
  activeInput: 'steer' | 'queue'
}

const registry: Record<string, ProviderUi> = {
  codex: {
    id: 'codex',
    name: 'Codex',
    shortName: 'Codex',
    color: '#d5ded8',
    order: 0,
    queuedInput: true,
    turnRewind: true,
    closeAttached: true,
    approvalMode: 'native',
    activeInput: 'steer',
  },
  claude: {
    id: 'claude',
    name: 'Claude Code',
    shortName: 'Claude',
    color: '#d97757',
    order: 1,
    queuedInput: false,
    turnRewind: false,
    closeAttached: false,
    approvalMode: 'native',
    activeInput: 'steer',
  },
  opencode: {
    id: 'opencode',
    name: 'OpenCode',
    shortName: 'OpenCode',
    color: '#f0f2f1',
    order: 2,
    queuedInput: true,
    turnRewind: false,
    closeAttached: true,
    approvalMode: 'acp',
    activeInput: 'queue',
  },
  kiro: {
    id: 'kiro',
    name: 'Kiro CLI',
    shortName: 'Kiro',
    color: '#aab1ac',
    order: 3,
    queuedInput: true,
    turnRewind: false,
    closeAttached: false,
    approvalMode: 'acp',
    activeInput: 'queue',
  },
  pi: {
    id: 'pi',
    name: 'Pi',
    shortName: 'Pi',
    color: '#f0f2f1',
    order: 4,
    queuedInput: false,
    turnRewind: false,
    closeAttached: false,
    approvalMode: 'native',
    activeInput: 'steer',
  },
  agy: {
    id: 'agy',
    name: 'Antigravity',
    shortName: 'AGY',
    color: '#55a7ff',
    order: 5,
    queuedInput: false,
    turnRewind: false,
    closeAttached: false,
    approvalMode: 'native',
    activeInput: 'steer',
  },
  dsh: {
    id: 'dsh',
    name: 'DeepSeek Harness',
    shortName: 'DSH',
    color: '#5786fe',
    order: 6,
    queuedInput: true,
    turnRewind: false,
    closeAttached: true,
    approvalMode: 'native',
    activeInput: 'steer',
  },
  shell: {
    id: 'shell',
    name: 'Custom command',
    shortName: 'Shell',
    color: '#aab1ac',
    order: 7,
    queuedInput: false,
    turnRewind: false,
    closeAttached: false,
    approvalMode: 'native',
    activeInput: 'steer',
  },
}

export const providerRegistry = Object.values(registry).sort(
  (left, right) => left.order - right.order,
)
export const providerUi = (provider: string): ProviderUi =>
  registry[provider] || { ...registry.shell, id: provider, name: provider, shortName: provider }
export const providerName = (provider: string) => providerUi(provider).name
export const harnessOrder = providerRegistry
  .filter((provider) => provider.id !== 'shell')
  .map((provider) => provider.id)
