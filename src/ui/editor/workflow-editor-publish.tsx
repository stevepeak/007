import { Loader2, Sparkles } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import type { WorkflowGraph } from '../../engine'
import { useWfComponents } from '../context'
import { Modal } from '../modal'
import { useSummarizeChanges } from '../hooks'

// Publish flow — the human writes their own note; an AI summary of the changes
// is generated alongside (shown when ready) but NEVER blocks publishing. If the
// user publishes before it lands, the server fills it in afterward.
export function PublishDialog({
  workflowId,
  graph,
  publishing,
  error,
  onCancel,
  onConfirm,
}: {
  workflowId: string
  graph: WorkflowGraph
  publishing: boolean
  error: string | null
  onCancel: () => void
  onConfirm: (input: {
    changeNote: string
    aiSummary: { short: string; long: string } | null
  }) => void
}) {
  const { Button, Textarea } = useWfComponents()
  const summarize = useSummarizeChanges()
  const [note, setNote] = useState('')
  const [aiSummary, setAiSummary] = useState<{
    short: string
    long: string
  } | null>(null)

  // Kick off the AI summary once when the dialog opens. It populates the panel
  // below when it lands; it never gates the Publish button.
  const ranRef = useRef(false)
  useEffect(() => {
    if (ranRef.current) return
    ranRef.current = true
    summarize.mutate({ workflowId, graph }, { onSuccess: (r) => setAiSummary(r) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <Modal
      open
      onClose={onCancel}
      panelClassName="w-full max-w-md rounded-lg border border-neutral-200 bg-white p-5 shadow-xl"
    >
      <div className="mb-1 flex items-center gap-2">
        <Sparkles className="size-4 text-indigo-600" />
        <h2 className="text-base font-semibold text-neutral-900">
          Publish new version
        </h2>
      </div>
      <p className="mb-3 text-sm text-neutral-500">
        Add a note about what changed. We'll also summarize the changes with
        AI — you can publish without waiting for it.
      </p>

      {/* AI summary — fixed height so the dialog never resizes; content
          scrolls/crops when it's long. */}
      <div className="mb-3">
        <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-neutral-500">
          <Sparkles className="size-3 text-indigo-500" />
          AI summary of changes
        </div>
        <div className="h-24 overflow-y-auto rounded-md border border-neutral-200 bg-neutral-50 p-2 text-sm">
          {summarize.isPending ? (
            <div className="flex items-center gap-1.5 text-neutral-400">
              <Loader2 className="size-3.5 animate-spin" />
              Generating summary of changes…
            </div>
          ) : summarize.error ? (
            <span className="text-amber-600">
              Couldn't generate a summary (
              {(summarize.error as Error).message}). It'll be generated after
              you publish.
            </span>
          ) : aiSummary ? (
            <div className="space-y-1">
              <p className="font-medium text-neutral-800">
                {aiSummary.short}
              </p>
              {aiSummary.long ? (
                <p className="whitespace-pre-wrap text-neutral-500">
                  {aiSummary.long}
                </p>
              ) : null}
            </div>
          ) : (
            <span className="text-neutral-400">No summary.</span>
          )}
        </div>
      </div>

      <label className="mb-1 block text-xs font-medium text-neutral-500">
        Your note (optional)
      </label>
      <Textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={3}
        placeholder="Describe the changes in this version…"
        className="w-full"
      />

      {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}

      <div className="mt-4 flex justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={onCancel}
          disabled={publishing}
        >
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={() => onConfirm({ changeNote: note, aiSummary })}
          disabled={publishing}
        >
          {publishing ? 'Publishing…' : 'Publish version'}
        </Button>
      </div>
    </Modal>
  )
}
