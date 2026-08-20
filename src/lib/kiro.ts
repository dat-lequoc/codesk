// Extracted from App.tsx during the Tailwind/module refactor.
import type { RunEvent } from '../types'

export type SlashCommand = {
  name: string
  description: string
  meta?: { hidden?: boolean; inputType?: string }
}

export type SlashSuggestion = { value: string; label: string; description: string; detail?: string }

export type KiroCommandContext = {
  commands: SlashCommand[]
  models: Array<{ id: string; description: string }>
  currentModel?: string
  currentEffort?: string
  modelsPending?: boolean
}

export const fallbackKiroCommands: SlashCommand[] = [
  { name: '/usage', description: 'Show billing and usage information' },
  {
    name: '/model',
    description: 'Select or list available models',
    meta: { inputType: 'selection' },
  },
  {
    name: '/effort',
    description: 'Set thinking effort for this session',
    meta: { inputType: 'selection' },
  },
  { name: '/compact', description: 'Compact conversation history' },
]

export const kiroEffortLevels = ['low', 'medium', 'high', 'xhigh', 'max']
// Kiro's model catalog is account-level, so one discovery per host is enough.

export const kiroModelCatalog = new Map<string, Array<{ id: string; description: string }>>()

export const recordValue = (value: unknown): Record<string, any> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : undefined

export const kiroCommandContext = (events: RunEvent[]): KiroCommandContext => {
  let commands: SlashCommand[] = []
  let models: Array<{ id: string; description: string }> = []
  let currentModel: string | undefined
  let currentEffort: string | undefined
  for (const event of events) {
    if (event.kind === 'commands.updated' && Array.isArray(event.payload.commands)) {
      commands = event.payload.commands.flatMap((value) => {
        const command = recordValue(value)
        const meta = recordValue(command?.meta)
        return typeof command?.name === 'string' && !meta?.hidden
          ? [
              {
                name: command.name,
                description: typeof command.description === 'string' ? command.description : '',
                meta,
              },
            ]
          : []
      })
    }
    if (typeof event.payload.effort === 'string') currentEffort = event.payload.effort
    const raw = recordValue(event.raw_payload)
    const result = recordValue(raw?.result)
    const modelState = recordValue(result?.models)
    if (typeof modelState?.currentModelId === 'string') currentModel = modelState.currentModelId
    if (Array.isArray(modelState?.availableModels))
      models = modelState.availableModels.flatMap((value: unknown) => {
        const model = recordValue(value)
        const id =
          typeof model?.modelId === 'string'
            ? model.modelId
            : typeof model?.id === 'string'
              ? model.id
              : ''
        return id
          ? [{ id, description: typeof model?.description === 'string' ? model.description : '' }]
          : []
      })
    if (event.kind === 'assistant.message' && typeof event.payload.text === 'string') {
      const changedModel = event.payload.text.match(/Model changed to\s+([^\s]+)/i)?.[1]
      const changedEffort = event.payload.text.match(/Effort set to\s+([^\s]+)/i)?.[1]
      if (changedModel) currentModel = changedModel
      if (changedEffort) currentEffort = changedEffort
    }
  }
  return {
    commands: commands.length ? commands : fallbackKiroCommands,
    models,
    currentModel,
    currentEffort,
  }
}

export const kiroSuggestionLimit = (message: string) => (/^\s*\/\S+\s/.test(message) ? 24 : 8)

export const kiroSlashSuggestions = (
  message: string,
  context: KiroCommandContext,
): SlashSuggestion[] => {
  const input = message.trimStart()
  if (!input.startsWith('/') || input.includes('\n')) return []
  const separator = input.search(/\s/)
  const commandName = (separator < 0 ? input : input.slice(0, separator)).toLowerCase()
  const argument =
    separator < 0
      ? ''
      : input
          .slice(separator + 1)
          .trim()
          .toLowerCase()
  if (separator < 0) {
    const priority = new Map(
      ['/usage', '/model', '/effort', '/compact'].map((name, index) => [name, index]),
    )
    return context.commands
      .filter((command) => command.name.toLowerCase().startsWith(commandName))
      .sort(
        (left, right) =>
          (priority.get(left.name) ?? 100) - (priority.get(right.name) ?? 100) ||
          left.name.localeCompare(right.name),
      )
      .map((command) => ({
        value:
          command.name === '/effort' || command.name === '/model'
            ? `${command.name} `
            : command.name,
        label: command.name,
        description: command.description,
      }))
  }
  if (commandName === '/model') {
    if (!context.models.length && context.modelsPending)
      return [
        {
          value: input,
          label: 'Reading model list',
          description: `Asking ${context.currentModel || 'the harness'} for its available models`,
          detail: 'Loading',
        },
      ]
    return context.models
      .filter(
        (model) =>
          !argument ||
          model.id.toLowerCase().includes(argument) ||
          model.description.toLowerCase().includes(argument),
      )
      .map((model) => ({
        value: `/model ${model.id}`,
        label: model.id,
        description: model.description,
        detail: model.id === context.currentModel ? 'Current model' : 'Model',
      }))
  }
  if (commandName === '/effort')
    return kiroEffortLevels
      .filter((effort) => effort.startsWith(argument))
      .map((effort) => ({
        value: `/effort ${effort}`,
        label: effort,
        description: `Use ${effort} thinking effort`,
        detail: effort === context.currentEffort ? 'Current effort' : 'Effort',
      }))
  return []
}
