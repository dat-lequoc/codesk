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

  it('processes text and binary files appropriately', async () => {
    const textFile = new File(['console.log("hello world")'], 'app.ts', { type: 'text/typescript' })
    const binFile = new File(['\x00\x01\x02\x03'], 'data.bin', { type: 'application/octet-stream' })

    const loaded = await processAttachmentFiles([textFile, binFile])
    expect(loaded).toHaveLength(2)
    expect(loaded[0].name).toBe('app.ts')
    expect(loaded[0].text).toBe('console.log("hello world")')
    expect(loaded[1].name).toBe('data.bin')
    expect(loaded[1].text).toBeUndefined()
  })

  it('formats prompt with image and text attachments', () => {
    const attachments: ComposerAttachment[] = [
      {
        id: '1',
        name: 'screenshot.png',
        size: 10240,
        type: 'image/png',
        dataUrl: 'data:image/png;base64,abc123',
      },
      {
        id: '2',
        name: 'notes.txt',
        size: 200,
        type: 'text/plain',
        text: 'some notes content',
      },
      {
        id: '3',
        name: 'archive.zip',
        size: 50000,
        type: 'application/zip',
      },
    ]

    const result = formatPromptWithAttachments('Please check these files', attachments)
    expect(result).toContain('Please check these files')
    expect(result).toContain('![screenshot.png](data:image/png;base64,abc123)')
    expect(result).toContain('```notes.txt\nsome notes content\n```')
    expect(result).toContain('[Attached file: archive.zip (48.8 KB)]')
  })
})
