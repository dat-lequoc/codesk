export type ComposerAttachment = {
  id: string
  name: string
  size: number
  type: string
  text?: string
  /** Why the file could not be inlined. Set means it is not sent to the agent. */
  skipped?: string
}

/**
 * The gateway caps a request body at 1 MB and the whole prompt travels inside
 * it, so the inlined text has to leave room for the message itself.
 */
const MAX_FILE_BYTES = 250_000
const MAX_TOTAL_BYTES = 600_000

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const TEXT_EXTENSIONS = new Set([
  'bash',
  'c',
  'cfg',
  'conf',
  'cpp',
  'cs',
  'css',
  'csv',
  'diff',
  'dockerfile',
  'env',
  'go',
  'h',
  'hpp',
  'html',
  'ini',
  'java',
  'js',
  'json',
  'jsx',
  'kt',
  'less',
  'log',
  'lua',
  'makefile',
  'md',
  'markdown',
  'patch',
  'php',
  'py',
  'rb',
  'rs',
  'sass',
  'scss',
  'sh',
  'sql',
  'svg',
  'swift',
  'toml',
  'ts',
  'tsv',
  'tsx',
  'txt',
  'xml',
  'yaml',
  'yml',
  'zsh',
])

const TEXT_MIME_TYPES = new Set([
  'application/javascript',
  'application/json',
  'application/x-yaml',
  'application/xml',
  'application/typescript',
])

function isTextFile(file: File): boolean {
  if (file.type.startsWith('text/')) return true
  if (TEXT_MIME_TYPES.has(file.type)) return true
  const extension = file.name.split('.').pop()?.toLowerCase() || ''
  return TEXT_EXTENSIONS.has(extension)
}

const readText = (blob: Blob) =>
  new Promise<string>((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve((reader.result as string) || '')
    reader.onerror = () => resolve('')
    reader.readAsText(blob)
  })

/**
 * Inline what an agent can actually read.
 *
 * A harness receives the prompt as text, so a text file pastes in verbatim and
 * works. Everything else — images above all — has no path to the agent: the
 * daemon takes no uploads, and a base64 data URL in the prompt is an unreadable
 * blob that costs a fortune in tokens and overruns the request body. Those come
 * back marked `skipped` so the composer can say so instead of silently sending
 * nothing.
 */
export async function processAttachmentFiles(
  files: FileList | File[],
): Promise<ComposerAttachment[]> {
  const loaded: ComposerAttachment[] = []
  let budget = MAX_TOTAL_BYTES
  for (const file of Array.from(files)) {
    if (!file) continue
    const base = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: file.name,
      size: file.size,
      type: file.type || 'application/octet-stream',
    }
    if (!isTextFile(file)) {
      loaded.push({ ...base, skipped: 'only text files can be sent' })
      continue
    }
    if (budget <= 0) {
      loaded.push({ ...base, skipped: 'attachment size limit reached' })
      continue
    }
    const text = await readText(file.slice(0, Math.min(MAX_FILE_BYTES, budget)))
    budget -= text.length
    loaded.push({ ...base, type: file.type || 'text/plain', text })
  }
  return loaded
}

export function formatPromptWithAttachments(
  prompt: string,
  attachments: ComposerAttachment[],
): string {
  const usable = attachments.filter((item) => item.text)
  if (!usable.length) return prompt
  const parts: string[] = []
  if (prompt.trim()) parts.push(prompt.trim())
  for (const item of usable) parts.push(`\`\`\`${item.name}\n${item.text}\n\`\`\``)
  return parts.join('\n\n')
}
