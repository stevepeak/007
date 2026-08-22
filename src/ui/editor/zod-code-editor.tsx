import { HelpCircle } from 'lucide-react'
import { type ReactNode, useLayoutEffect, useRef, useState } from 'react'

import { cn } from '../cn'
import { Popover } from '../popover'

// A lightweight, dependency-free code editor for authoring an agent's structured
// output as a Zod schema. It's a styled textarea plus a token-aware autocomplete
// popup — no eval, no language server. The source is validated by the caller's
// safe `compileZodSource` parser; this component just handles editing + completion.

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

// Node/JS keywords worth tinting. The Zod DSL is a strict subset of JS, but the
// tokenizer stays generic so pasted snippets highlight sensibly too.
const KEYWORDS = new Set([
  'const',
  'let',
  'var',
  'function',
  'return',
  'import',
  'export',
  'from',
  'default',
  'new',
  'async',
  'await',
  'if',
  'else',
  'for',
  'while',
  'typeof',
  'true',
  'false',
  'null',
  'undefined',
])

type Token = { text: string; cls: string }

// A tiny single-pass lexer for the JS/Zod subset — no library, no eval. It only
// needs to be good enough to colorize; it never has to parse. Runs of plain
// whitespace/punctuation are emitted verbatim so the overlay stays 1:1 with the
// textarea's character grid.
function tokenize(source: string): Token[] {
  const out: Token[] = []
  const n = source.length
  let i = 0
  const isIdentStart = (c: string) => /[A-Z_$]/i.test(c)
  const isIdent = (c: string) => /[\w$]/.test(c)

  while (i < n) {
    const c = source[i]

    // Line comment — `//` or `#` to end of line.
    if ((c === '/' && source[i + 1] === '/') || c === '#') {
      let j = c === '#' ? i + 1 : i + 2
      while (j < n && source[j] !== '\n') j++
      out.push({ text: source.slice(i, j), cls: 'text-neutral-400 italic' })
      i = j
      continue
    }
    // Block comment.
    if (c === '/' && source[i + 1] === '*') {
      let j = i + 2
      while (j < n && !(source[j] === '*' && source[j + 1] === '/')) j++
      j = Math.min(n, j + 2)
      out.push({ text: source.slice(i, j), cls: 'text-neutral-400 italic' })
      i = j
      continue
    }
    // String / template literal (no interpolation parsing — colorized whole).
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1
      while (j < n) {
        if (source[j] === '\\') {
          j += 2
          continue
        }
        if (source[j] === c) {
          j++
          break
        }
        j++
      }
      out.push({ text: source.slice(i, j), cls: 'text-emerald-600' })
      i = j
      continue
    }
    // Number.
    if (/\d/.test(c)) {
      let j = i + 1
      while (j < n && /[0-9._a-fx]/i.test(source[j])) j++
      out.push({ text: source.slice(i, j), cls: 'text-amber-600' })
      i = j
      continue
    }
    // Identifier — classified by keyword / member / property-key context.
    if (isIdentStart(c)) {
      let j = i + 1
      while (j < n && isIdent(source[j])) j++
      const word = source.slice(i, j)
      let k = j
      while (k < n && (source[k] === ' ' || source[k] === '\t')) k++
      const isKey = source[k] === ':'
      let p = i - 1
      while (p >= 0 && (source[p] === ' ' || source[p] === '\t')) p--
      const isMember = source[p] === '.'
      let cls = 'text-neutral-800'
      if (KEYWORDS.has(word)) cls = 'text-purple-600'
      else if (word === 'z' || isMember) cls = 'text-sky-600'
      else if (isKey) cls = 'text-rose-600'
      out.push({ text: word, cls })
      i = j
      continue
    }
    // Everything else (whitespace, punctuation) — verbatim, dimmed if visible.
    out.push({ text: c, cls: /\s/.test(c) ? '' : 'text-neutral-400' })
    i += 1
  }
  return out
}

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
  const pendingCaret = useRef<number | null>(null)
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<Completion[]>([])
  const [active, setActive] = useState(0)

  // After an accept, `onChange` re-renders the (controlled) textarea; restore the
  // caret to where the completion left it once the new value is painted.
  useLayoutEffect(() => {
    if (pendingCaret.current != null && ref.current) {
      const at = pendingCaret.current
      ref.current.selectionStart = ref.current.selectionEnd = at
      pendingCaret.current = null
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
    const matches = COMPLETIONS.filter(
      (c) =>
        c.trigger.toLowerCase().startsWith(lower) &&
        c.trigger.toLowerCase() !== lower,
    )
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
    pendingCaret.current = start + c.insert.length - (c.caretBack ?? 0)
    setOpen(false)
    onChange(next)
  }

  return (
    <div className="relative">
      <div className="relative">
        {/* Highlight layer doubles as the sizer: it sits in normal flow so its
            height grows with the content (it holds the same wrapped text), and
            the transparent textarea is floated on top of it. It shares the
            textarea's box model (font, padding, wrapping) so tokens sit exactly
            on top of the characters the author types. `min-h` keeps `rows` worth
            of space when empty; the trailing newline keeps the last line clear. */}
        <pre
          aria-hidden
          style={
            readOnly
              ? undefined
              : { minHeight: `calc(${rows} * 1.625em + 1rem + 2px)` }
          }
          className={cn(
            'pointer-events-none m-0 whitespace-pre-wrap break-words rounded-md border border-transparent bg-neutral-50 px-3 py-2 font-mono text-xs leading-relaxed text-neutral-800',
          )}
        >
          {value ? (
            tokenize(value).map((t, i) =>
              t.cls ? (
                <span key={i} className={t.cls}>
                  {t.text}
                </span>
              ) : (
                t.text
              ),
            )
          ) : placeholder ? (
            <span className="text-neutral-400">{placeholder}</span>
          ) : null}
          {'\n'}
        </pre>
        <textarea
          ref={ref}
          value={value}
          spellCheck={false}
          readOnly={readOnly}
          onChange={(e) => {
            if (readOnly) return
            onChange(e.target.value)
            refresh(e.target)
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
          onBlur={() =>
            window.setTimeout(() => {
              setOpen(false)
              onBlur?.()
            }, 120)
          }
          className={cn(
            'absolute inset-0 h-full w-full resize-none overflow-hidden whitespace-pre-wrap break-words rounded-md border bg-transparent px-3 py-2 font-mono text-xs leading-relaxed text-transparent outline-none',
            readOnly
              ? 'cursor-default border-neutral-200 caret-transparent'
              : 'caret-neutral-800',
            readOnly
              ? undefined
              : invalid
                ? 'border-amber-400 focus:border-amber-500'
                : 'border-neutral-300 focus:border-neutral-500',
          )}
        />
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
      </div>
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
