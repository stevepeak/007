import { Cpu, Plus, Scale } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'

import { starterDecisionAgentConfig, type WfAgentKind } from '../engine'

import { agentColor, agentIcon, DEFAULT_AGENT_COLOR } from './agent-appearance'
import { cn } from './cn'
import { useWfComponents } from './context'
import { FilterPill } from './filters'
import {
  useAgents,
  useCreateAgent,
  useModels,
} from './hooks'
import { useDecisionModels } from './hooks-models'
import { Modal } from './modal'
import { useWfNav } from './nav'
import { QueryState } from './query-state'

// The reusable agents (wf_agent via the injected data client), shown as
// cards so richer metadata (last run, referencing workflows…) can layer in.
// Each card links into the agent editor. Reached from the hub's Agents card.
//
// "New agent" asks for the TYPE first. It has to: `wf_agent.kind` is immutable
// (the two configs share no field, so there is nothing a conversion could carry
// over) and the two editors are disjoint, so the choice cannot be deferred into
// the editor the way a model or a tool can.

const NO_WORKFLOW = '__none__'

const STARTER_PROMPT = 'You are a helpful assistant.'
// A new agent starts as a task agent, so it needs a user message from the outset
// — `agentConfigSchema` refuses to save one without it. The `${…}` token doubles
// as the worked example: it's how an author learns that data arrives by mapping a
// variable, not by wiring an edge.
const STARTER_USER_PROMPT = 'Here is what to work on:\n\n${input}'

export type AgentsListProps = {
  className?: string
}

