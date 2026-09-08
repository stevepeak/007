import { ThumbsDown, ThumbsUp } from 'lucide-react'
import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'

import type { WfFeedbackRating } from '../server/protocol'

import { cn } from './cn'
import { useSubmitFeedback } from './hooks-feedback'

// The reusable thumbs strip shown under an assistant answer, in two forms:
//
//  • `MessageFeedbackView` — PRESENTATIONAL. Takes the current rating/note and an
//    `onSubmit` callback; owns no data client. A host that already has its own
//    authenticated write path renders this and routes the write itself (no
//    `WfSdkProvider` required in the surrounding tree).
//  • `MessageFeedback` — SELF-CONTAINED. Wraps the View and owns the write via
//    `useSubmitFeedback` (the SDK RPC). A host just gives it the subject's
//    identity + display snapshots. Requires `WfSdkProvider`.
//
// The active thumb stays lit regardless of hover so a glance shows "this answer
// has feedback"; the rest reveal on the parent's `group` hover. Clicking a thumb
// saves immediately and opens an inline note box.

export type MessageFeedbackSubmit = {
  rating: WfFeedbackRating | null
  note: string | null
}

export type MessageFeedbackViewProps = {
  rating: WfFeedbackRating | null
  note: string | null
  pending?: boolean
  onSubmit: (args: MessageFeedbackSubmit) => void
  /**
   * Keep the inactive thumbs at full opacity instead of revealing them on the
   * parent's `group` hover. Use for a standalone, page-level feedback control
   * (e.g. a document header); leave off for the inline chat strip where the
   * thumbs should stay unobtrusive until hovered.
   */
  alwaysVisible?: boolean
  className?: string
}

export function MessageFeedbackView({
  rating,
  note,
  pending,
  onSubmit,
  alwaysVisible,
  className,
}: MessageFeedbackViewProps) {
  const [open, setOpen] = useState<WfFeedbackRating | null>(null)
  // The note box anchors to this strip, from outside the flow (see NoteBox).
  const stripRef = useRef<HTMLDivElement>(null)

  const handleThumb = (kind: WfFeedbackRating) => {
    // Save the rating immediately so the click registers even if the note box is
    // dismissed without typing. Carry over any existing note when switching.
    if (kind !== rating) onSubmit({ rating: kind, note })
    setOpen((cur) => (cur === kind ? null : kind))
  }

  return (
    <div ref={stripRef} className={cn('flex items-center gap-1', className)}>
      <ThumbButton
        kind="up"
        active={rating === 'up'}
        pending={pending && open === 'up'}
        alwaysVisible={alwaysVisible}
        onClick={() => handleThumb('up')}
      />
      <ThumbButton
        kind="down"
        active={rating === 'down'}
        pending={pending && open === 'down'}
        alwaysVisible={alwaysVisible}
        onClick={() => handleThumb('down')}
      />
      {note && rating ? (
        <span
          className="ml-1 max-w-[28rem] truncate text-xs italic text-neutral-500"
          title={note}
        >
          “{note}”
        </span>
      ) : null}

      {open ? (
        <NoteBox
          anchorRef={stripRef}
          kind={open}
          initialNote={rating === open ? note : null}
          canClear={rating === open}
          onSave={(n) => {
            onSubmit({ rating: open, note: n })
            setOpen(null)
          }}
          onClear={() => {
            onSubmit({ rating: null, note: null })
            setOpen(null)
          }}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </div>
  )
}

export type MessageFeedbackProps = {
  /** Opaque host ref to the rated answer (e.g. the message id). */
  subjectId: string
  /** Current rating + note, hydrated by the host (null = no feedback yet). */
  rating?: WfFeedbackRating | null
  note?: string | null
  // Denormalized snapshots persisted with the rating (power the triage view).
  correlationId?: string | null
  runId?: string | null
  body?: string | null
  subjectTitle?: string | null
  subjectUrl?: string | null
  correlationLabel?: string | null
  raterLabel?: string | null
  /** Keep inactive thumbs visible without a `group` hover (page-level control). */
  alwaysVisible?: boolean
  className?: string
}

export function MessageFeedback({
  subjectId,
  rating = null,
  note = null,
  correlationId,
  runId,
  body,
  subjectTitle,
  subjectUrl,
  correlationLabel,
  raterLabel,
  alwaysVisible,
  className,
}: MessageFeedbackProps) {
  const submit = useSubmitFeedback()
  // Optimistic mirror of the hydrated value, so the UI reacts instantly.
  const [local, setLocal] = useState<MessageFeedbackSubmit>({ rating, note })

  // Re-sync when the host's hydrated value changes (e.g. after a refetch).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- re-sync to the host's refetched value
    setLocal({ rating, note })
  }, [rating, note])

  return (
    <MessageFeedbackView
      className={className}
      alwaysVisible={alwaysVisible}
      rating={local.rating}
      note={local.note}
      pending={submit.isPending}
      onSubmit={(args) => {
        setLocal(args)
        submit.mutate({
          subjectId,
          rating: args.rating,
          note: args.note,
          correlationId,
          runId,
          body,
          subjectTitle,
          subjectUrl,
          correlationLabel,
          raterLabel,
        })
      }}
    />
  )
}

