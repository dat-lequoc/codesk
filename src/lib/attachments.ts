export type ComposerAttachment = {
  id: string
  name: string
  size: number
  type: string
  dataUrl?: string
  text?: string
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const TEXT_EXTENSIONS = new Set([
  'txt',
  'md',
  'markdown',
  'json',
  'js',
  'jsx',
  'ts',
  'tsx',
  'py',
  'rs',
  'c',
  'cpp',
  'h',
  'hpp',
  'cs',
  'go',
  'java',
  'kt',
  'rb',
  'php',
  'sh',
  'bash',
  'zsh',
  'yaml',
  'yml',
  'toml',
  'xml',
  'html',
  'css',
  'scss',
  'sass',
  'less',
  'sql',
  'csv',
  'tsv',
  'log',
  'env',
  'diff',
  'patch',
  'dockerfile',
  'makefile',
])

function isTextFile(file: File): boolean {
  if (file.type.startsWith('text/')) return true
  if (
    file.type === 'application/json' ||
    file.type === 'application/javascript' ||
    file.type === 'application/typescript' ||
    file.type === 'application/xml' ||
    file.type === 'application/x-yaml'
  ) {
    return true
  }
  const ext = file.name.split('.').pop()?.toLowerCase() || ''
  return TEXT_EXTENSIONS.has(ext)
}

export async function processAttachmentFiles(
  files: FileList | File[],
): Promise<ComposerAttachment[]> {
  const loaded: ComposerAttachment[] = []
  const count = 'length' in files ? files.length : (files as File[]).length
  for (let i = 0; i < count; i++) {
    const file = files instanceof FileList ? files[i] : (files as File[])[i]
    if (!file) continue
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    if (file.type.startsWith('image/')) {
      const dataUrl = await new Promise<string>((resolve) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result as string)
        reader.onerror = () => resolve('')
        reader.readAsDataURL(file)
      })
      loaded.push({
        id,
        name: file.name,
        size: file.size,
        type: file.type,
        dataUrl,
      })
    } else if (isTextFile(file)) {
      const text = await new Promise<string>((resolve) => {
        const reader = new FileReader()
        reader.onload = () => resolve((reader.result as string) || '')
        reader.onerror = () => resolve('')
        reader.readAsText(file.slice(0, 250_000))
      })
      loaded.push({
        id,
        name: file.name,
        size: file.size,
        type: file.type || 'text/plain',
        text,
      })
    } else {
      loaded.push({
        id,
        name: file.name,
        size: file.size,
        type: file.type || 'application/octet-stream',
      })
    }
  }
  return loaded
}

export function formatPromptWithAttachments(
  prompt: string,
  attachments: ComposerAttachment[],
): string {
  if (!attachments.length) return prompt
  const parts: string[] = []
  if (prompt.trim()) {
    parts.push(prompt.trim())
  }
  for (const att of attachments) {
    if (att.dataUrl) {
      parts.push(`![${att.name}](${att.dataUrl})`)
    } else if (att.text) {
      parts.push(`\`\`\`${att.name}\n${att.text}\n\`\`\``)
    } else {
      parts.push(`[Attached file: ${att.name} (${formatFileSize(att.size)})]`)
    }
  }
  return parts.join('\n\n')
}
