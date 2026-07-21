import {
  Check,
  ChevronDown,
  HelpCircle,
  Play,
  Plus,
  Workflow as WorkflowIcon,
} from 'lucide-react'
import { useMemo, useRef, useState } from 'react'

import type {
  WfAgentSummary,
  WfEvalRunSummary,
  WfEvalSetSummary,
  WfWorkflowSummary,
} from '../../server/protocol'
import { agentColor, agentIcon } from '../agent-appearance'
import { cn } from '../cn'
import { useWfComponents } from '../context'
import { useAgents, useEvalRuns, useEvalSets, useWorkflows } from '../hooks'
import { useWfNav } from '../nav'
import { useDismiss } from '../use-dismiss'
import { EvalsHelpDialog } from './evals-help-dialog'
import { NewGoalDialog } from './new-goal-dialog'
import { RunConfigDialog } from './run-config-dialog'
import {
  EmptyState,
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
        setsQuery.isLoading ? (
          <EmptyState message="Loading goals…" />
        ) : (
          <GoalsTable goals={goals} />
        )
      ) : runsQuery.isLoading ? (
        <EmptyState message="Loading test runs…" />
      ) : (
        <RunsTable runs={runs} />
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
          <span>Target</span>
          <span>Samples</span>
        </div>
        {shown.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-neutral-400">
            No goals target this selection.
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

// Filter the goals list by target. A custom dropdown (native <select> can't
// render logos) listing every agent (its icon on its color tint) and every
// workflow (generic glyph), plus an "All targets" reset.
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
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useDismiss(rootRef, open, () => setOpen(false))

  const selectedAgent = agents.find((a) => a.id === value)
  const selectedWorkflow = workflows.find((w) => w.id === value)

  const select = (id: string) => {
    onChange(id)
    setOpen(false)
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-neutral-400">Filter by target</span>
      <div ref={rootRef} className="relative">
        <button
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="flex h-8 min-w-52 items-center gap-2 rounded-md border border-neutral-300 bg-white px-2 text-sm outline-none transition hover:border-neutral-400"
        >
          {selectedAgent ? (
            <AgentGlyph agent={selectedAgent} />
          ) : selectedWorkflow ? (
            <WorkflowChip />
          ) : null}
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-left',
              value ? 'text-neutral-800' : 'text-neutral-500',
            )}
          >
            {selectedAgent?.name ?? selectedWorkflow?.name ?? 'All targets'}
          </span>
          <ChevronDown className="size-4 shrink-0 text-neutral-400" />
        </button>

        {open ? (
          <div className="absolute z-50 mt-1 max-h-80 w-64 overflow-y-auto rounded-md border border-neutral-200 bg-white py-1 shadow-lg">
            <FilterOption
              label="All targets"
              selected={!value}
              onClick={() => select('')}
            />
            {agents.length > 0 ? (
              <div className="mt-1 px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
                Agents
              </div>
            ) : null}
            {agents.map((a) => (
              <FilterOption
                key={a.id}
                label={a.name}
                icon={<AgentGlyph agent={a} />}
                selected={a.id === value}
                onClick={() => select(a.id)}
              />
            ))}
            {workflows.length > 0 ? (
              <div className="mt-1 px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
                Workflows
              </div>
            ) : null}
            {workflows.map((w) => (
              <FilterOption
                key={w.id}
                label={w.name}
                icon={<WorkflowChip />}
                selected={w.id === value}
                onClick={() => select(w.id)}
              />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function FilterOption({
  label,
  icon,
  selected,
  onClick,
}: {
  label: string
  icon?: React.ReactNode
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 px-3 py-1.5 text-left transition',
        selected ? 'bg-neutral-100' : 'hover:bg-neutral-50',
      )}
    >
      {icon ?? <span className="size-5 shrink-0" />}
      <span className="min-w-0 flex-1 truncate text-sm text-neutral-800">
        {label}
      </span>
      <Check
        className={cn(
          'size-4 shrink-0 text-neutral-900',
          selected ? 'opacity-100' : 'opacity-0',
        )}
      />
    </button>
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

function RunsTable({ runs }: { runs: WfEvalRunSummary[] }) {
  const { navigate } = useWfNav()
  return (
    <EvalRunsTable
      runs={runs}
      emptyMessage="No test runs yet. Run a goal to see results here."
      onOpenRun={(id) => navigate(`evals/runs/${id}`)}
      renderFirstCell={(r) => (
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-neutral-900">
              {formatTimestamp(r.createdAt)}
            </span>
            <RunStatusBadge status={r.status} />
          </div>
          <div className="mt-0.5 truncate text-xs text-neutral-500">
            {r.setIds.length} goal{r.setIds.length === 1 ? '' : 's'} ·{' '}
            {r.total} sample{r.total === 1 ? '' : 's'}
          </div>
        </div>
      )}
    />
  )
}