export function AgentsList({ className }: AgentsListProps) {
  const { data, isLoading, error } = useAgents()
  const models = useModels()
  const { Button } = useWfComponents()
  const { navigate } = useWfNav()
  const create = useCreateAgent()

  const deciders = useDecisionModels()
  const defaultModelId = models.data?.[0]?.id ?? 'default'
  const defaultDeciderId = deciders.data?.[0]?.id ?? ''
  // The type picker, open from the "New agent" button. Null = closed.
  const [choosingKind, setChoosingKind] = useState(false)

  // Lookups so each card can label its model
  // without re-scanning the (small) catalogs per render.
  const modelLabel = useMemo(() => {
    const byId = new Map(models.data?.map((m) => [m.id, m.label]))
    return (id: string | null) => (id ? (byId.get(id) ?? id) : null)
  }, [models.data])
  // Filters. '' = no filter; the workflow filter also has NONE for agents
  // used in no workflow.
  const [kindFilter, setKindFilter] = useState<'' | WfAgentKind>('')
  const [modelFilter, setModelFilter] = useState('')
  const [workflowFilter, setWorkflowFilter] = useState('')

  const modelOptions = useMemo(() => {
    const ids = new Set<string>()
    for (const a of data ?? []) if (a.modelId) ids.add(a.modelId)
    return [...ids]
      .map((id) => ({ id, label: modelLabel(id) ?? id }))
      .sort((x, y) => x.label.localeCompare(y.label))
  }, [data, modelLabel])
  const workflowOptions = useMemo(() => {
    const byId = new Map<string, string>()
    for (const a of data ?? [])
      for (const w of a.workflows) byId.set(w.id, w.name)
    return [...byId]
      .map(([id, name]) => ({ id, name }))
      .sort((x, y) => x.name.localeCompare(y.name))
  }, [data])

  const visible = useMemo(
    () =>
      (data ?? []).filter(
        (a) =>
          (!kindFilter || a.kind === kindFilter) &&
          (!modelFilter || a.modelId === modelFilter) &&
          (!workflowFilter ||
            (workflowFilter === NO_WORKFLOW
              ? a.workflows.length === 0
              : a.workflows.some((w) => w.id === workflowFilter))),
      ),
    [data, kindFilter, modelFilter, workflowFilter],
  )

  function createBlank(kind: WfAgentKind) {
    setChoosingKind(false)
    if (kind === 'decision') {
      create.mutate(
        {
          name: 'Untitled decision agent',
          kind: 'decision',
          color: DEFAULT_AGENT_COLOR,
          // A starter matrix rather than an empty one: one yes/no question and
          // a two-rule rollup is the smallest thing that is still a WORKING
          // decision agent, so the editor opens on something an author edits
          // rather than something they have to assemble before it means
          // anything. Its question prompt is deliberately blank — that is the
          // one part nobody else can write.
          config: starterDecisionAgentConfig(defaultDeciderId),
        },
        { onSuccess: (r) => navigate(`agents/${r.agentId}/edit`) },
      )
      return
    }
    create.mutate(
      {
        name: 'Untitled agent',
        kind: 'generation',
        color: DEFAULT_AGENT_COLOR,
        config: {
          modelId: defaultModelId,
          prompt: STARTER_PROMPT,
          userPrompt: STARTER_USER_PROMPT,
          toolIds: [],
          maxTurns: 5,
          requireToolFirstTurn: false,
          // A new agent doesn't think until its author decides it needs to —
          // same default as the schema.
          reasoning: false,
          webSearch: 'off',
          webCitations: false,
          referenceKinds: [],
          toolTokenBudget: null,
          answerReservePercent: 10,
          output: { kind: 'text' },
          inputKind: 'task',
          subAgents: {
            targets: [],
            maxConcurrent: 4,
            maxSpawns: 10,
            allowStopSignal: true,
          },
        },
      },
      { onSuccess: (r) => navigate(`agents/${r.agentId}/edit`) },
    )
  }

  return (
    <div className={cn('mx-auto max-w-3xl space-y-4 p-6', className)}>
      <div className="flex items-center justify-between">
        <div className="text-sm text-neutral-500">
          Reusable agents — a generation agent's model, prompt, tools and
          expected output, or a decision agent's question set and verdict
          rules. Workflows point at a published generation agent.
        </div>
        <Button
          size="sm"
          className="shrink-0 whitespace-nowrap"
          onClick={() => setChoosingKind(true)}
          disabled={create.isPending}
        >
          <Plus className="size-4" />
          {create.isPending ? 'Creating…' : 'New agent'}
        </Button>
      </div>

      <QueryState
        query={{ isLoading, error, data }}
        error={(error) => (
          <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {error.message} — are you signed in?
          </div>
        )}
        isEmpty={(data) => data?.length === 0}
        empty={
          <div className="text-sm text-neutral-500">
            No agents yet. Create one to reuse it across workflows.
          </div>
        }
      />

      {choosingKind ? (
        <AgentKindDialog
          hasDecider={(deciders.data ?? []).length > 0}
          onPick={createBlank}
          onClose={() => setChoosingKind(false)}
        />
      ) : null}

      {(data?.length ?? 0) > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <FilterPill
            label="Type"
            value={kindFilter}
            onChange={(v) => setKindFilter(v as '' | WfAgentKind)}
            options={[
              {
                value: 'generation',
                label: 'Generation',
                node: (
                  <span className="inline-flex items-center gap-1.5">
                    <Cpu className="size-3.5" />
                    Generation
                  </span>
                ),
              },
              {
                value: 'decision',
                label: 'Decision',
                node: (
                  <span className="inline-flex items-center gap-1.5">
                    <Scale className="size-3.5" />
                    Decision
                  </span>
                ),
              },
            ]}
          />
          <FilterPill
            label="Model"
            value={modelFilter}
            onChange={setModelFilter}
            options={[
              ...modelOptions.map((m) => ({ value: m.id, label: m.label })),
            ]}
          />
          <FilterPill
            label="Workflow"
            value={workflowFilter}
            onChange={setWorkflowFilter}
            options={[
              ...workflowOptions.map((w) => ({ value: w.id, label: w.name })),
              {
                value: NO_WORKFLOW,
                label: 'No workflows',
                separatorBefore: true,
                node: <span className="text-neutral-500">No workflows</span>,
              },
            ]}
          />
        </div>
      ) : null}

      {(data?.length ?? 0) > 0 && visible.length === 0 ? (
        <div className="text-sm text-neutral-500">
          No agents match these filters.
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {visible.map((a) => {
          const Icon = agentIcon(a.icon)
          const color = agentColor(a.color)
          const model = modelLabel(a.modelId)
          const isDecision = a.kind === 'decision'
          return (
            <button
              key={a.id}
              type="button"
              onClick={() => navigate(`agents/${a.id}/edit`)}
              className="group flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-white p-4 text-left transition duration-200 hover:border-neutral-300 hover:shadow-md"
            >
              <div className="flex w-full items-center gap-3">
                <span
                  className={cn(
                    'flex size-10 shrink-0 items-center justify-center rounded-lg',
                    color.chip,
                  )}
                >
                  <Icon className="size-5" />
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  {/* The kind is on the card because almost everything else
                      on it means something different per kind — and because
                      a decision agent cannot be wired into a workflow, which
                      is the first thing someone browsing this list wants to
                      do. */}
                  <span
                    className="text-xs text-neutral-500"
                    title={
                      isDecision
                        ? 'A decision agent: questions judged by a decision model, rolled up to one verdict'
                        : 'A generation agent: a prompt, tools and an answer — what a workflow agent node calls'
                    }
                  >
                    {isDecision ? 'Decision' : 'Generation'}
                  </span>
                  <span className="truncate text-base font-medium text-neutral-900">
                    {a.name}
                  </span>
                </span>
              </div>
              <p className="line-clamp-2 min-h-[2.5rem] text-sm text-neutral-500">
                {a.description || 'No description yet.'}
              </p>

              <div className="grid w-full grid-cols-2 gap-4 border-t border-neutral-100 pt-3">
                <Stat
                  label="Model"
                  value={model ?? '—'}
                  title={model ? `Model: ${model}` : undefined}
                />
                <Stat
                  label="Workflows"
                  value={
                    a.workflows.length > 0
                      ? String(a.workflows.length)
                      : isDecision
                        ? 'None yet'
                        : 'Unused'
                  }
                  title={
                    a.workflows.length > 0
                      ? `Used in: ${a.workflows.map((w) => w.name).join(', ')}`
                      : isDecision
                        ? 'Run this from a workflow by adding an Agent node and pointing it at this agent — it outputs one verdict a Switch can route on.'
                        : 'Not used in any workflow'
                  }
                />
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/**
 * The type step, ahead of the editor.
 *
 * Two cards rather than a dropdown, because the choice is permanent and the
 * two options are not variations of one thing — picking wrong means deleting
 * the agent and starting again, so the differences are spelled out at the
 * moment of choosing rather than discovered in an editor with the wrong
 * fields in it.
 */
function AgentKindDialog({
  hasDecider,
  onPick,
  onClose,
}: {
  hasDecider: boolean
  onPick: (kind: WfAgentKind) => void
  onClose: () => void
}) {
  return (
    <Modal
      open
      onClose={onClose}
      panelClassName="w-full max-w-lg rounded-lg border border-neutral-200 bg-white p-5 shadow-xl"
    >
      <h2 className="text-base font-medium text-neutral-900">New agent</h2>
      <p className="mt-1 text-sm text-neutral-500">
        Pick the type. It can’t be changed later — the two share no
        configuration, so there is nothing a conversion could carry over.
      </p>
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <KindCard
          tone="border-neutral-200 bg-white text-neutral-700 hover:border-neutral-400"
          icon={<Cpu className="size-5" />}
          title="Generation"
          body="A system prompt, a user message, tools and an answer — in prose or a structured object. What a workflow agent node calls."
          onClick={() => onPick('generation')}
        />
        <KindCard
          tone="border-neutral-200 bg-white text-neutral-700 hover:border-neutral-400"
          icon={<Scale className="size-5" />}
          title="Decision"
          body="A question set judged by a decision model, answered in calibrated probabilities and rolled up to one verdict by ordered rules. What a workflow Agent node can point at to route on its verdict."
          disabled={!hasDecider}
          disabledReason="No decision provider is wired up in this deployment."
          onClick={() => onPick('decision')}
        />
      </div>
    </Modal>
  )
}

function KindCard({
  icon,
  tone,
  title,
  body,
  disabled,
  disabledReason,
  onClick,
}: {
  icon: ReactNode
  tone: string
  title: string
  body: string
  disabled?: boolean
  disabledReason?: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={disabled ? disabledReason : undefined}
      className={cn(
        'flex flex-col items-start gap-2 rounded-lg border p-4 text-left transition',
        tone,
        disabled ? 'cursor-not-allowed opacity-50' : 'hover:shadow-sm',
      )}
    >
      <span>{icon}</span>
      <span className="text-sm font-medium">{title}</span>
      <span className="text-xs opacity-80">{body}</span>
      {disabled ? (
        <span className="text-xs text-amber-600">{disabledReason}</span>
      ) : null}
    </button>
  )
}

// A subdued label/value cell in an agent card's metadata grid.
function Stat({
  label,
  value,
  title,
}: {
  label: string
  value: string
  title?: string
}) {
  return (
    <div title={title} className="min-w-0">
      <div className="text-[11px] text-neutral-400">{label}</div>
      <div className="truncate text-xs text-neutral-600">{value}</div>
    </div>
  )
}
