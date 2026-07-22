import { Cpu, Goal, Plus, Sparkles, Wrench, Workflow } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'

import type { AgentTemplate } from '../engine'
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
import { Modal } from './modal'
import { useWfNav } from './nav'
import { QueryState } from './query-state'

// The reusable agents (wf_agent via the injected data client), shown as
// cards so richer metadata (last run, referencing workflows…) can layer in.
// Each card links into the agent editor. Reached from the hub's Agents card.
//
// "New agent" starts blank, or from a host-injected **template** (a named,
// pre-configured AgentConfig — e.g. a web-search or RAG agent) when the host
// supplies `templates`.

const STARTER_PROMPT = 'You are a helpful assistant.'

export type { AgentTemplate }

export type AgentsListProps = {
  className?: string
  /** Host-injected starting points offered in the "New agent" flow. */
  templates?: AgentTemplate[]
}

export function AgentsList({ className, templates = [] }: AgentsListProps) {
  const { data, isLoading, error } = useAgents()
  const models = useModels()
  const tools = useTools()
  const evalSets = useEvalSets()
  const { Button } = useWfComponents()
  const { navigate } = useWfNav()
  const create = useCreateAgent()
  const [picking, setPicking] = useState(false)

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
          output: { kind: 'text' },
        },
      },
      { onSuccess: (r) => navigate(`agents/${r.agentId}/edit`) },
    )
  }

  function createFromTemplate(t: AgentTemplate) {
    create.mutate(
      {
        name: t.name,
        description: t.description,
        icon: t.icon,
        color: t.color ?? DEFAULT_AGENT_COLOR,
        config: { modelId: defaultModelId, ...t.config },
      },
      { onSuccess: (r) => navigate(`agents/${r.agentId}/edit`) },
    )
  }

  function onNew() {
    if (templates.length > 0) setPicking(true)
    else createBlank()
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
          onClick={onNew}
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

      {picking ? (
        <TemplatePicker
          templates={templates}
          creating={create.isPending}
          onBlank={() => {
            setPicking(false)
            createBlank()
          }}
          onPick={(t) => {
            setPicking(false)
            createFromTemplate(t)
          }}
          onClose={() => setPicking(false)}
        />
      ) : null}
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

function TemplatePicker({
  templates,
  creating,
  onBlank,
  onPick,
  onClose,
}: {
  templates: AgentTemplate[]
  creating: boolean
  onBlank: () => void
  onPick: (t: AgentTemplate) => void
  onClose: () => void
}) {
  const { Button } = useWfComponents()
  return (
    <Modal
      open
      onClose={onClose}
      panelClassName="w-full max-w-2xl rounded-lg border border-neutral-200 bg-white p-5 shadow-xl"
    >
      <h2 className="mb-1 text-base font-semibold text-neutral-900">
        Start a new agent
      </h2>
      <p className="mb-4 text-sm text-neutral-500">
        Begin from a template or a blank agent. You can edit everything after.
      </p>

      <div className="grid grid-cols-2 gap-2">
        {templates.map((t) => {
          const Icon = agentIcon(t.icon)
          const color = agentColor(t.color)
          return (
            <button
              key={t.key}
              type="button"
              disabled={creating}
              onClick={() => onPick(t)}
              className="flex h-full items-start gap-3 rounded-lg border border-neutral-200 p-3 text-left transition hover:border-neutral-300 hover:bg-neutral-50"
            >
              <span
                className={cn(
                  'flex size-9 shrink-0 items-center justify-center rounded-lg',
                  color.chip,
                )}
              >
                <Icon className="size-4" />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-neutral-900">
                  {t.name}
                </span>
                <span className="mt-0.5 block text-xs text-neutral-500">
                  {t.description}
                </span>
              </span>
            </button>
          )
        })}
        <button
          type="button"
          disabled={creating}
          onClick={onBlank}
          className="flex h-full items-start gap-3 rounded-lg border border-dashed border-neutral-300 p-3 text-left transition hover:border-neutral-400 hover:bg-neutral-50"
        >
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-neutral-100 text-neutral-500">
            <Sparkles className="size-4" />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-medium text-neutral-700">
              Start from scratch
            </span>
            <span className="mt-0.5 block text-xs text-neutral-500">
              A blank agent you configure yourself.
            </span>
          </span>
        </button>
      </div>

      <div className="mt-4 flex justify-end">
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </Modal>
  )
}
