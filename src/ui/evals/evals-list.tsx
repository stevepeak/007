import {
  HelpCircle,
  Play,
  Plus,
  Workflow as WorkflowIcon,
} from 'lucide-react'
import { useMemo, useState } from 'react'

import type {
  WfAgentSummary,
  WfEvalRunSummary,
  WfEvalSetSummary,
  WfWorkflowSummary,
} from '../../server/protocol'
import { agentColor, agentIcon } from '../agent-appearance'
import { cn } from '../cn'
import { useWfComponents } from '../context'
import { EmptyState } from '../empty-state'
import { FilterPill } from '../filters'
import { useAgents, useEvalRuns, useEvalSets, useWorkflows } from '../hooks'
import { useWfNav } from '../nav'
import { QueryState } from '../query-state'

import { EvalsHelpDialog } from './evals-help-dialog'
import { NewGoalDialog } from './new-goal-dialog'
import { RunConfigDialog } from './run-config-dialog'
import {
  EvalRunsTable,
  formatTimestamp,
  RunStatusBadge,
  Tabs,
} from './shared'

// The Evals catalog — the landing page reached from the hub's "Evals" card. Two
// tabs: the authored GOALS (real wf_eval_set rows) and the history of TEST RUNS
// (real wf_eval_run rows). "New goal" creates a set; goal rows drill in; a run
// row opens its report.

type EvalsTab = 'sets' | 'runs'

export type EvalsListProps = {
  className?: string
}

export function EvalsList({ className }: EvalsListProps) {
  const { Button } = useWfComponents()
  const { navigate } = useWfNav()
  const [tab, setTab] = useState<EvalsTab>('sets')
  const [helpOpen, setHelpOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [runOpen, setRunOpen] = useState(false)

  const setsQuery = useEvalSets()
  const runsQuery = useEvalRuns()
  const goals = useMemo(() => setsQuery.data ?? [], [setsQuery.data])
  const runs = runsQuery.data ?? []
  const allSetIds = useMemo(() => goals.map((g) => g.id), [goals])

  return (
    <div className={cn('mx-auto max-w-5xl space-y-5 p-6', className)}>
      <div className="flex items-start justify-between gap-4">
        <p className="max-w-md text-sm text-neutral-500">
          Test agents and workflows against expected outcomes. Runs execute in
          simulation — write tools no-op and read tools return canned fixtures,
          so no real side effects.
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            aria-label="How Evals work"
            onClick={() => setHelpOpen(true)}
            className="inline-flex size-8 items-center justify-center rounded-md text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-700"
          >
            <HelpCircle className="size-4" />
          </button>
          <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
            <Plus className="size-4" />
            New goal
          </Button>
          <Button
            size="sm"
            disabled={allSetIds.length === 0}
            onClick={() => setRunOpen(true)}
          >
            <Play className="size-4" />
            Run tests
          </Button>
        </div>
      </div>

      <EvalsHelpDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
      <NewGoalDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(id) => {
          setCreating(false)
          navigate(`evals/${id}`)
        }}
      />
      <RunConfigDialog
        open={runOpen}
        onClose={() => setRunOpen(false)}
        scope="goal"
        targetName={`all goals (${allSetIds.length})`}
        setIds={allSetIds}
      />

      <Tabs
        active={tab}
        onChange={(k) => setTab(k as EvalsTab)}
        tabs={[
          { key: 'sets', label: 'Goals' },
          { key: 'runs', label: 'Test runs' },
        ]}
      />

      {tab === 'sets' ? (
        <QueryState
          query={{ isLoading: setsQuery.isLoading, error: null, data: goals }}
          loading={<EmptyState message="Loading goals…" />}
        >
          {(goals) => <GoalsTable goals={goals} />}
        </QueryState>
      ) : (
        <QueryState
          query={{ isLoading: runsQuery.isLoading, error: null, data: runs }}
          loading={<EmptyState message="Loading test runs…" />}
        >
          {(runs) => <RunsTable runs={runs} goals={goals} />}
        </QueryState>
      )}
    </div>
  )
}

// ── Goals ────────────────────────────────────────────────────────────────────

