import { ThumbsDown, ThumbsUp } from 'lucide-react'
import { useEffect, useState } from 'react'

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

  const handleThumb = (kind: WfFeedbackRating) => {
    // Save the rating immediately so the click registers even if the note box is
    // dismissed without typing. Carry over any existing note when switching.
    if (kind !== rating) onSubmit({ rating: kind, note })
    setOpen((cur) => (cur === kind ? null : kind))
  }

  return (
    <div className={cn('relative flex items-center gap-1', className)}>
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

// Inline note editor anchored below the thumbs. A transparent backdrop closes it
// on an outside click without needing a popover primitive.
function NoteBox({
  kind,
  initialNote,
  canClear,
  onSave,
  onClear,
  onClose,
}: {
  kind: WfFeedbackRating
  initialNote: string | null
  canClear: boolean
  onSave: (note: string | null) => void
  onClear: () => void
  onClose: () => void
}) {
  const [value, setValue] = useState(initialNote ?? '')

  const placeholder =
    kind === 'up'
      ? 'What was helpful? (optional)'
      : 'What could be better? (optional)'

  return (
    <>
      <div className="fixed inset-0 z-10" onClick={onClose} aria-hidden />
      <div className="absolute left-0 top-8 z-20 flex w-80 flex-col gap-2 rounded-md border border-neutral-200 bg-white p-3 shadow-lg">
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
    </>
  )
}
