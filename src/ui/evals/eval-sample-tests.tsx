import { ChevronRight, FlaskConical } from 'lucide-react'

import type { CheckTree } from '../../server/protocol'
import { useEvalRuns } from '../hooks'
import { useOpenAsset } from '../nav'
import { describeCheck, EvalRunsTable } from './shared'

export function TestsList({
  setId,
  sampleId,
  checks,
  onChange,
}: {
  setId: string
  sampleId: string
  checks: CheckTree
  onChange: (next: CheckTree) => void
}) {
  const open = useOpenAsset()

  return (
    <div className="space-y-3">
      {checks.checks.length > 1 ? (
        <div className="flex items-center gap-2 px-1 text-xs text-neutral-500">
          <span>Passes when</span>
          <select
            value={checks.op}
            onChange={(e) =>
              onChange({ ...checks, op: e.target.value as 'and' | 'or' })
            }
            className="h-7 rounded-md border border-neutral-300 bg-transparent px-1.5 text-xs outline-none focus:border-neutral-500"
          >
            <option value="and">all</option>
            <option value="or">any</option>
          </select>
          <span>of these tests pass.</span>
        </div>
      ) : null}

      {checks.checks.length === 0 ? (
        <p className="px-1 py-1 text-xs text-neutral-400">
          No tests yet. Add one to assert an outcome.
        </p>
      ) : (
        <div className="divide-y divide-neutral-100 overflow-hidden rounded-lg border border-neutral-200">
          {checks.checks.map((c, i) => (
            <button
              key={i}
              type="button"
              onClick={(e) =>
                open(`evals/${setId}/samples/${sampleId}/tests/${i}`, {
                  newTab: e.metaKey || e.ctrlKey,
                })
              }
              className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-neutral-50"
            >
              <FlaskConical className="mt-0.5 size-4 shrink-0 text-neutral-400" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-neutral-800">
                  {describeCheck(c)}
                </div>
                {c.description ? (
                  <div className="mt-0.5 truncate text-xs text-neutral-500">
                    {c.description}
                  </div>
                ) : null}
              </div>
              <code className="mt-0.5 shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-[11px] text-neutral-500">
                {c.type}
              </code>
              <ChevronRight className="mt-0.5 size-4 shrink-0 text-neutral-300" />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// Test runs that included this sample. A run spans a whole set (goal) by
// `setIds` — there is no per-sample run table — so these are the goal's runs,
// filtered from the global history. Clicking one opens the full run report.
export function RunsForSample({ setId }: { setId: string }) {
  const open = useOpenAsset()
  const runsQuery = useEvalRuns()
  const runs = (runsQuery.data ?? []).filter((r) => r.setIds.includes(setId))
  return (
    <EvalRunsTable
      runs={runs}
      isLoading={runsQuery.isLoading}
      loadingMessage="Loading test runs…"
      emptyMessage="No test runs yet. Run the goal to see results here."
      onOpenRun={(id, e) =>
        open(`evals/runs/${id}`, { newTab: e.metaKey || e.ctrlKey })
      }
    />
  )
}
