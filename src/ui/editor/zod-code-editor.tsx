import { useLayoutEffect, useRef, useState } from 'react'

import { cn } from '../cn'

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
  const isIdentStart = (c: string) => /[A-Za-z_$]/.test(c)
  const isIdent = (c: string) => /[\w$]/.test(c)

  while (i < n) {
    const c = source[i]

    // Line comment.
    if (c === '/' && source[i + 1] === '/') {
      let j = i + 2
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
    if (/[0-9]/.test(c)) {
      let j = i + 1
      while (j < n && /[0-9._a-fA-FxXeE]/.test(source[j])) j++
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
}

export function ZodCodeEditor({
  value,
  onChange,
  invalid,
  rows = 9,
}: ZodCodeEditorProps) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const preRef = useRef<HTMLPreElement>(null)
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
    const word = /[.A-Za-z]*$/.exec(upto)?.[0] ?? ''
    return { word, start: el.selectionStart - word.length }
  }

  function refresh(el: HTMLTextAreaElement) {
    const { word } = tokenBeforeCaret(el)
    if (word.length < 1 || (word[0] !== 'z' && word[0] !== '.')) {
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

  // Keep the highlight layer aligned with the textarea's scroll offset.
  function syncScroll(el: HTMLTextAreaElement) {
    if (!preRef.current) return
    preRef.current.scrollTop = el.scrollTop
    preRef.current.scrollLeft = el.scrollLeft
  }

  return (
    <div className="relative">
      <div className="relative">
        {/* Highlight layer, painted directly under the transparent textarea. It
            shares the textarea's box model (font, padding, wrapping) so tokens
            sit exactly on top of the characters the author types. */}
        <pre
          ref={preRef}
          aria-hidden
          className={cn(
            'pointer-events-none absolute inset-0 m-0 overflow-hidden whitespace-pre-wrap break-words rounded-md border border-transparent bg-neutral-50 px-3 py-2 font-mono text-xs leading-relaxed text-neutral-800',
          )}
        >
          {tokenize(value).map((t, i) =>
            t.cls ? (
              <span key={i} className={t.cls}>
                {t.text}
              </span>
            ) : (
              t.text
            ),
          )}
          {'\n'}
        </pre>
        <textarea
          ref={ref}
          value={value}
          spellCheck={false}
          rows={rows}
          onScroll={(e) => syncScroll(e.currentTarget)}
          onChange={(e) => {
            onChange(e.target.value)
            refresh(e.target)
            syncScroll(e.target)
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
          // Delay so a click on a suggestion (mousedown) still registers.
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          className={cn(
            'relative w-full resize-y whitespace-pre-wrap break-words rounded-md border bg-transparent px-3 py-2 font-mono text-xs leading-relaxed text-transparent caret-neutral-800 outline-none',
            invalid
              ? 'border-amber-400 focus:border-amber-500'
              : 'border-neutral-300 focus:border-neutral-500',
          )}
        />
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
