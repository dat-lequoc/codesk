import { describe, expect, it } from 'vitest'

import {
  bareRepositoryUrlPattern,
  type MarkdownNode,
  markdownPlugins,
  remarkBareRepositoryLinks,
  trimBareUrl,
} from './markdown'

/** Minimal mdast text node. */
const text = (value: string): MarkdownNode => ({ type: 'text', value })
/** Run the plugin over a root containing one paragraph of children. */
const run = (children: MarkdownNode[]) => {
  const tree: MarkdownNode = { type: 'root', children: [{ type: 'paragraph', children }] }
  remarkBareRepositoryLinks()(tree)
  return tree.children![0].children!
}
const linksIn = (children: MarkdownNode[]) =>
  children.filter((child) => child.type === 'link').map((child) => child.url)

describe('trimBareUrl', () => {
  it('drops trailing sentence punctuation', () => {
    expect(trimBareUrl('github.com/a/b.')).toBe('github.com/a/b')
    expect(trimBareUrl('github.com/a/b,')).toBe('github.com/a/b')
    expect(trimBareUrl('github.com/a/b?!')).toBe('github.com/a/b')
  })

  it('drops a closing bracket the URL never opened', () => {
    expect(trimBareUrl('github.com/a/b)')).toBe('github.com/a/b')
    expect(trimBareUrl('github.com/a/b]')).toBe('github.com/a/b')
  })

  it('keeps a bracket pair that belongs to the URL', () => {
    expect(trimBareUrl('github.com/a/b(c)')).toBe('github.com/a/b(c)')
  })

  it('leaves a clean URL untouched', () => {
    expect(trimBareUrl('github.com/a/b')).toBe('github.com/a/b')
  })
})

describe('bareRepositoryUrlPattern', () => {
  it('matches the forge hosts and www-prefixed domains', () => {
    for (const value of [
      'github.com/owner/repo',
      'gitlab.com/owner/repo',
      'bitbucket.org/owner/repo',
      'www.example.com',
    ]) {
      bareRepositoryUrlPattern.lastIndex = 0
      expect(bareRepositoryUrlPattern.test(value)).toBe(true)
    }
  })

  it('does not match a bare word or a plain domain without www', () => {
    for (const value of ['example', 'notaurl']) {
      bareRepositoryUrlPattern.lastIndex = 0
      expect(bareRepositoryUrlPattern.test(value)).toBe(false)
    }
  })
})

describe('remarkBareRepositoryLinks', () => {
  it('is registered alongside remark-gfm', () => {
    expect(markdownPlugins).toContain(remarkBareRepositoryLinks)
    expect(markdownPlugins).toHaveLength(2)
  })

  it('linkifies a bare repository URL', () => {
    expect(linksIn(run([text('see github.com/owner/repo')]))).toEqual([
      'https://github.com/owner/repo',
    ])
  })

  it('keeps the surrounding prose as text nodes', () => {
    const children = run([text('see github.com/owner/repo now')])
    expect(children[0]).toEqual(text('see '))
    expect(children.at(-1)).toEqual(text(' now'))
  })

  it('linkifies several URLs in one paragraph', () => {
    const urls = linksIn(run([text('github.com/a/b and gitlab.com/c/d')]))
    expect(urls).toEqual(['https://github.com/a/b', 'https://gitlab.com/c/d'])
  })

  it('leaves trailing punctuation outside the link', () => {
    const children = run([text('see github.com/owner/repo.')])
    expect(linksIn(children)).toEqual(['https://github.com/owner/repo'])
    expect(children.at(-1)).toEqual(text('.'))
  })

  it('does not touch text inside an existing link', () => {
    const children = run([
      { type: 'link', url: 'https://x', children: [text('github.com/owner/repo')] },
    ])
    expect(children).toHaveLength(1)
    expect(children[0].url).toBe('https://x')
  })

  it('does not linkify inside inline code', () => {
    const children = run([{ type: 'inlineCode', value: 'github.com/owner/repo' }])
    expect(linksIn(children)).toEqual([])
  })

  it('does not linkify inside a code block', () => {
    const tree: MarkdownNode = {
      type: 'root',
      children: [{ type: 'code', children: [text('github.com/a/b')] }],
    }
    remarkBareRepositoryLinks()(tree)
    expect(linksIn(tree.children![0].children!)).toEqual([])
  })

  it('leaves a paragraph with no URLs completely alone', () => {
    const children = run([text('nothing to see')])
    expect(children).toEqual([text('nothing to see')])
  })

  it('recurses into nested nodes such as emphasis', () => {
    const children = run([{ type: 'emphasis', children: [text('github.com/a/b')] }])
    expect(linksIn(children[0].children!)).toEqual(['https://github.com/a/b'])
  })

  it('is repeatable — the shared regex does not leak lastIndex between runs', () => {
    const first = linksIn(run([text('github.com/a/b')]))
    const second = linksIn(run([text('github.com/a/b')]))
    expect(second).toEqual(first)
  })
})
