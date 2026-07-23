import {
  Check,
  ExternalLink,
  Loader2,
  ThumbsDown,
  ThumbsUp,
  Workflow,
} from 'lucide-react'
import { useEffect, useState } from 'react'

import type { WfFeedbackRow } from '../server/protocol'

import { useWfComponents } from './context'
import { formatTimestamp } from './cost'
import { ChatDock } from './editor/bottom-dock'
import {
  useFeedbackForSubjects,
  useSetFeedbackInternalNote,
} from './hooks-feedback'
import { useWfNav } from './nav'
import { WfShell } from './shell'
import { sectionCrumb } from './wf-crumbs'

// One rated item, opened as its own tab from the Feedback triage list. Shows the
// customer's rating/note, an excerpt of the answer they reacted to, and a link
// to the producing run — then pins the AI copilot dock at the bottom, scoped to
// this item's `runId` so staff can ask how to improve the output.
export function FeedbackDetail({ subjectId }: { subjectId: string }) {
  const query = useFeedbackForSubjects([subjectId])
  const row = query.data?.[0]

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        <WfShell
          crumbs={[
            { home: true },
            sectionCrumb('feedback'),
            { label: 'Item' },
          ]}
          scroll
        >
          {query.isLoading ? (
            <p className="p-6 text-sm text-neutral-500">Loading feedback…</p>
          ) : !row ? (
            <p className="p-6 text-sm text-neutral-500">
              This feedback item no longer exists — it may have been cleared.
            </p>
          ) : (
            <FeedbackDetailBody row={row} />
          )}
        </WfShell>
      </div>
      <ChatDock subject="feedback" subjectId={subjectId} runId={row?.runId ?? undefined} />
    </div>
  )
}

function FeedbackDetailBody({ row }: { row: WfFeedbackRow }) {
  const { Badge } = useWfComponents()
  const { navigate } = useWfNav()
  const acknowledged = !!row.acknowledgedAt

  return (
    <div className="mx-auto max-w-3xl space-y-5 p-6">
      <div className="flex items-start gap-3">
        <div className="pt-1">
          {row.rating === 'up' ? (
            <ThumbsUp className="h-5 w-5 fill-current text-emerald-600" />
          ) : (
            <ThumbsDown className="h-5 w-5 fill-current text-rose-600" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <span className="font-medium text-neutral-900">
              {row.raterLabel || 'Unknown user'}
            </span>
            {row.correlationLabel ? (
              <>
                <span className="text-neutral-400">@</span>
                <span className="font-medium text-neutral-600">
                  {row.correlationLabel}
                </span>
              </>
            ) : null}
            <span className="text-neutral-300">·</span>
            <span className="text-xs text-neutral-500">
              {formatTimestamp(row.createdAt)}
            </span>
            <Badge className="gap-1.5 whitespace-nowrap font-normal">
              {acknowledged ? null : (
                <span className="size-1.5 rounded-full bg-amber-500" aria-hidden />
              )}
              {acknowledged ? 'Acknowledged' : 'Unacknowledged'}
            </Badge>
          </div>
        </div>
      </div>

      <section className="space-y-1">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
          Their comment
        </h3>
        {row.note ? (
          <p className="text-sm text-neutral-900">“{row.note}”</p>
        ) : (
          <p className="text-sm italic text-neutral-500">No comment left.</p>
        )}
      </section>

      <TeamNote subjectId={row.subjectId} initialNote={row.internalNote} />

      {row.body ? (
        <section className="space-y-1">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
            The answer they rated
          </h3>
          <p className="whitespace-pre-wrap rounded-md border border-neutral-200 bg-neutral-50 p-3 text-sm text-neutral-700">
            {row.body}
          </p>
          {row.subjectUrl ? (
            <a
              href={row.subjectUrl}
              className="inline-flex items-center gap-1 text-xs text-neutral-500 hover:text-neutral-900 hover:underline"
            >
              <ExternalLink className="h-3 w-3" />
              Open the original conversation
            </a>
          ) : null}
        </section>
      ) : null}

      <section className="space-y-1">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
          Producing run
        </h3>
        {row.runId ? (
          <button
            type="button"
            onClick={() => navigate(`runs/${row.runId}`)}
            className="inline-flex items-center gap-1.5 rounded-md border border-neutral-200 bg-white px-2.5 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50"
          >
            <Workflow className="h-3.5 w-3.5 text-neutral-500" />
            Open run trace
          </button>
        ) : (
          <p className="text-sm italic text-neutral-500">
            No run is linked to this item.
          </p>
        )}
      </section>

      <p className="border-t border-neutral-100 pt-4 text-xs text-neutral-500">
        Open the <span className="font-medium text-violet-600">Chat</span> dock
        below to ask the assistant why this answer fell short and how to improve
        the agents, tools, or prompts behind it.
      </p>
    </div>
  )
}

// Staff-only note kept alongside the customer's comment — a running resolution
// log ("fixed by …") the rater never sees. Seeded from the persisted value and
// re-synced when it changes (e.g. after another editor saves). Save is disabled
// until the text differs from what's stored.
function TeamNote({
  subjectId,
  initialNote,
}: {
  subjectId: string
  initialNote: string | null
}) {
  const { Textarea, Button } = useWfComponents()
  const save = useSetFeedbackInternalNote()
  const [value, setValue] = useState(initialNote ?? '')

  // Re-sync to the persisted value when it changes and there's no pending edit.
  useEffect(() => {
    setValue(initialNote ?? '')
  }, [initialNote])

  const trimmed = value.trim()
  const stored = initialNote ?? ''
  const dirty = trimmed !== stored
  const commit = () =>
    save.mutate({ subjectId, note: trimmed ? trimmed : null })

  return (
    <section className="space-y-1.5 rounded-md border border-amber-200 bg-amber-50/50 p-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-amber-700">
          Team note
        </h3>
        <span className="text-[11px] text-amber-700/70">
          Internal — not shown to the client
        </span>
      </div>
      <Textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="How was this handled? e.g. fixed the prompt, filed a bug, expected behavior…"
        rows={3}
        maxLength={4000}
        className="bg-white"
      />
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          onClick={commit}
          disabled={!dirty || save.isPending}
        >
          {save.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Check className="h-3.5 w-3.5" />
          )}
          Save note
        </Button>
        {!dirty && stored ? (
          <span className="text-xs text-neutral-500">Saved</span>
        ) : null}
      </div>
    </section>
  )
}