function ThumbButton({
  kind,
  active,
  pending,
  alwaysVisible,
  onClick,
}: {
  kind: WfFeedbackRating
  active: boolean
  pending?: boolean
  alwaysVisible?: boolean
  onClick: () => void
}) {
  const Icon = kind === 'up' ? ThumbsUp : ThumbsDown
  const label = kind === 'up' ? 'Good response' : 'Bad response'
  return (
    <button
      type="button"
      aria-label={active ? `${label} (click to edit)` : label}
      aria-pressed={active}
      onClick={onClick}
      disabled={pending}
      className={cn(
        'inline-flex h-6 w-6 items-center justify-center rounded-md text-neutral-500 transition-opacity hover:bg-neutral-100 hover:text-neutral-900',
        'focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neutral-400',
        active
          ? 'text-neutral-900 opacity-100'
          : alwaysVisible
            ? 'opacity-100'
            : 'opacity-0 group-hover:opacity-100',
        pending && 'opacity-60',
      )}
    >
      <Icon className={cn('h-3.5 w-3.5', active && 'fill-current')} aria-hidden />
    </button>
  )
}

// Gap between the thumbs strip and the note box, and the minimum breathing room
// kept between the box and the viewport edge, both in px.
const NOTE_GAP = 6
const NOTE_MARGIN = 8

// Anchor the note box to the thumbs strip: below it when it fits, otherwise
// above; left-aligned to the strip unless that would run past the right edge,
// in which case the box's top-RIGHT corner anchors to the strip instead. The
// result is clamped inside the viewport either way, so the box is always fully
// on screen no matter where the strip sits.
function placeNote(strip: DOMRect, panel: DOMRect) {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const below = strip.bottom + NOTE_GAP
  const above = strip.top - NOTE_GAP - panel.height
  const top =
    below + panel.height <= vh - NOTE_MARGIN || above < NOTE_MARGIN
      ? Math.max(NOTE_MARGIN, Math.min(below, vh - panel.height - NOTE_MARGIN))
      : above
  const left =
    strip.left + panel.width <= vw - NOTE_MARGIN
      ? strip.left
      : strip.right - panel.width
  return {
    top,
    left: Math.max(NOTE_MARGIN, Math.min(left, vw - panel.width - NOTE_MARGIN)),
  }
}

// The note editor, anchored to the thumbs strip. It is PORTALED to
// `document.body` and positioned with `fixed` coords off the strip's rect
// rather than laid out `absolute` inside it: the strip is often flush-right (a
// page header's actions row), where a left-anchored in-flow box runs straight
// off the screen — and widening the window doesn't help, because the strip
// moves right with it. Same reasoning as `Tooltip` and `MarkdownHint`; the
// portal also escapes any ancestor that clips or paints over an in-flow panel.
//
// A transparent backdrop closes it on an outside click without needing a
// popover primitive.
function NoteBox({
  anchorRef,
  kind,
  initialNote,
  canClear,
  onSave,
  onClear,
  onClose,
}: {
  /** The thumbs strip the box hangs off. */
  anchorRef: RefObject<HTMLDivElement | null>
  kind: WfFeedbackRating
  initialNote: string | null
  canClear: boolean
  onSave: (note: string | null) => void
  onClear: () => void
  onClose: () => void
}) {
  const [value, setValue] = useState(initialNote ?? '')
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const reposition = useCallback(() => {
    const strip = anchorRef.current
    const panel = panelRef.current
    if (!strip || !panel) return
    setPos(placeNote(strip.getBoundingClientRect(), panel.getBoundingClientRect()))
  }, [anchorRef])

  // Measure before paint so the box never flashes at the wrong spot.
  useLayoutEffect(reposition, [reposition])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', reposition)
    // Capture: the strip may sit in a scrolling pane, not just the window.
    window.addEventListener('scroll', reposition, { capture: true })
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
    }
  }, [onClose, reposition])

  const placeholder =
    kind === 'up'
      ? 'What was helpful? (optional)'
      : 'What could be better? (optional)'

  if (typeof document === 'undefined') return null

  return createPortal(
    <>
      <div className="fixed inset-0 z-[999]" onClick={onClose} aria-hidden />
      <div
        ref={panelRef}
        role="dialog"
        aria-label={kind === 'up' ? 'Positive feedback' : 'Negative feedback'}
        style={{
          position: 'fixed',
          top: pos?.top ?? 0,
          left: pos?.left ?? 0,
          // Hidden until measured, so the first paint isn't at 0,0.
          opacity: pos ? 1 : 0,
        }}
        className="z-[1000] flex w-80 max-w-[calc(100vw-1rem)] flex-col gap-2 rounded-md border border-neutral-200 bg-white p-3 shadow-lg"
      >
        <label className="text-xs font-medium text-neutral-900">
          {kind === 'up' ? 'Thanks for the feedback' : 'Tell us more'}
        </label>
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder}
          maxLength={2000}
          rows={3}
          autoFocus
          className="w-full resize-none rounded-md border border-neutral-300 bg-transparent px-2 py-1.5 text-sm outline-none focus:border-neutral-500"
        />
        <div className="flex items-center justify-between">
          {canClear ? (
            <button
              type="button"
              onClick={onClear}
              className="text-xs text-neutral-500 underline-offset-4 hover:text-neutral-900 hover:underline"
            >
              Remove feedback
            </button>
          ) : (
            <span />
          )}
          <button
            type="button"
            onClick={() => onSave(value.trim() ? value.trim() : null)}
            className="inline-flex h-8 items-center justify-center rounded-md bg-neutral-900 px-3 text-xs font-medium text-white hover:bg-neutral-800"
          >
            Save
          </button>
        </div>
      </div>
    </>,
    document.body,
  )
}
