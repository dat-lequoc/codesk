import { describe, expect, it } from 'vitest'

import { externalHrefPattern, linkedFilePath } from './links'

describe('externalHrefPattern', () => {
  it('matches absolute URLs with a scheme', () => {
    for (const href of ['https://example.com', 'http://x', 'mailto:a@b.c', 'file:///tmp/a'])
      expect(externalHrefPattern.test(href)).toBe(true)
  })

  it('does not match a relative path or an anchor', () => {
    for (const href of ['src/App.tsx', './a.ts', '/abs/path', '#section'])
      expect(externalHrefPattern.test(href)).toBe(false)
  })

  it('is repeatable despite being a shared regex', () => {
    expect(externalHrefPattern.test('https://a')).toBe(externalHrefPattern.test('https://a'))
  })
})

describe('linkedFilePath', () => {
  const cwd = '/home/dev/codesk'

  it('resolves a relative path against the working directory', () => {
    expect(linkedFilePath('src/App.tsx', cwd)).toBe('/home/dev/codesk/src/App.tsx')
  })

  it('strips a leading ./', () => {
    expect(linkedFilePath('./src/App.tsx', cwd)).toBe('/home/dev/codesk/src/App.tsx')
  })

  it('leaves an absolute path alone', () => {
    expect(linkedFilePath('/etc/hosts', cwd)).toBe('/etc/hosts')
  })

  it('unwraps a file:// URL to its path', () => {
    expect(linkedFilePath('file:///etc/hosts', cwd)).toBe('/etc/hosts')
  })

  it('decodes percent-encoding, so spaces in names survive', () => {
    expect(linkedFilePath('file:///tmp/my%20file.ts', cwd)).toBe('/tmp/my file.ts')
  })

  it('drops a trailing line number, which editors append to links', () => {
    expect(linkedFilePath('src/App.tsx:42', cwd)).toBe('/home/dev/codesk/src/App.tsx')
  })

  it('drops a trailing line:column pair', () => {
    expect(linkedFilePath('src/App.tsx:42:7', cwd)).toBe('/home/dev/codesk/src/App.tsx')
  })

  it('drops a query string or fragment', () => {
    expect(linkedFilePath('src/App.tsx?plain=1', cwd)).toBe('/home/dev/codesk/src/App.tsx')
    expect(linkedFilePath('src/App.tsx#L10', cwd)).toBe('/home/dev/codesk/src/App.tsx')
  })

  it('does not double the separator when cwd has a trailing slash', () => {
    expect(linkedFilePath('a.ts', '/home/dev/')).toBe('/home/dev/a.ts')
  })

  it('leaves a malformed percent-escape intact instead of throwing', () => {
    expect(() => linkedFilePath('src/100%.ts', cwd)).not.toThrow()
  })
})
