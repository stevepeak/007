import { AlertTriangle, Check, ChevronRight } from 'lucide-react'

import type { CheckTree, EvalTools } from '../../server/protocol'
import { unavailableCheckTypes } from '../../server/protocol'
import { cn } from '../cn'
import { useEvalRuns } from '../hooks'
import { useOpenAsset } from '../nav'
import { describeCheck, isUnnamed } from './check-naming'
import { EvalRunsTable } from './shared'

// A sample's Checks, rendered as a checklist rather than a list of records.
//
// That framing is the point: a column of "✓ Has correct title / ✓ Never calls
// send_email" makes an off-convention name ("Alimony test") look wrong next to
// its neighbors, which is a far stronger pull toward the assertion voice than
// any hint text. Checks still leaning on a derived stand-in render muted and
// italic, so "unnamed" reads as unfinished at a glance.
export function ChecksList({
  setId,
  sampleId,
  checks,
  tools,
  onChange,
}: {
  setId: string
  sampleId: string
  checks: CheckTree
  /** The Sample's tool setting — decides which check types can grade at all. */
  tools: EvalTools
  onChange: (next: CheckTree) => void
}) {
  const open = useOpenAsset()
  // A check the tool setting has made ungradeable is still SHOWN — deleting an
  // author's assertion because they flipped a mode would be worse — but it is
  // marked, because it will fail on an absence rather than on the agent.
  const ungradeable = new Set<string>(unavailableCheckTypes(tools))

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
          <span>of these checks pass.</span>
        </div>
      ) : null}

      {checks.checks.length === 0 ? (
        // Amber, not neutral: a sample with no checks is not a neutral
        // in-progress state, it's a sample that will REPORT as an error. Saying
        // so here is the difference between a user discovering it now and
        // discovering it in a run report. Never blocks the save — same policy as
        // the mock-mismatch warnings.
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2">
          <p className="text-xs font-medium text-amber-700">
            This sample has no checks.
          </p>
          <p className="mt-1 text-[11px] text-amber-600">
            It will report as an <strong>error</strong>, not a pass — a run needs
            at least one check to verify. Add one to assert an outcome.
          </p>
        </div>
      ) : (
        <div className="divide-y divide-neutral-100 overflow-hidden rounded-lg border border-neutral-200">
          {checks.checks.map((c, i) => {
            const unnamed = isUnnamed(c)
            const dead = ungradeable.has(c.type)
            return (
              <button
                key={i}
                type="button"
                onClick={(e) =>
                  open(`evals/${setId}/samples/${sampleId}/checks/${i}`, {
                    newTab: e.metaKey || e.ctrlKey,
                  })
                }
                className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-neutral-50"
              >
                <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border border-neutral-300 text-neutral-400">
                  <Check className="size-3" strokeWidth={3} />
                </span>
                <div className="min-w-0 flex-1">
                  <div
                    className={cn(
                      'truncate text-sm',
                      unnamed
                        ? 'italic text-neutral-500'
                        : 'font-medium text-neutral-800',
                    )}
                    title={unnamed ? 'This check has no name yet' : undefined}
                  >
                    {describeCheck(c)}
                  </div>
                  {c.description ? (
                    <div className="mt-0.5 truncate text-xs text-neutral-500">
                      {c.description}
                    </div>
                  ) : null}
                </div>
                {dead ? (
                  <span
                    title="The agent runs with no tools, so no tool step will exist in the trace — this check grades an absence."
                    className="mt-0.5 flex shrink-0 items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-700"
                  >
                    <AlertTriangle className="size-3" />
                    Can&apos;t grade
                  </span>
                ) : null}
                <code className="mt-0.5 shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-[11px] text-neutral-500">
                  {c.type}
                </code>
                <ChevronRight className="mt-0.5 size-4 shrink-0 text-neutral-300" />
              </button>
            )
          })}
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
