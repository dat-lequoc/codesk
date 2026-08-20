// Extracted from App.tsx during the Tailwind/module refactor.
import remarkGfm from 'remark-gfm'

export const bareRepositoryUrlPattern =
  /\b(?:www\.[a-z\d](?:[a-z\d-]*[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]*[a-z\d])?)+(?:\/[^\s<]*)?|(?:github\.com|gitlab\.com|bitbucket\.org)\/[^\s<]+)/gi

export const trimBareUrl = (value: string) => {
  let result = value.replace(/[.,;:!?]+$/, '')
  for (const [open, close] of [
    ['(', ')'],
    ['[', ']'],
    ['{', '}'],
  ] as const) {
    while (result.endsWith(close) && result.split(open).length < result.split(close).length)
      result = result.slice(0, -1)
  }
  return result
}

/// The slice of mdast this plugin touches. Typing it structurally keeps the
/// tree honest without pulling in `@types/mdast` for four fields.
export type MarkdownNode = {
  type: string
  value?: string
  url?: string
  children?: MarkdownNode[]
}

export const remarkBareRepositoryLinks = () => (tree: MarkdownNode) => {
  const walk = (parent: MarkdownNode) => {
    if (
      !Array.isArray(parent.children) ||
      ['link', 'linkReference', 'code', 'inlineCode'].includes(parent.type)
    )
      return
    for (let index = 0; index < parent.children.length; index += 1) {
      const child = parent.children[index]
      if (child.type !== 'text' || typeof child.value !== 'string') {
        walk(child)
        continue
      }
      bareRepositoryUrlPattern.lastIndex = 0
      const replacement: MarkdownNode[] = []
      let cursor = 0
      let match: RegExpExecArray | null
      while ((match = bareRepositoryUrlPattern.exec(child.value))) {
        const raw = match[0]
        const linked = trimBareUrl(raw)
        if (!linked) continue
        if (match.index > cursor)
          replacement.push({ type: 'text', value: child.value.slice(cursor, match.index) })
        replacement.push({
          type: 'link',
          url: `https://${linked}`,
          children: [{ type: 'text', value: linked }],
        })
        if (linked.length < raw.length)
          replacement.push({ type: 'text', value: raw.slice(linked.length) })
        cursor = match.index + raw.length
      }
      if (!replacement.length) continue
      if (cursor < child.value.length)
        replacement.push({ type: 'text', value: child.value.slice(cursor) })
      parent.children.splice(index, 1, ...replacement)
      index += replacement.length - 1
    }
  }
  walk(tree)
}

export const markdownPlugins = [remarkGfm, remarkBareRepositoryLinks]
