import { Check, Copy } from 'lucide-react'
import { Fragment, type ReactNode, useState } from 'react'

import { cn } from './cn'
import { NoteMarkdown } from './editor/note-markdown'

// A small, dependency-free viewer for a step's Input / Logs / Output value. Two
// display "tags":
//   • as text — look only at the FIRST-LEVEL keys: show each as a `[key | value]`
//     pill at the top, then render any first-level string that is clearly markdown
//     (or just long) below in full — markdown via the hand-rolled NoteMarkdown.
//   • as json — the whole value as JSON, lightly syntax-highlighted.
// A copy button puts the pretty JSON on the clipboard. No AI, no new deps —
// same spirit as note-markdown.tsx.

type Mode = 'text' | 'json'

// Deliberately simple markdown detection — a heading marker at the start and
// enough length to be "real" text. Easy to broaden later.
const MD_MIN_LEN = 40
function looksLikeMarkdown(s: string): boolean {
  const t = s.trim()
  return t.length >= MD_MIN_LEN && /^#{1,6}\s/.test(t)
}

// A "small" first-level value shows inline as a `[key | value]` pill: scalars
// and short single-line strings (roughly a UUID's length or less). Objects,
// arrays, and longer text are NOT pilled — long text renders as a block below,
// and objects/arrays are left to the JSON view.
const SMALL_VALUE_MAX = 36
function isSmallValue(v: unknown): boolean {
  if (v === null) return true
  if (typeof v === 'number' || typeof v === 'boolean') return true
  if (typeof v === 'string') return !v.includes('\n') && v.length <= SMALL_VALUE_MAX
  return false
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

// A first-level string that is long/multiline renders as a full TextBlock — this
// is what counts as a "representative text body". Used both to pick which fields
// expand below the pills and to decide whether Text mode is worth defaulting to.
function isTextBody(v: unknown): boolean {
  return typeof v === 'string' && !isSmallValue(v)
}

// Does the value have any prose/markdown body to show in Text mode? A bare
// string, or a plain object with at least one long first-level string field.
// Objects that are only scalars/lists (pills) have no text body → prefer JSON.
function hasTextBody(v: unknown): boolean {
  if (typeof v === 'string') return v.trim().length > 0
  if (isPlainObject(v)) return Object.values(v).some(isTextBody)
  return false
}

function Pill({ label, value }: { label: string; value: unknown }) {
  return (
    <span className="inline-flex max-w-full items-center overflow-hidden rounded-full border border-neutral-200 bg-neutral-50 text-[11px]">
      <span className="shrink-0 px-2 py-0.5 font-medium text-neutral-500">
        {label}
      </span>
      <span className="truncate border-l border-neutral-200 bg-white px-2 py-0.5 font-mono text-neutral-700">
        {value === null ? 'null' : String(value)}
      </span>
    </span>
  )
}

// One expanded first-level text field: its key as a small label, then the body
// rendered as markdown when it looks like markdown, else preformatted text.
function TextBlock({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <div className="mb-1 text-[11px] font-medium text-neutral-500">
        {label}
      </div>
      {looksLikeMarkdown(text) ? (
        <div className="text-sm text-neutral-700">
          <NoteMarkdown text={text} />
        </div>
      ) : (
        <pre className="overflow-x-auto rounded bg-neutral-50 p-2 text-xs whitespace-pre-wrap text-neutral-700">
          {text}
        </pre>
      )}
    </div>
  )
}

// ── JSON syntax highlighting ─────────────────────────────────────────────────
// Tokenise the pretty-printed JSON string and wrap pieces in coloured spans.
// Strings that are object keys (immediately followed by a colon) are tinted
// differently from string values.
const JSON_TOKEN_RE =
  /("(?:\\.|[^"\\])*"(\s*:)?)|(\b-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|(\btrue\b|\bfalse\b)|(\bnull\b)/g

