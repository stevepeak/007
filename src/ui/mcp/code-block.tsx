import { Check, Copy } from 'lucide-react'
import { useState } from 'react'

import { cn } from '../cn'

export type CodeBlockProps = {
  /** The literal text, copied verbatim — never re-derived from the DOM. */
  code: string
  /** Caption on the block's header bar, e.g. a filename. */
  caption?: string
  className?: string
}

/**
 * A copyable snippet.
 *
 * The copy target is the `code` prop rather than the rendered node's
 * `textContent`: the block scrolls long lines rather than wrapping them, and
 * reading the DOM back would hand the user whatever the browser decided to do
 * with the whitespace.
 */
export function CodeBlock({ code, caption, className }: CodeBlockProps) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard is unavailable over plain HTTP and inside some embedded
      // views; the block stays selectable, so there is nothing to recover.
    }
  }

  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border border-neutral-200 bg-white',
        className,
      )}
    >
      <div className="flex items-center justify-between gap-3 border-b border-neutral-200 bg-neutral-50 px-3 py-1.5">
        <span className="font-mono text-[11px] tracking-wide text-neutral-500">
          {caption ?? 'shell'}
        </span>
        <button
          type="button"
          onClick={() => void copy()}
          aria-label={copied ? 'Copied' : 'Copy to clipboard'}
          className="inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[11px] text-neutral-500 transition-colors hover:text-neutral-900"
        >
          {copied ? (
            <Check className="size-3" />
          ) : (
            <Copy className="size-3" />
          )}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="overflow-x-auto px-3 py-3 text-xs leading-relaxed text-neutral-800">
        <code className="font-mono">{code}</code>
      </pre>
    </div>
  )
}
