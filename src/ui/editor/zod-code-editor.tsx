import { HelpCircle } from 'lucide-react'
import { type ReactNode, useLayoutEffect, useRef, useState } from 'react'

import { cn } from '../cn'
import { CodeEditor } from '../code/code-editor'
import { Popover } from '../popover'

// A code editor for authoring an agent's structured output as a Zod schema: the
// shared `CodeEditor` surface plus a token-aware autocomplete popup — no eval,
// no language server. The source is validated by the caller's safe
// `compileZodSource` parser; this component just handles editing + completion.
//
// The colours are `highlightCode`'s, over the `javascript` grammar. The Zod DSL
// is a strict subset of JS, so a real grammar reads it — and reads a pasted
// snippet — correctly, which the ~100-line lexer that used to live here only
// approximated.

type Completion = {
  label: string
  // Prefix the author types that surfaces this completion.
  trigger: string
  // Text inserted in place of the typed token.
  insert: string
  // How many chars from the end of `insert` to place the caret (lands it inside
  // parens/quotes/braces). Defaults to 0 (caret after the insert).
  caretBack?: number
}

// Ordered by how commonly each is reached for. `.`-prefixed ones are the
// chainable refinements; `z.`-prefixed ones are the type builders.
const COMPLETIONS: Completion[] = [
  {
    label: 'z.object({ … })',
    trigger: 'z.object',
    insert: 'z.object({\n  \n})',
    caretBack: 3,
  },
  { label: 'z.string()', trigger: 'z.string', insert: 'z.string()' },
  { label: 'z.number()', trigger: 'z.number', insert: 'z.number()' },
  { label: 'z.boolean()', trigger: 'z.boolean', insert: 'z.boolean()' },
  {
    label: 'z.array(z.string())',
    trigger: 'z.array',
    insert: 'z.array(z.string())',
    caretBack: 1,
  },
  {
    label: 'z.enum(["a", "b"])',
    trigger: 'z.enum',
    insert: 'z.enum(["a", "b"])',
    caretBack: 1,
  },
  { label: '.optional()', trigger: '.optional', insert: '.optional()' },
  { label: '.nullable()', trigger: '.nullable', insert: '.nullable()' },
  { label: '.nullish()', trigger: '.nullish', insert: '.nullish()' },
  { label: '.int()', trigger: '.int', insert: '.int()' },
  { label: '.array()', trigger: '.array', insert: '.array()' },
  {
    label: '.describe("…")',
    trigger: '.describe',
    insert: '.describe("")',
    caretBack: 2,
  },
]

export type ZodCodeEditorProps = {
  value: string
  onChange: (next: string) => void
  invalid?: boolean
  rows?: number
  /** Ghost/example text shown under the (empty) textarea. Never becomes value. */
  placeholder?: string
  /** Fired when the field loses focus — used to auto-format the source. */
  onBlur?: () => void
  /**
   * Show the source but don't let it be edited — used for the built-in output
   * shapes, where the schema is the SDK's, not the author's. The same editor
   * (same highlighting, same box) so a fixed contract reads as the same kind of
   * thing as one you write, just not yours to change.
   */
  readOnly?: boolean
  /**
   * Syntax reference for this editor, reachable from a `?` inside the field
   * itself. Set above the box it explains, that prose reads as loud as the
   * editor and is in the way once you've read it; here it's one glyph, opened
   * only by the author who wants it.
   */
  help?: ReactNode
}

