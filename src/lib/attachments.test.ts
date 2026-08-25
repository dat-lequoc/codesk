import { describe, expect, it } from 'vitest'
import { formatFileSize, formatPromptWithAttachments, type ComposerAttachment } from './attachments'

describe('attachments utils', () => {
  it('formats file sizes nicely', () => {
    expect(formatFileSize(500)).toBe('500 B')
    expect(formatFileSize(2048)).toBe('2.0 KB')
    expect(formatFileSize(1048576 * 2.5)).toBe('2.5 MB')
  })

  it('formats prompt with no attachments', () => {
    expect(formatPromptWithAttachments('hello', [])).toBe('hello')
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
