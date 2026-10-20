import { Loader2, Sparkles } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'

import type { WfChangeSummary } from '../../server/protocol'
import { useWfComponents } from '../context'
import { Modal } from '../modal'

type SummaryState =
  | { status: 'none' }
  | { status: 'pending' }
  | { status: 'error'; message: string }
  | { status: 'ready'; summary: WfChangeSummary }

// The publish flow shared by workflows and agents — the human writes their own
// note; an AI summary of the changes is generated alongside (shown when ready)
// but NEVER blocks publishing. If the user publishes before it lands, the
// server fills it in afterward.
export function PublishVersionDialog({
  summarize,
  icon,
  intro,
  warning,
  publishing,
  error,
  onCancel,
  onConfirm,
}: {
  /** Asks for the AI summary, once, when the dialog opens. Null skips it. */
  summarize: (() => Promise<WfChangeSummary>) | null
  /** Shown beside the title. */
  icon?: ReactNode
  intro: ReactNode
  /** Shown between the summary panel and the note, when present. */
  warning?: ReactNode
  publishing: boolean
  error: string | null
  onCancel: () => void
  onConfirm: (input: {
    changeNote: string
    aiSummary: WfChangeSummary | null
  }) => void
}) {
  const { Button, Textarea } = useWfComponents()
  const [note, setNote] = useState('')
  const [summary, setSummary] = useState<SummaryState>(
    summarize ? { status: 'pending' } : { status: 'none' },
  )

  const ranRef = useRef(false)
  useEffect(() => {
    if (ranRef.current || !summarize) return
    ranRef.current = true
    summarize().then(
      (s) => setSummary({ status: 'ready', summary: s }),
      (e: unknown) => {
        const message = e instanceof Error ? e.message : String(e)
        setSummary({ status: 'error', message })
      },
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const aiSummary = summary.status === 'ready' ? summary.summary : null

  return (
    <Modal
      open
      onClose={onCancel}
      panelClassName="w-full max-w-md rounded-lg border border-neutral-200 bg-white p-5 shadow-xl"
    >
      <div className="mb-1 flex items-center gap-2">
        {icon}
        <h2 className="text-base font-semibold text-neutral-900">
          Publish new version
        </h2>
      </div>
      <p className="mb-3 text-sm text-neutral-500">{intro}</p>

      {/* AI summary — fixed height so the dialog never resizes; content
          scrolls/crops when it's long. */}
      <div className="mb-3">
        <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-neutral-500">
          <Sparkles className="size-3 text-indigo-500" />
          AI summary of changes
        </div>
        <div className="h-24 overflow-y-auto rounded-md border border-neutral-200 bg-neutral-50 p-2 text-sm">
          {summary.status === 'pending' ? (
            <div className="flex items-center gap-1.5 text-neutral-400">
              <Loader2 className="size-3.5 animate-spin" />
              Generating summary of changes…
            </div>
          ) : summary.status === 'error' ? (
            <span className="text-amber-600">
              Couldn't generate a summary ({summary.message}). It'll be
              generated after you publish.
            </span>
          ) : summary.status === 'ready' ? (
            <div className="space-y-1">
              <p className="font-medium text-neutral-800">
                {summary.summary.short}
              </p>
              {summary.summary.long ? (
                <p className="whitespace-pre-wrap text-neutral-500">
                  {summary.summary.long}
                </p>
              ) : null}
            </div>
          ) : (
            <span className="text-neutral-400">No summary.</span>
          )}
        </div>
      </div>

      {warning}

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
