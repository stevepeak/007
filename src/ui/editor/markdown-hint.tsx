import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'

import { cn } from '../cn'

// The Markdown affordance for every Markdown-enabled box (agent prompts, the
// user message, a canvas note). It used to be a grey paragraph under the box,
// which cost a block of vertical space on every editor to say something most
// authors only need once. It is now a single small mark floating in the box's
// bottom-right corner: always visible (so the box announces it takes Markdown),
// but silent until clicked, when it opens the full guide — the marks the box
// renders, and, where the text is a template, what a `${variable}` is for,
// since that is the ONLY route data takes from the workflow into the model.
//
// The panel is PORTALED to `document.body` and positioned with `fixed` coords
// off the button's rect: these boxes live inside scrolling inspectors, dialogs
// and the ReactFlow canvas, all of which would clip (or paint over) an in-flow
// `absolute` panel. Same reasoning as `Tooltip`.

// The marks the boxes actually render, each with the word for it. Kept short on
// purpose: this is a nudge, not a Markdown manual.
const MARKS: Array<[syntax: string, label: string]> = [
  ['**bold**', 'Bold'],
  ['*italic*', 'Italic'],
  ['`code`', 'Code'],
  ['# Heading', 'Heading'],
  ['- item', 'List'],
  ['> quote', 'Quote'],
  ['[text](url)', 'Link'],
]

// The Markdown mark (a rounded box around “M↓”). Drawn inline because lucide
// ships no Markdown icon, and this is the glyph people already recognise.
function MarkdownMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 208 128"
      aria-hidden="true"
      fill="none"
      className={className}
    >
      <rect
        x="5"
        y="5"
        width="198"
        height="118"
        rx="10"
        stroke="currentColor"
        strokeWidth="12"
      />
      <path
        fill="currentColor"
        d="M30 98V30h20l20 25 20-25h20v68H90V59L70 84 50 59v39zm125 0l-30-33h20V30h20v35h20z"
      />
    </svg>
  )
}

const GAP = 6
const MARGIN = 8

// Anchor the panel to the button: above it if it fits, otherwise below, and
// right-aligned but clamped inside the viewport.
function place(btn: DOMRect, panel: DOMRect) {
  const above = btn.top - GAP - panel.height
  const top =
    above >= MARGIN
      ? above
      : Math.max(
          MARGIN,
          Math.min(btn.bottom + GAP, window.innerHeight - panel.height - MARGIN),
        )
  const left = Math.max(
    MARGIN,
    Math.min(btn.right - panel.width, window.innerWidth - panel.width - MARGIN),
  )
  return { top, left }
}

export type MarkdownHintProps = {
  /**
   * Explain `${variables}` too. Off for boxes whose text is never interpolated
   * — a canvas note is read by people, not rendered into a prompt.
   */
  variables?: boolean
  /** Extra classes on the floating button's wrapper (position overrides). */
  className?: string
}

/**
 * The floating mark itself. Renders `absolute` in its nearest positioned
 * ancestor, so the caller's input wrapper needs `relative` — or just use
 * {@link MarkdownField}, which supplies it.
 */
export function MarkdownHint({
  variables = true,
  className,
}: MarkdownHintProps) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const reposition = useCallback(() => {
    const btn = btnRef.current
    const panel = panelRef.current
    if (!btn || !panel) return
    setPos(place(btn.getBoundingClientRect(), panel.getBoundingClientRect()))
  }, [])

  // Measure before paint so the panel never shows at the wrong spot first.
  useLayoutEffect(() => {
    if (open) reposition()
    // eslint-disable-next-line react-hooks/set-state-in-effect -- useLayoutEffect measurement — the position cannot be derived before paint
    else setPos(null)
  }, [open, reposition])

  // The panel is portaled, so it is NOT inside the button's subtree — dismissal
  // has to test both, or reading (and selecting) the text would close it.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (btnRef.current?.contains(t) || panelRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', reposition)
    // Capture: the box may sit in a scrolling inspector, not just the window.
    window.addEventListener('scroll', reposition, {capture: true})
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
    }
  }, [open, reposition])

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        aria-label="Markdown formatting help"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          // Floats over the box's own content, so it carries a background —
          // a long last line would otherwise run underneath it.
          'absolute bottom-1.5 right-1.5 z-10 flex size-6 items-center justify-center rounded-md bg-white/80 text-neutral-300 backdrop-blur-sm transition hover:bg-neutral-100 hover:text-neutral-600',
          open && 'bg-neutral-100 text-neutral-600',
          className,
        )}
      >
        <MarkdownMark className="h-3 w-[18px]" />
      </button>
      {open && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={panelRef}
              role="dialog"
              aria-label="Markdown formatting"
              style={{
                position: 'fixed',
                top: pos?.top ?? 0,
                left: pos?.left ?? 0,
                opacity: pos ? 1 : 0,
              }}
              className="z-[1000] w-[19rem] space-y-2.5 rounded-lg border border-neutral-200 bg-white p-3 text-xs text-neutral-600 shadow-lg"
            >
              <MarkdownHintBody variables={variables} />
            </div>,
            document.body,
          )
        : null}
    </>
  )
}

function MarkdownHintBody({ variables }: { variables: boolean }) {
  return (
    <>
      <p className="font-medium text-neutral-700">This box takes Markdown</p>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1">
        {MARKS.map(([syntax, label]) => (
          <div key={syntax} className="flex items-center gap-1.5">
            <code className="rounded bg-neutral-100 px-1 py-0.5 font-mono text-[11px] text-neutral-600">
              {syntax}
            </code>
            <span className="text-neutral-400">{label}</span>
          </div>
        ))}
      </div>
      {variables ? (
        <p className="border-t border-neutral-100 pt-2.5">
          <code className="rounded bg-indigo-100 px-1 py-0.5 font-medium text-indigo-700">
            {'${variable}'}
          </code>{' '}
          is a named slot filled in when the agent runs — every workflow node
          using this agent maps each name to real data (an upstream node&apos;s
          output, or a fixed value). Use one for anything that changes per run
          and keep the rest of the wording fixed; a name nobody maps reaches the
          model as the literal text{' '}
          <code className="rounded bg-neutral-100 px-1 py-0.5 font-mono text-[11px] text-neutral-600">
            {'${variable}'}
          </code>
          , which the workflow editor flags before you can publish. Names take
          letters, numbers,{' '}
          <code className="rounded bg-neutral-100 px-1 py-0.5 font-mono text-[11px] text-neutral-600">
            _
          </code>{' '}
          and{' '}
          <code className="rounded bg-neutral-100 px-1 py-0.5 font-mono text-[11px] text-neutral-600">
            -
          </code>{' '}
          — not spaces.
        </p>
      ) : null}
    </>
  )
}

export type MarkdownFieldProps = {
  /** The Markdown input — a textarea, a rich editor, anything. */
  children: ReactNode
  /** Extra classes for the wrapper that positions the mark. */
  className?: string
  /** Passed through to {@link MarkdownHint}. */
  variables?: boolean
}

/**
 * Wraps any Markdown input so the mark floats in ITS bottom-right corner. Use
 * this for plain `<Textarea>`-style boxes; editors that own their own
 * positioned wrapper (`PromptBodyEditor`) render `MarkdownHint` directly.
 */
export function MarkdownField({
  children,
  className,
  variables,
}: MarkdownFieldProps) {
  return (
    <div className={cn('relative', className)}>
      {children}
      <MarkdownHint variables={variables} />
    </div>
  )
}
