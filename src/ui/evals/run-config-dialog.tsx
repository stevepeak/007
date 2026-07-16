import { Play, ShieldCheck, X } from 'lucide-react'
import { useEffect } from 'react'

import { useWfComponents } from '../context'
import { useRunEval } from '../hooks'
import { useWfNav } from '../nav'

// The "Run" confirm, shared by the catalog / Goal / Sample / Test Run buttons.
// A run always executes in SIMULATION (write tools no-op, read tools return the
// row's fixtures) and is marked `is_eval` so it stays out of the Runs explorer.
// Confirming creates the umbrella eval run over `setIds`, executes + grades each
// sample (client-driven, via useRunEval), and navigates to the live report.
//
// The model-comparison matrix (best-of-N across models) is a follow-on; v1 runs
// each sample once on the target's own configured model.

export type RunConfigDialogProps = {
  open: boolean
  onClose: () => void
  /** What this run targets, for the subtitle copy. */
  scope: 'goal' | 'sample' | 'test'
  /** Display name of the thing being run (shown in the subtitle). */
  targetName: string
  /** The eval set(s) to run. Empty = nothing to launch (button disabled). */
  setIds: string[]
}

export function RunConfigDialog({
  open,
  onClose,
  scope,
  targetName,
  setIds,
}: RunConfigDialogProps) {
  const { Button } = useWfComponents()
  const { navigate } = useWfNav()
  const runEval = useRunEval()

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const canRun = setIds.length > 0 && !runEval.isPending

  const launch = async () => {
    if (!canRun) return
    const { evalRunId } = await runEval.mutateAsync({ setIds })
    onClose()
    navigate(`evals/runs/${evalRunId}`)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg border border-neutral-200 bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-neutral-200 px-5 py-3">
          <div>
            <h2 className="text-sm font-semibold text-neutral-900">Run tests</h2>
            <p className="mt-0.5 text-xs text-neutral-500">
              Run this {scope} in simulation ·{' '}
              <span className="font-medium text-neutral-700">{targetName}</span>
            </p>
          </div>
          <button
            aria-label="Close"
            onClick={onClose}
            className="text-neutral-400 transition hover:text-neutral-700"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="space-y-3 px-5 py-4">
          <div className="flex items-start gap-2 rounded-lg bg-neutral-50 px-3 py-2.5 text-sm text-neutral-600">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" />
            <p>
              Every sample runs with <strong>simulation on</strong> — write tools
              (e.g. send email) no-op and read tools return the sample&apos;s
              fixtures, so no real data is touched. The run is graded against each
              sample&apos;s tests.
            </p>
          </div>
          {setIds.length === 0 ? (
            <p className="text-xs text-amber-600">
              Nothing to run yet — add a sample first.
            </p>
          ) : null}
          {runEval.isError ? (
            <p className="text-xs text-red-600">
              Couldn&apos;t launch the run. Check that eval runs are configured
              for this host, then try again.
            </p>
          ) : null}
        </div>

        <div className="flex justify-end gap-2 border-t border-neutral-200 px-5 py-3">
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={!canRun} onClick={() => void launch()}>
            <Play className="size-4" />
            {runEval.isPending ? 'Launching…' : 'Run in simulation'}
          </Button>
        </div>
      </div>
    </div>
  )
}
