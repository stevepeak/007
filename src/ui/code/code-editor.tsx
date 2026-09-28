import type { KeyboardEvent, ReactNode, RefObject } from 'react'

import { cn } from '../cn'

import { type CodeLanguage, highlightCode } from './highlight'

// The editable code surface: a transparent textarea floated over a highlighted
// `<pre>` holding the same text.
//
// It stays a textarea on purpose. The alternative — a contenteditable editor —
// would cost native field undo, `<Label htmlFor>`, Cmd+Enter submit, and the
// `selectionStart` arithmetic the Zod editor's autocomplete is built on, in
// exchange for colours we already get from `highlightCode`.
//
// The overlay is also the SIZER: it sits in normal flow holding the same
// wrapped text, so the box grows with the content while the textarea is
// absolutely positioned on top. The two therefore have to share a box model
// exactly — font, size, leading, padding, wrapping — or the tokens drift off
// the characters. Every one of those classes is duplicated below deliberately;
// change one, change both.

export type CodeEditorProps = {
  value: string
  language: CodeLanguage
  onChange: (next: string) => void
  onBlur?: () => void
  onFocus?: () => void
  onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void
  /** For callers that need the caret — completion popups, imperative focus. */
  textareaRef?: RefObject<HTMLTextAreaElement | null>
  /**
   * Lines of space the (empty) box holds open. Omit to size purely by content,
   * which is what a read-only block wants.
   */
  rows?: number
  /** Ghost text shown while empty. Never becomes the value. */
  placeholder?: string
  /**
   * Border treatment when the source doesn't hold up: `warn` (amber) for a
   * value the caller will still accept, `error` (red) for one it is refusing.
   */
  invalid?: 'warn' | 'error' | false
  readOnly?: boolean
  id?: string
  'aria-label'?: string
  className?: string
  /** Rendered over the textarea, inside the box — e.g. a help affordance. */
  children?: ReactNode
}

export function CodeEditor({
  value,
  language,
  onChange,
  onBlur,
  onFocus,
  onKeyDown,
  textareaRef,
  rows,
  placeholder,
  invalid = false,
  readOnly = false,
  id,
  'aria-label': ariaLabel,
  className,
  children,
}: CodeEditorProps) {
  return (
    <div className={cn('relative', className)}>
      {/* `min-h` keeps `rows` worth of space when empty; the trailing newline
          keeps the last line clear of the box's bottom edge. */}
      <pre
        aria-hidden
        style={
          rows == null
            ? undefined
            : { minHeight: `calc(${rows} * 1.625em + 1rem + 2px)` }
        }
        className="pointer-events-none m-0 whitespace-pre-wrap break-words rounded-md border border-transparent bg-neutral-50 px-3 py-2 font-mono text-xs leading-relaxed text-neutral-800"
      >
        {value ? (
          highlightCode(value, language)
        ) : placeholder ? (
          <span className="text-neutral-400">{placeholder}</span>
        ) : null}
        {'\n'}
      </pre>
      <textarea
        ref={textareaRef}
        id={id}
        aria-label={ariaLabel}
        value={value}
        spellCheck={false}
        readOnly={readOnly}
        // The text is local to the editing surface (callers store the parsed or
        // compiled result), so nothing upstream can restore a keystroke —
        // native field undo is the only undo there is.
        data-wf-undo="native"
        onChange={(e) => {
          if (readOnly) return
          onChange(e.target.value)
        }}
        onFocus={onFocus}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
        className={cn(
          'absolute inset-0 h-full w-full resize-none overflow-hidden whitespace-pre-wrap break-words rounded-md border bg-transparent px-3 py-2 font-mono text-xs leading-relaxed text-transparent outline-none',
          readOnly
            ? 'cursor-default border-neutral-200 caret-transparent'
            : invalid === 'error'
              ? 'border-red-400 caret-neutral-800 focus:border-red-500'
              : invalid === 'warn'
                ? 'border-amber-400 caret-neutral-800 focus:border-amber-500'
                : 'border-neutral-300 caret-neutral-800 focus:border-neutral-500',
        )}
      />
      {children}
    </div>
  )
}