export function ZodCodeEditor({
  value,
  onChange,
  invalid,
  rows = 9,
  placeholder,
  onBlur,
  readOnly = false,
  help,
}: ZodCodeEditorProps) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const pendingCaretRef = useRef<number | null>(null)
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<Completion[]>([])
  const [active, setActive] = useState(0)

  // After an accept, `onChange` re-renders the (controlled) textarea; restore the
  // caret to where the completion left it once the new value is painted.
  useLayoutEffect(() => {
    if (pendingCaretRef.current != null && ref.current) {
      const at = pendingCaretRef.current
      ref.current.selectionStart = ref.current.selectionEnd = at
      pendingCaretRef.current = null
    }
  })

  // The `[.\w]` run ending at the caret — the token we complete against.
  function tokenBeforeCaret(el: HTMLTextAreaElement) {
    const upto = el.value.slice(0, el.selectionStart)
    const word = /[.A-Z]*$/i.exec(upto)?.[0] ?? ''
    return { word, start: el.selectionStart - word.length }
  }

  function refresh(el: HTMLTextAreaElement) {
    const { word } = tokenBeforeCaret(el)
    if (word.length === 0 || (word[0] !== 'z' && word[0] !== '.')) {
      setOpen(false)
      return
    }
    const lower = word.toLowerCase()
    const matches = COMPLETIONS.filter((c) => {
      return (
        c.trigger.toLowerCase().startsWith(lower) &&
        c.trigger.toLowerCase() !== lower
      )
    })
    setItems(matches)
    setActive(0)
    setOpen(matches.length > 0)
  }

  function accept(c: Completion) {
    const el = ref.current
    if (!el) return
    const { start } = tokenBeforeCaret(el)
    const caret = el.selectionStart
    const next = el.value.slice(0, start) + c.insert + el.value.slice(caret)
    pendingCaretRef.current = start + c.insert.length - (c.caretBack ?? 0)
    setOpen(false)
    onChange(next)
  }

  return (
    <div className="relative">
      <CodeEditor
        language="javascript"
        textareaRef={ref}
        value={value}
        onChange={(next) => {
          onChange(next)
          // The caret has already moved with the input, so the completion list
          // is refreshed off the live element rather than off `next`.
          if (ref.current) refresh(ref.current)
        }}
        onKeyDown={(e) => {
          if (!open || items.length === 0) return
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setActive((a) => (a + 1) % items.length)
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setActive((a) => (a - 1 + items.length) % items.length)
          } else if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault()
            accept(items[active])
          } else if (e.key === 'Escape') {
            e.preventDefault()
            setOpen(false)
          }
        }}
        // Delay so a click on a suggestion (mousedown) still registers, then
        // close the popup and let the parent format the committed source.
        onBlur={() => {
          window.setTimeout(() => {
            setOpen(false)
            onBlur?.()
          }, 120)
        }}
        readOnly={readOnly}
        rows={readOnly ? undefined : rows}
        placeholder={placeholder}
        // Amber, not red: an uncompilable schema is still the author's work in
        // progress, and the caller keeps it.
        invalid={!readOnly && invalid ? 'warn' : false}
      >
        {/* Sits above the (inset-0) textarea, so it stays clickable over the
            editing surface. */}
        {help ? (
          <Popover
            className="absolute right-1.5 top-1.5 z-20"
            panelClassName="absolute right-0 top-full z-30 mt-1 w-80 rounded-md border border-neutral-200 bg-white p-3 text-xs leading-relaxed text-neutral-500 shadow-lg"
            trigger={(api) => (
              <button
                type="button"
                aria-label="Schema syntax help"
                aria-expanded={api.open}
                onClick={api.toggle}
                className={cn(
                  'flex size-5 items-center justify-center rounded transition',
                  api.open
                    ? 'bg-neutral-200 text-neutral-700'
                    : 'text-neutral-300 hover:bg-neutral-200 hover:text-neutral-600',
                )}
              >
                <HelpCircle className="size-3.5" />
              </button>
            )}
          >
            {() => help}
          </Popover>
        ) : null}
      </CodeEditor>
      {open ? (
        <ul className="absolute left-0 top-full z-10 mt-1 max-h-48 w-60 overflow-auto rounded-md border border-neutral-200 bg-white py-1 shadow-lg">
          {items.map((c, i) => (
            <li key={c.trigger}>
              <button
                type="button"
                // mousedown (not click) so it fires before the textarea blurs.
                onMouseDown={(e) => {
                  e.preventDefault()
                  accept(c)
                }}
                className={cn(
                  'block w-full px-3 py-1.5 text-left font-mono text-xs',
                  i === active
                    ? 'bg-neutral-900 text-white'
                    : 'text-neutral-700 hover:bg-neutral-100',
                )}
              >
                {c.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
