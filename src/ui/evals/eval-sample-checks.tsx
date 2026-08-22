import {
  AlertTriangle,
  Binary,
  ChevronDown,
  Gauge,
  Trash2,
} from 'lucide-react'

import type { JsonSchema } from '../../engine'
import type {
  CheckTree,
  EvalCheck,
  EvalTools,
  WfEvalTargetKind,
} from '../../server/protocol'
import { unavailableCheckTypes } from '../../server/protocol'
import { ArchiveButton } from '../archive-button'
import { cn } from '../cn'
import { useEvalRuns } from '../hooks'
import { useOpenAsset } from '../nav'
import { Tooltip } from '../tooltip'
import { describeCheck } from './check-naming'
import { CheckConfigBody } from './eval-check-config'
import {
  defaultCheck,
  familyOf,
  type CheckFamily,
} from './eval-check-config-shared'
import { EvalRunsTable } from './shared'

// A sample's Checks, rendered as a checklist of collapsible rows rather than as
// links out to a page each.
//
// A Check is four fields at most, so a whole route, tab and shell for one was
// more chrome than object. Collapsed, a row is the two things you scan for —
// which KIND of judgement it is (the family toggle) and WHAT it asserts (a
// summary derived from the config, never a title someone typed). Expanded, it's
// the config itself, in place. Authoring three checks no longer means leaving
// the sample three times.
//
// One row is open at a time: a column of expanded judge rubrics stops being a
// checklist, which is the thing this view is for.

export function ChecksList({
  checks,
  tools,
  targetKind,
  hasTools,
  outputSchema,
  allowToolIds,
  openIndex,
  onOpenChange,
  onChange,
}: {
  checks: CheckTree
  /** The Sample's tool setting — decides which check types can grade at all. */
  tools: EvalTools
  /** The goal's target kind — hides the `node_*` types for an agent. */
  targetKind?: WfEvalTargetKind
  /** Whether the target has any tools — hides the `tool_*` types when it doesn't. */
  hasTools?: boolean | null
  /** The target agent's output contract, for the output-path pickers. */
  outputSchema?: JsonSchema | null
  /** Scope the tool pickers to the target agent's wired tools (undefined = all). */
  allowToolIds?: string[]
  /** Which check is expanded (accordion — at most one). */
  openIndex: number | null
  onOpenChange: (index: number | null) => void
  onChange: (next: CheckTree) => void
}) {
  // A check the tool setting has made ungradeable is still SHOWN — deleting an
  // author's assertion because they flipped a mode would be worse — but it is
  // marked, because it will fail on an absence rather than on the agent.
  const ungradeable = new Set<string>(unavailableCheckTypes(tools))

  const replace = (index: number, next: EvalCheck) => {
    const list = [...checks.checks]
    list[index] = next
    onChange({ ...checks, checks: list })
  }

  const remove = (index: number) => {
    onChange({
      ...checks,
      checks: checks.checks.filter((_, i) => i !== index),
    })
    // Indexes below the hole shift up, so anything but "close" would silently
    // reopen a different check than the one that was open.
    onOpenChange(null)
  }

  // Switching family can't preserve anything — a rubric isn't a tool id — so it
  // starts the other family from its default rather than pretending to migrate.
  const setFamily = (index: number, family: CheckFamily) => {
    const current = checks.checks[index]
    if (!current || familyOf(current) === family) return
    replace(index, defaultCheck(family === 'scored' ? 'llm_judge' : 'tool_called'))
  }

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
            const open = openIndex === i
            const dead = ungradeable.has(c.type)
            return (
              <div key={i} className={cn(open && 'bg-neutral-50/60')}>
                {/* The row's vertical padding lives on the expander button, not
                    the row, so the full height of the row is clickable. */}
                <div className="flex items-center gap-3 px-3">
                  <FamilyToggle
                    value={familyOf(c)}
                    onChange={(f) => setFamily(i, f)}
                  />
                  <button
                    type="button"
                    onClick={() => onOpenChange(open ? null : i)}
                    aria-expanded={open}
                    className="flex min-w-0 flex-1 items-center gap-2 py-3 text-left"
                  >
                    <span className="truncate text-sm font-medium text-neutral-800">
                      {describeCheck(c)}
                    </span>
                  </button>
                  {dead ? (
                    <span
                      title="The agent runs with no tools, so no tool step will exist in the trace — this check grades an absence."
                      className="flex shrink-0 items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-700"
                    >
                      <AlertTriangle className="size-3" />
                      Can&apos;t grade
                    </span>
                  ) : null}
                  <ArchiveButton
                    icon={Trash2}
                    title="Delete check"
                    confirmLabel="Hold to delete"
                    className="size-7 shrink-0"
                    description={
                      <>
                        Delete <strong>{describeCheck(c)}</strong>? It’ll be
                        removed from this sample&apos;s checks.
                      </>
                    }
                    onConfirm={() => remove(i)}
                  />
                  <button
                    type="button"
                    aria-label={open ? 'Collapse check' : 'Expand check'}
                    onClick={() => onOpenChange(open ? null : i)}
                    className="shrink-0 text-neutral-300 transition hover:text-neutral-500"
                  >
                    <ChevronDown
                      className={cn('size-4 transition', open && 'rotate-180')}
                    />
                  </button>
                </div>
                {open ? (
                  <div className="border-t border-neutral-100 bg-white px-4 py-4">
                    <CheckConfigBody
                      check={c}
                      persist={(next) => replace(i, next)}
                      targetKind={targetKind}
                      hasTools={hasTools}
                      outputSchema={outputSchema}
                      allowToolIds={allowToolIds}
                    />
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// The family switch, as the first thing in every row: two small icon buttons,
// one lit. It replaces what used to be a pair of full-width tiles on a separate
// page — at this size the choice reads as a property of the check rather than a
// step you have to complete, which is what it is.
const FAMILIES: {
  value: CheckFamily
  icon: typeof Binary
  label: string
  hint: string
  on: string
}[] = [
  {
    value: 'binary',
    icon: Binary,
    label: 'Binary',
    hint: 'Binary — a deterministic pass/fail read off the run trace.',
    on: 'bg-sky-100 text-sky-700',
  },
  {
    value: 'scored',
    icon: Gauge,
    label: 'Scored',
    hint: 'Scored — an LLM judge decides whether the output holds up.',
    on: 'bg-amber-100 text-amber-700',
  },
]

function FamilyToggle({
  value,
  onChange,
}: {
  value: CheckFamily
  onChange: (family: CheckFamily) => void
}) {
  return (
    <div className="flex shrink-0 items-center gap-0.5 rounded-md border border-neutral-200 bg-white p-0.5">
      {FAMILIES.map((f) => {
        const Icon = f.icon
        const on = f.value === value
        return (
          <Tooltip key={f.value} content={f.hint} side="bottom">
            <button
              type="button"
              aria-label={f.label}
              aria-pressed={on}
              onClick={() => onChange(f.value)}
              className={cn(
                'flex size-6 items-center justify-center rounded transition',
                on
                  ? f.on
                  : 'text-neutral-300 hover:bg-neutral-100 hover:text-neutral-500',
              )}
            >
              <Icon className="size-3.5" />
            </button>
          </Tooltip>
        )
      })}
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