function GoalsTable({ goals }: { goals: WfEvalSetSummary[] }) {
  const { navigate } = useWfNav()
  const agentsQuery = useAgents()
  const workflowsQuery = useWorkflows()
  const agentById = useMemo(
    () => new Map((agentsQuery.data ?? []).map((a) => [a.id, a])),
    [agentsQuery.data],
  )
  const [targetFilter, setTargetFilter] = useState('')

  if (goals.length === 0) {
    return <EmptyState message="No goals yet. Create one to get started." />
  }

  const shown = targetFilter
    ? goals.filter((g) => g.targetId === targetFilter)
    : goals

  return (
    <div className="space-y-3">
      <TargetFilter
        value={targetFilter}
        onChange={setTargetFilter}
        agents={agentsQuery.data ?? []}
        workflows={workflowsQuery.data ?? []}
      />
      <div className="overflow-hidden rounded-lg border border-neutral-200">
        <div className="grid grid-cols-[1fr_auto_5rem] items-center gap-4 border-b border-neutral-100 bg-neutral-50 px-4 py-2 text-left text-[11px] font-medium uppercase tracking-wide text-neutral-400">
          <span>Goals</span>
          <span>Agent</span>
          <span>Samples</span>
        </div>
        {shown.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-neutral-400">
            No goals for this selection.
          </div>
        ) : (
          shown.map((g) => (
            <button
              key={g.id}
              type="button"
              onClick={() => navigate(`evals/${g.id}`)}
              className="grid w-full grid-cols-[1fr_auto_5rem] items-center gap-4 border-b border-neutral-100 px-4 py-3 text-left last:border-b-0 hover:bg-neutral-50"
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-neutral-900">
                  {g.name}
                </div>
                {g.description ? (
                  <div className="mt-0.5 truncate text-xs text-neutral-500">
                    {g.description}
                  </div>
                ) : null}
              </div>
              <AgentPill agent={agentById.get(g.targetId)} />
              <div className="text-sm tabular-nums text-neutral-500">
                {g.rowCount}
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  )
}

// A neutral chip holding a workflow's generic glyph — the workflow analog of the
// agent icon (workflows carry no per-item icon).
function WorkflowChip() {
  return (
    <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-indigo-600">
      <WorkflowIcon className="size-3" />
    </span>
  )
}

// Filter the goals list by target: every agent (its icon on its color tint) and
// every workflow (generic glyph).
function TargetFilter({
  value,
  onChange,
  agents,
  workflows,
}: {
  value: string
  onChange: (targetId: string) => void
  agents: WfAgentSummary[]
  workflows: WfWorkflowSummary[]
}) {
  return (
    <FilterPill
      label="Agent"
      value={value}
      onChange={onChange}
      searchPlaceholder="Search agents…"
      options={[
        ...agents.map((a) => ({
          value: a.id,
          label: a.name,
          node: (
            <span className="inline-flex items-center gap-1.5">
              <AgentGlyph agent={a} />
              {a.name}
            </span>
          ),
        })),
        ...workflows.map((w, i) => ({
          value: w.id,
          label: w.name,
          separatorBefore: i === 0 && agents.length > 0,
          node: (
            <span className="inline-flex items-center gap-1.5">
              <WorkflowChip />
              {w.name}
            </span>
          ),
        })),
      ]}
    />
  )
}

// An agent's icon on its color tint — the glyph half of AgentPill, reused in the
// filter dropdown.
function AgentGlyph({ agent }: { agent: WfAgentSummary }) {
  const Icon = agentIcon(agent.icon)
  const color = agentColor(agent.color)
  return (
    <span
      className={cn(
        'inline-flex size-5 shrink-0 items-center justify-center rounded-full',
        color.chip,
      )}
    >
      <Icon className="size-3" />
    </span>
  )
}

// The goal's target agent as a compact pill — its own icon (on its color tint)
// plus its name. Falls back to a neutral "Unknown agent" pill while agents load
// or if the target no longer resolves.
function AgentPill({ agent }: { agent?: WfAgentSummary }) {
  const Icon = agentIcon(agent?.icon)
  const color = agentColor(agent?.color)
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-neutral-200 bg-white py-0.5 pl-0.5 pr-2.5">
      <span
        className={cn(
          'inline-flex size-5 shrink-0 items-center justify-center rounded-full',
          color.chip,
        )}
      >
        <Icon className="size-3" />
      </span>
      <span className="max-w-[10rem] truncate text-xs font-medium text-neutral-700">
        {agent?.name ?? 'Unknown agent'}
      </span>
    </span>
  )
}

// ── Test runs ────────────────────────────────────────────────────────────────

function RunsTable({
  runs,
  goals,
}: {
  runs: WfEvalRunSummary[]
  goals: WfEvalSetSummary[]
}) {
  const { navigate } = useWfNav()
  const agentsQuery = useAgents()
  const workflowsQuery = useWorkflows()
  const [goalFilter, setGoalFilter] = useState('')
  const [targetFilter, setTargetFilter] = useState('')
  const goalById = useMemo(
    () => new Map(goals.map((g) => [g.id, g])),
    [goals],
  )

  // A run's targets are joined through its goals' CURRENT target — a goal
  // re-pointed after the run will report its new agent here.
  const runGoals = (r: WfEvalRunSummary) => { return r.setIds.flatMap((id) => {
      const g = goalById.get(id)
      return g ? [g] : []
    }) }
  const runTargetIds = (r: WfEvalRunSummary) => [
    ...new Set(runGoals(r).map((g) => g.targetId)),
  ]

  const shown = runs.filter(
    (r) => { return (!goalFilter || r.setIds.includes(goalFilter)) &&
      (!targetFilter || runTargetIds(r).includes(targetFilter)) },
  )
  const filtered = goalFilter !== '' || targetFilter !== ''

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <FilterPill
          label="Goal"
          value={goalFilter}
          onChange={setGoalFilter}
          searchPlaceholder="Search goals…"
          options={goals.map((g) => ({ value: g.id, label: g.name }))}
        />
        <TargetFilter
          value={targetFilter}
          onChange={setTargetFilter}
          agents={agentsQuery.data ?? []}
          workflows={workflowsQuery.data ?? []}
        />
      </div>
      <EvalRunsTable
        runs={shown}
        emptyMessage={
          filtered
            ? 'No test runs for this selection.'
            : 'No test runs yet. Run a goal to see results here.'
        }
        onOpenRun={(id) => navigate(`evals/runs/${id}`)}
        renderFirstCell={(r) => {
          const names = runGoals(r).map((g) => g.name)
          return (
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium text-neutral-900">
                  {formatTimestamp(r.createdAt)}
                </span>
                <RunStatusBadge status={r.status} />
              </div>
              <div
                className="mt-0.5 truncate text-xs text-neutral-500"
                title={names.join(', ')}
              >
                {names.length === 0
                  ? `${r.setIds.length} goal${r.setIds.length === 1 ? '' : 's'}`
                  : names.length === 1
                    ? names[0]
                    : `${names[0]} +${names.length - 1}`}{' '}
                · {r.total} sample{r.total === 1 ? '' : 's'}
              </div>
            </div>
          )
        }}
        renderAgentCell={(r) => (
          <TargetPills
            targetIds={runTargetIds(r)}
            agents={agentsQuery.data ?? []}
            workflows={workflowsQuery.data ?? []}
          />
        )}
      />
    </div>
  )
}

// The distinct targets of a run's goals: the first as a pill, the rest as "+N".
function TargetPills({
  targetIds,
  agents,
  workflows,
}: {
  targetIds: string[]
  agents: WfAgentSummary[]
  workflows: WfWorkflowSummary[]
}) {
  const [first, ...rest] = targetIds
  if (!first) return <span className="text-sm text-neutral-400">—</span>
  const workflow = workflows.find((w) => w.id === first)
  return (
    <span className="inline-flex items-center gap-1.5">
      {workflow ? (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-neutral-200 bg-white py-0.5 pl-0.5 pr-2.5">
          <WorkflowChip />
          <span className="max-w-[10rem] truncate text-xs font-medium text-neutral-700">
            {workflow.name}
          </span>
        </span>
      ) : (
        <AgentPill agent={agents.find((a) => a.id === first)} />
      )}
      {rest.length > 0 ? (
        <span className="text-xs text-neutral-500">+{rest.length}</span>
      ) : null}
    </span>
  )
}