function highlightJson(json: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let key = 0
  let m: RegExpExecArray | null
  JSON_TOKEN_RE.lastIndex = 0
  while ((m = JSON_TOKEN_RE.exec(json)) !== null) {
    if (m.index > last) out.push(json.slice(last, m.index))
    if (m[1] !== undefined) {
      // String — a key when trailed by a colon, else a value.
      if (m[2]) {
        const str = m[1].slice(0, m[1].length - m[2].length)
        out.push(
          <Fragment key={key++}>
            <span className="text-sky-700">{str}</span>
            {m[2]}
          </Fragment>,
        )
      } else {
        out.push(
          <span key={key++} className="text-green-700">
            {m[1]}
          </span>,
        )
      }
    } else if (m[3] !== undefined) {
      out.push(
        <span key={key++} className="text-amber-700">
          {m[3]}
        </span>,
      )
    } else if (m[4] !== undefined) {
      out.push(
        <span key={key++} className="text-purple-700">
          {m[4]}
        </span>,
      )
    } else if (m[5] !== undefined) {
      out.push(
        <span key={key++} className="text-neutral-400">
          {m[5]}
        </span>,
      )
    }
    last = m.index + m[0].length
  }
  if (last < json.length) out.push(json.slice(last))
  return out
}

function JsonView({ value }: { value: unknown }) {
  return (
    <pre className="overflow-x-auto rounded bg-neutral-50 p-2 text-xs text-neutral-700">
      {highlightJson(JSON.stringify(value, null, 2))}
    </pre>
  )
}

function TextView({ value }: { value: unknown }) {
  // A bare string: render directly (markdown or plain text), no pills.
  if (typeof value === 'string') {
    return <TextBlock label="" text={value} />
  }

  // A plain object: small first-level values become [key | value] pills at the
  // top; longer string values render as full text blocks below. Nested objects
  // and arrays aren't pilled — they belong to the JSON view.
  if (isPlainObject(value)) {
    const entries = Object.entries(value)
    const pills = entries.filter(([, v]) => isSmallValue(v))
    // Array-valued keys collapse to a count pill (e.g. { memories: [...] } →
    // `[memories | 3 items]`) so their presence and size are visible in Text
    // mode without dumping the whole list — that's the JSON view's job.
    const listPills = entries.filter(([, v]) => Array.isArray(v)) as [
      string,
      unknown[],
    ][]
    const textBlocks = entries.filter(([, v]) => isTextBody(v))
    return (
      <div className="space-y-3">
        {pills.length || listPills.length ? (
          <div className="flex flex-wrap gap-1.5">
            {pills.map(([k, v]) => (
              <Pill key={k} label={k} value={v} />
            ))}
            {listPills.map(([k, v]) => (
              <Pill
                key={k}
                label={k}
                value={`${v.length} item${v.length === 1 ? '' : 's'}`}
              />
            ))}
          </div>
        ) : null}
        {textBlocks.length ? (
          <div className="space-y-3">
            {textBlocks.map(([k, v]) => (
              <TextBlock key={k} label={k} text={v as string} />
            ))}
          </div>
        ) : null}
      </div>
    )
  }

  // Arrays / scalars have no first-level keys — fall back to JSON.
  return <JsonView value={value} />
}

export type DataViewProps = {
  value: unknown
  className?: string
}

export function DataView({ value, className }: DataViewProps) {
  // Default to Text only when there's a real text body to show; otherwise the
  // JSON view is more useful than a lone row of pills.
  const [mode, setMode] = useState<Mode>(hasTextBody(value) ? 'text' : 'json')
  const [copied, setCopied] = useState(false)

  if (value === null || value === undefined) {
    return <span className="text-xs text-neutral-400">—</span>
  }

  const copy = () => {
    void navigator.clipboard
      ?.writeText(JSON.stringify(value, null, 2))
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
  }

  const tags: { id: Mode; label: string }[] = [
    { id: 'text', label: 'Text' },
    { id: 'json', label: 'JSON' },
  ]

  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-medium text-neutral-500">View as</span>
        <div className="inline-flex overflow-hidden rounded-md border border-neutral-200">
          {tags.map((t) => {
            const active = t.id === mode
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setMode(t.id)}
                className={cn(
                  'px-2.5 py-1 text-[11px] font-medium transition-colors',
                  active
                    ? 'bg-neutral-800 text-white'
                    : 'text-neutral-600 hover:bg-neutral-100',
                )}
              >
                {t.label}
              </button>
            )
          })}
        </div>
        <div className="flex-1" />
        <button
          type="button"
          onClick={copy}
          aria-label="Copy JSON to clipboard"
          className="inline-flex items-center gap-1 rounded p-1 text-[11px] text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600"
        >
          {copied ? (
            <Check className="size-3.5 text-green-600" />
          ) : (
            <Copy className="size-3.5" />
          )}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      {mode === 'json' ? (
        <JsonView value={value} />
      ) : (
        <TextView value={value} />
      )}
    </div>
  )
}
