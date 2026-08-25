import { Loader2, NotebookPen } from 'lucide-react'
import { useState } from 'react'

import { cn } from './cn'
import { useWfComponents } from './context'
import { MarkdownField } from './editor/markdown-hint'
import { NoteMarkdown } from './editor/note-markdown'
import { useSetRunNote } from './hooks'

// The run's shared note — a Markdown scratchpad on one execution, usually the
// answer to "why did this fail?". Public and unattributed by design: anyone
// looking at the run can write it and anyone can correct it.
//
// The draft is seeded ONLY on entering edit mode, never from a render of the
// server value. The run viewer polls `getRun` every 1.5s while a run is live,
// and a draft mirrored off `note` would be overwritten mid-sentence on every
// tick — the one hazard this surface has.

/** Matches `RUN_NOTE_MAX_LENGTH` server-side; the server truncates past it. */
const NOTE_MAX_LENGTH = 8000

export function RunNote({
  runId,
  note,
  className,
}: {
  runId: string
  /** The persisted note, or null when nobody has written one. */
  note: string | null
  className?: string
}) {
  const { Button, Textarea } = useWfComponents()
  const save = useSetRunNote()
  // `null` = not editing. A string (including '') = editing that draft.
  const [draft, setDraft] = useState<string | null>(null)

  const commit = (next: string) => {
    // The server trims and maps blank to null; mirror it so the local exit and
    // the eventual refetch agree on whether a note still exists.
    const trimmed = next.trim()
    setDraft(null)
    if ((trimmed || null) === note) return
    save.mutate({ runId, note: trimmed || null })
  }

  if (draft !== null) {
    return (
      <div
        className={cn(
          'border-b border-neutral-200 bg-amber-50/40 px-4 py-2.5',
          className,
        )}
      >
        <MarkdownField variables={false}>
          <Textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setDraft(null)
              // Cmd/Ctrl + Enter saves — Enter itself has to stay a newline in
              // a box that takes Markdown lists and paragraphs.
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) commit(draft)
            }}
            placeholder="Why did this run go the way it did? Markdown welcome — anyone can edit this."
            rows={4}
            maxLength={NOTE_MAX_LENGTH}
            className="bg-white"
          />
        </MarkdownField>
        <div className="mt-1.5 flex items-center gap-2">
          <Button size="sm" onClick={() => commit(draft)}>
            Save note
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
            Cancel
          </Button>
          <span className="text-xs text-neutral-400">
            ⌘↵ to save · Esc to cancel
          </span>
        </div>
      </div>
    )
  }

  if (note == null) {
    return (
      <div className={cn('border-b border-neutral-200 px-4 py-1.5', className)}>
        <button
          type="button"
          onClick={() => setDraft('')}
          className="inline-flex items-center gap-1.5 text-xs text-neutral-400 hover:text-neutral-700"
        >
          <NotebookPen className="size-3.5" />
          Add a note
          {save.isPending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : null}
        </button>
      </div>
    )
  }

  return (
    <div
      className={cn(
        'group flex items-start gap-2 border-b border-amber-200 bg-amber-50/60 px-4 py-2 text-sm text-neutral-800',
        className,
      )}
    >
      <NotebookPen className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
      {/* Max height rather than a clamp: a long note stays fully readable by
          scrolling, without pushing the graph off the page. */}
      <div className="max-h-40 min-w-0 flex-1 overflow-y-auto">
        <NoteMarkdown text={note} />
      </div>
      <button
        type="button"
        onClick={() => setDraft(note)}
        className="shrink-0 text-xs text-amber-700/70 opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100 hover:text-amber-800 hover:underline"
      >
        {save.isPending ? 'Saving…' : 'Edit'}
      </button>
    </div>
  )
}
