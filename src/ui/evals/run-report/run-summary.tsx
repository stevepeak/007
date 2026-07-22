import { ChevronRight, Goal as GoalIcon, Workflow } from 'lucide-react'
import { useMemo } from 'react'

import type {
  WfEvalResultDTO,
  WfEvalResultRunStats,
  WfEvalRunSummary,
} from '../../../server/protocol'
import { agentColor, agentIcon } from '../../agent-appearance'
import { cn } from '../../cn'
import { formatDurationMs, formatUsd } from '../../cost'
import { useAgents, useWorkflow } from '../../hooks'
import { WfLink } from '../../nav'
import { formatTimestamp, PassRate, Score } from '../shared'

import { VerdictBadge } from './atoms'
import { mean } from './model'

// The run summary card: the Agent › Goal › Run identity line + status, over the
// run's rolled-up figures (pass rate, mean score, counts, agent-call averages).
export function RunHeader({
  run,
  results,
}: {
  run: WfEvalRunSummary
  results: WfEvalResultDTO[]
}) {
  const running = run.status === 'queued' || run.status === 'running'
  const agent = agentAverages(results)
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <TargetBreadcrumb results={results} runId={run.id} />
        <VerdictBadge status={run.status} />
        {running && (
          <span className="text-xs text-neutral-400">updating live…</span>
        )}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
        <Metric label="Pass rate">
          <PassRate passed={run.passed} total={run.total} />
        </Metric>
        <Metric label="Mean score">
          <Score value={run.score} />
        </Metric>
        <Metric label="Tests">
          <span className="tabular-nums text-neutral-700">{run.total}</span>
        </Metric>
        {agent.count > 0 && (
          <>
            <Metric label="Avg speed">
              <span className="tabular-nums text-neutral-700">
                {formatDurationMs(agent.avgDurationMs)}
              </span>
            </Metric>
            <Metric label="Avg cost">
              <span className="tabular-nums text-neutral-700">
                {formatUsd(agent.avgCostUsd)}
              </span>
            </Metric>
            <Metric label="Total cost">
              <span className="tabular-nums text-neutral-700">
                {formatUsd(agent.totalCostUsd)}
              </span>
            </Metric>
          </>
        )}
        <Metric label="Started">
          <span className="text-neutral-600">
            {run.startedAt ? formatTimestamp(run.startedAt) : '—'}
          </span>
        </Metric>
      </div>
    </div>
  )
}

// Roll the per-sample agent-call stats up into run-level averages. Each figure
// averages only over the samples that reported it. Everything here is
// agent-call-scoped upstream in `loadRunStats`, so judge/test grading never
// enters these numbers.
function agentAverages(results: WfEvalResultDTO[]) {
  const stats = results
    .map((r) => r.runStats)
    .filter((s): s is WfEvalResultRunStats => s != null)
  const nums = (pick: (s: WfEvalResultRunStats) => number | null) =>
    stats.map(pick).filter((v): v is number => v != null)
  const costs = nums((s) => s.costUsd)
  return {
    count: stats.length,
    avgDurationMs: mean(nums((s) => s.durationMs)),
    avgCostUsd: mean(costs),
    totalCostUsd: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
  }
}

function Metric({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[11px] uppercase tracking-wide text-neutral-400">
        {label}
      </span>
      {children}
    </div>
  )
}

// The page identity line: [Agent] › [Goal] › Run <id>. Both target chips are
// resolved from the results' frozen snapshots (so they hold even after the live
// Goal is edited). A run usually tests one Goal; when it spans several we show
// the count rather than an arbitrary one.
function TargetBreadcrumb({
  results,
  runId,
}: {
  results: WfEvalResultDTO[]
  runId: string
}) {
  const goals = useMemo(() => {
    const seen = new Map<
      string,
      { setId: string; setName: string; targetKind: string; targetId: string }
    >()
    for (const r of results) {
      const t = r.snapshot?.target
      if (t?.setId && !seen.has(t.setId)) {
        seen.set(t.setId, {
          setId: t.setId,
          setName: t.setName,
          targetKind: t.targetKind,
          targetId: t.targetId,
        })
      }
    }
    return [...seen.values()]
  }, [results])

  const single = goals.length === 1 ? goals[0] : null
  const sep = <ChevronRight className="size-4 shrink-0 text-neutral-300" />
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {single ? (
        <>
          {single.targetKind === 'agent' ? (
            <AgentChip agentId={single.targetId} />
          ) : (
            <WorkflowChip workflowId={single.targetId} />
          )}
          {sep}
          <WfLink
            to={`evals/${single.setId}`}
            newTab
            className="group inline-flex items-center gap-1.5"
            title="Open this Goal"
          >
            <GoalIcon className="size-4 shrink-0 text-rose-500" />
            <span className="text-sm font-medium text-neutral-800 group-hover:underline">
              {single.setName}
            </span>
          </WfLink>
          {sep}
        </>
      ) : goals.length > 1 ? (
        <>
          <span className="inline-flex items-center gap-1.5 text-sm font-medium text-neutral-700">
            <GoalIcon className="size-4 shrink-0 text-rose-500" />
            {goals.length} goals
          </span>
          {sep}
        </>
      ) : null}
      <span className="font-mono text-sm text-neutral-500" title={`Run ${runId}`}>
        Run {runId.slice(0, 8)}
      </span>
    </div>
  )
}

// Compact agent chip (colored icon + name) linking to the agent editor.
function AgentChip({ agentId }: { agentId: string }) {
  const agents = useAgents()
  const agent = agents.data?.find((a) => a.id === agentId)
  const Icon = agentIcon(agent?.icon)
  const color = agentColor(agent?.color)
  return (
    <WfLink
      to={`agents/${agentId}/edit`}
      newTab
      className="group inline-flex items-center gap-1.5"
      title="Open this agent"
    >
      <span
        className={cn(
          'inline-flex size-5 shrink-0 items-center justify-center rounded',
          color.chip,
        )}
      >
        <Icon className="size-3" />
      </span>
      <span className="text-sm font-medium text-neutral-800 group-hover:underline">
        {agent?.name ?? (agents.isLoading ? 'Loading…' : 'Agent')}
      </span>
    </WfLink>
  )
}

// Compact workflow chip — same shape as the agent chip, workflow glyph.
function WorkflowChip({ workflowId }: { workflowId: string }) {
  const wf = useWorkflow(workflowId)
  const name = wf.data?.workflow.name ?? (wf.isLoading ? 'Loading…' : 'Workflow')
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="inline-flex size-5 shrink-0 items-center justify-center rounded bg-sky-100 text-sky-600">
        <Workflow className="size-3" />
      </span>
      <span className="text-sm font-medium text-neutral-800">{name}</span>
    </span>
  )
}
