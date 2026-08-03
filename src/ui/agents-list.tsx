import { Cpu, Goal, Plus, Wrench, Workflow } from 'lucide-react'
import { type ReactNode, useMemo } from 'react'

import { agentColor, agentIcon, DEFAULT_AGENT_COLOR } from './agent-appearance'
import { cn } from './cn'
import { useWfComponents } from './context'
import {
  useAgents,
  useCreateAgent,
  useEvalSets,
  useModels,
  useTools,
} from './hooks'
import { useWfNav } from './nav'
import { QueryState } from './query-state'

// The reusable agents (wf_agent via the injected data client), shown as
// cards so richer metadata (last run, referencing workflows…) can layer in.
// Each card links into the agent editor. Reached from the hub's Agents card.
//
// "New agent" always starts from a blank agent the author configures.

const STARTER_PROMPT = 'You are a helpful assistant.'

export type AgentsListProps = {
  className?: string
}

export function AgentsList({ className }: AgentsListProps) {
  const { data, isLoading, error } = useAgents()
  const models = useModels()
  const tools = useTools()
  const evalSets = useEvalSets()
  const { Button } = useWfComponents()
  const { navigate } = useWfNav()
  const create = useCreateAgent()

  const defaultModelId = models.data?.[0]?.id ?? 'default'

  // Lookups so each card can label its model and show its tools' brand icons
  // without re-scanning the (small) catalogs per render.
  const modelLabel = useMemo(() => {
    const byId = new Map(models.data?.map((m) => [m.id, m.label]))
    return (id: string | null) => (id ? (byId.get(id) ?? id) : null)
  }, [models.data])
  const toolById = useMemo(
    () => new Map(tools.data?.map((t) => [t.id, t])),
    [tools.data],
  )
  // How many product goals (eval sets) each agent is targeted by — counts only
  // live (non-archived) sets whose target is this agent.
  const goalCountByAgent = useMemo(() => {
    const counts = new Map<string, number>()
    for (const set of evalSets.data ?? []) {
      if (set.archived || set.targetKind !== 'agent') continue
      counts.set(set.targetId, (counts.get(set.targetId) ?? 0) + 1)
    }
    return counts
  }, [evalSets.data])

  function createBlank() {
    create.mutate(
      {
        name: 'Untitled agent',
        color: DEFAULT_AGENT_COLOR,
        config: {
          modelId: defaultModelId,
          prompt: STARTER_PROMPT,
          toolIds: [],
          maxTurns: 5,
          exposeThinking: false,
          enableReasoning: false,
          output: { kind: 'text' },
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
          Reusable agents — model, prompt, tools, and expected output in one
          place. Workflows point at a published agent.
        </div>
        <Button
          size="sm"
          className="shrink-0 whitespace-nowrap"
          onClick={createBlank}
          disabled={create.isPending}
        >
          <Plus className="size-4" />
          {create.isPending ? 'Creating…' : 'New agent'}
        </Button>
      </div>

      <QueryState
        query={{ isLoading, error, data }}
        loading={<div className="text-sm text-neutral-500">Loading…</div>}
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

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {data?.map((a) => {
          const Icon = agentIcon(a.icon)
          const color = agentColor(a.color)
          const model = modelLabel(a.modelId)
          const agentTools = a.toolIds
            .map((id) => toolById.get(id))
            .filter((t): t is NonNullable<typeof t> => !!t)
          const goalCount = goalCountByAgent.get(a.id) ?? 0
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
                <span className="min-w-0 flex-1 truncate text-base font-medium text-neutral-900">
                  {a.name}
                </span>
              </div>
              <p className="line-clamp-2 min-h-[2.5rem] text-sm text-neutral-500">
                {a.description || 'No description yet.'}
              </p>

              <div className="flex w-full flex-wrap items-center gap-1.5">
                {model ? (
                  <Pill title={`Model: ${model}`}>
                    <Cpu className="size-3.5 text-neutral-400" />
                    <span className="max-w-[10rem] truncate">{model}</span>
                  </Pill>
                ) : null}

                {a.toolIds.length > 0 ? (
                  <Pill
                    title={
                      agentTools.length > 0
                        ? `Tools: ${agentTools.map((t) => t.name).join(', ')}`
                        : `${a.toolIds.length} tool${a.toolIds.length === 1 ? '' : 's'}`
                    }
                  >
                    <Wrench className="size-3.5 text-neutral-400" />
                    <span>
                      {a.toolIds.length} tool{a.toolIds.length === 1 ? '' : 's'}
                    </span>
                  </Pill>
                ) : null}

                {goalCount > 0 ? (
                  <Pill
                    title={`Targeted by ${goalCount} product goal${goalCount === 1 ? '' : 's'} (evals)`}
                  >
                    <Goal className="size-3.5 text-neutral-400" />
                    <span>
                      {goalCount} Goal{goalCount === 1 ? '' : 's'}
                    </span>
                  </Pill>
                ) : null}

                {a.workflows.length > 0 ? (
                  <Pill
                    title={`Used in: ${a.workflows.map((w) => w.name).join(', ')}`}
                  >
                    <Workflow className="size-3.5 text-neutral-400" />
                    <span>
                      {a.workflows.length} workflow
                      {a.workflows.length === 1 ? '' : 's'}
                    </span>
                  </Pill>
                ) : (
                  <Pill className="text-neutral-400" title="Not used in any workflow">
                    <Workflow className="size-3.5" />
                    <span>Unused</span>
                  </Pill>
                )}
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

// A small metadata chip shown on an agent card (model, tools, workflow usage).
function Pill({
  children,
  className,
  title,
}: {
  children: ReactNode
  className?: string
  title?: string
}) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1 rounded-md border border-neutral-200 bg-neutral-50 px-2 py-0.5 text-xs font-medium text-neutral-600',
        className,
      )}
    >
      {children}
    </span>
  )
}
