import { Info } from 'lucide-react'
import { memo, useContext, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'

import { FilePreviewContext } from '../../hooks/useFilePreview'
import { cn } from '../../lib/cn'
import { conversationText } from '../../lib/format'
import { externalHrefPattern, openExternalHref } from '../../lib/links'
import { markdownPlugins } from '../../lib/markdown'
// Memoized because ReactMarkdown re-parses its source on every render: without
// this, each streamed token re-parsed every visible message in the thread.
export const MarkdownContent = memo(function MarkdownContent({
  text,
  className = '',
}: {
  text: string
  className?: string
}) {
  const openFile = useContext(FilePreviewContext)
  // A fresh `components` object per render defeats ReactMarkdown's own
  // memoization, so it only changes when the file-preview handler does.
  const components = useMemo<Components>(
    () => ({
      a: ({ href = '', children, ...props }) => {
        const isAnchor = href.startsWith('#')
        const isExternal = externalHrefPattern.test(href) && !href.startsWith('file:')
        if (!isAnchor && !isExternal && openFile)
          return (
            <a
              {...props}
              href={href}
              onClick={(event) => {
                event.preventDefault()
                openFile(href)
              }}
            >
              {children}
            </a>
          )
        return (
          <a
            {...props}
            href={href}
            target={isExternal ? '_blank' : undefined}
            rel={isExternal ? 'noreferrer' : undefined}
            onClick={
              isExternal
                ? (event) => {
                    event.preventDefault()
                    void openExternalHref(href)
                  }
                : undefined
            }
          >
            {children}
          </a>
        )
      },
    }),
    [openFile],
  )
  return (
    <div className={cn('prose-codesk', className)}>
      <ReactMarkdown remarkPlugins={markdownPlugins} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
})

export function ConversationMessage({
  author,
  text,
  className = '',
  children,
}: {
  author: 'user' | 'assistant'
  text: string
  className?: string
  children?: React.ReactNode
}) {
  const content = conversationText(text)
  if (!content.text && content.hadContext)
    return (
      <div className="mb-6 ml-auto flex w-max max-w-full items-center gap-[7px] rounded-lg border border-line-strong px-2.5 py-[7px] text-[11px] text-muted">
        <Info size={13} />
        Environment context attached
      </div>
    )
  if (author === 'user')
    return (
      <div
        className={cn(
          'mb-6 md:mb-10 ml-auto w-max max-w-[88%] sm:max-w-[80%] md:max-w-[75%] rounded-2xl bg-ink-750 px-3.5 md:px-[15px] py-2 md:py-2.5 [overflow-wrap:anywhere] break-words [&_p]:mb-0',
          className,
        )}
      >
        <MarkdownContent text={content.text} />
        {children}
      </div>
    )
  return <MarkdownContent text={content.text} className={cn('mb-5 md:mb-[30px] min-w-0 max-w-full', className)} />
}
