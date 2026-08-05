import { Trash2 } from 'lucide-react'
import { useState } from 'react'

import type { WfRunPurgeResult } from '../server/protocol'
import { cn } from './cn'
import { useWfComponents } from './context'
import { useDeleteAllRuns } from './hooks'
import { HoldButton } from './hold-button'
import { Modal } from './modal'

// The runs explorer's nuclear option: wipe every run and everything derived
// from it. Three deliberate gates stand between a stray click and an empty
// history — the button only exists while Cmd + Option are held (see
// `useModifierHold('meta+alt')` in the explorer), clicking it opens a dialog
// spelling out the cascade, and confirming needs a press-and-hold.

function summarize(r: WfRunPurgeResult): string {
  const parts = [
    `${r.runs.toLocaleString()} run${r.runs === 1 ? '' : 's'}`,
    `${r.steps.toLocaleString()} steps`,
    `${r.logs.toLocaleString()} log entries`,
  ]
  if (r.evalResults > 0 || r.evalRuns > 0) {
    parts.push(
      `${r.evalResults.toLocaleString()} eval results`,
      `${r.evalRuns.toLocaleString()} eval runs`,
    )
  }
  if (r.feedbackUnlinked > 0) {
    parts.push(`${r.feedbackUnlinked.toLocaleString()} feedback rows unlinked`)
  }
  return parts.join(' · ')
}

export function DeleteAllRunsButton({ className }: { className?: string }) {
  const { Button } = useWfComponents()
  const [open, setOpen] = useState(false)
  const [result, setResult] = useState<WfRunPurgeResult | null>(null)
  const purge = useDeleteAllRuns()

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setResult(null)
          setOpen(true)
        }}
        className={cn(
          'inline-flex h-9 items-center gap-1.5 rounded-md border border-red-300 px-2.5 text-sm font-medium text-red-600 transition-colors hover:bg-red-50',
          className,
        )}
      >
        <Trash2 className="size-4" />
        Delete all runs
      </button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={
          <span className="flex items-center gap-1.5">
            <Trash2 className="size-4 text-red-500" />
            Delete all runs
          </span>
        }
        panelClassName="w-full max-w-md rounded-lg border border-neutral-200 bg-white shadow-xl"
      >
        <div className="space-y-3 px-5 py-4 text-sm leading-relaxed text-neutral-600">
          <p>
            This permanently deletes <strong>every run</strong> and cascades to
            everything downstream of it:
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li>every run's steps and log feed</li>
            <li>
              eval results and eval runs (they grade a run, so they can't
              outlive one)
            </li>
            <li>
              eval-produced runs too — those are hidden from this table, but
              they're the same rows
            </li>
          </ul>
          <p>
            Workflows, agents, eval sets, and models are <strong>kept</strong>.
            Feedback is kept too, with its link to the deleted run cleared.
          </p>
          <p className="text-red-600">This cannot be undone.</p>
          {purge.error ? (
            <p className="rounded-md border border-red-200 bg-red-50 p-2 text-red-700">
              {(purge.error as Error).message}
            </p>
          ) : null}
          {result ? (
            <p className="rounded-md border border-neutral-200 bg-neutral-50 p-2 font-mono text-xs text-neutral-600">
              Deleted {summarize(result)}
            </p>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-neutral-200 px-5 py-3">
          <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
            {result ? 'Close' : 'Cancel'}
          </Button>
          {result ? null : (
            <HoldButton
              size="md"
              tone="danger"
              title={
                purge.isPending ? 'Deleting…' : 'Hold to delete every run'
              }
              duration={1200}
              onHold={() => {
                if (purge.isPending) return
                purge.mutate(undefined, { onSuccess: setResult })
              }}
            >
              <Trash2 className="size-4" />
              {purge.isPending ? 'Deleting…' : 'Hold to delete all runs'}
            </HoldButton>
          )}
        </div>
      </Modal>
    </>
  )
}
