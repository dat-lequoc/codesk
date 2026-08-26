import { describe, expect, it } from 'vitest'
import {
  formatFileSize,
  formatPromptWithAttachments,
  processAttachmentFiles,
  type ComposerAttachment,
} from './attachments'

describe('attachments utils', () => {
  it('formats file sizes nicely', () => {
    expect(formatFileSize(500)).toBe('500 B')
    expect(formatFileSize(2048)).toBe('2.0 KB')
    expect(formatFileSize(1048576 * 2.5)).toBe('2.5 MB')
  })

  it('formats prompt with no attachments', () => {
    expect(formatPromptWithAttachments('hello', [])).toBe('hello')
  })

  it('inlines text files and marks everything else as unsendable', async () => {
    const textFile = new File(['console.log("hello world")'], 'app.ts', { type: 'text/typescript' })
    const image = new File(['\x89PNG binary'], 'screenshot.png', { type: 'image/png' })
    const binFile = new File(['\x00\x01\x02\x03'], 'data.bin', { type: 'application/octet-stream' })

    const loaded = await processAttachmentFiles([textFile, image, binFile])
    expect(loaded).toHaveLength(3)
    expect(loaded[0].name).toBe('app.ts')
    expect(loaded[0].text).toBe('console.log("hello world")')
    expect(loaded[0].skipped).toBeUndefined()
    // No harness can read an image out of a prompt, so it is never inlined.
    expect(loaded[1].text).toBeUndefined()
    expect(loaded[1].skipped).toBe('only text files can be sent')
    expect(loaded[2].text).toBeUndefined()
    expect(loaded[2].skipped).toBe('only text files can be sent')
  })

  it('sends only the attachments it could read', () => {
    const attachments: ComposerAttachment[] = [
      { id: '1', name: 'screenshot.png', size: 10240, type: 'image/png', skipped: 'nope' },
      { id: '2', name: 'notes.txt', size: 200, type: 'text/plain', text: 'some notes content' },
      { id: '3', name: 'archive.zip', size: 50000, type: 'application/zip', skipped: 'nope' },
    ]

    const result = formatPromptWithAttachments('Please check these files', attachments)
    expect(result).toContain('Please check these files')
    expect(result).toContain('```notes.txt\nsome notes content\n```')
    expect(result).not.toContain('screenshot.png')
    expect(result).not.toContain('archive.zip')
  })

  it('leaves the prompt alone when nothing could be read', () => {
    const attachments: ComposerAttachment[] = [
      { id: '1', name: 'a.png', size: 10, type: 'image/png', skipped: 'nope' },
    ]
    expect(formatPromptWithAttachments('just text', attachments)).toBe('just text')
  })
})
