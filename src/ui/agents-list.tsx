import { Plus, Sparkles } from 'lucide-react'
import { useState } from 'react'

import type { AgentTemplate } from '../engine'
import { agentColor, agentIcon, DEFAULT_AGENT_COLOR } from './agent-appearance'
import { cn } from './cn'
import { useWfComponents } from './context'
import { useAgents, useCreateAgent, useModels } from './hooks'
import { useWfNav } from './nav'

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
  const { Button } = useWfComponents()
  const { navigate } = useWfNav()
  const create = useCreateAgent()
  const [picking, setPicking] = useState(false)

  const defaultModelId = models.data?.[0]?.id ?? 'default'

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

      {isLoading ? (
        <div className="text-sm text-neutral-500">Loading…</div>
      ) : null}
      {error ? (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {(error as Error).message} — are you signed in?
        </div>
      ) : null}
      {data?.length === 0 ? (
        <div className="text-sm text-neutral-500">
          No agents yet. Create one to reuse it across workflows.
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {data?.map((a) => {
          const Icon = agentIcon(a.icon)
          const color = agentColor(a.color)
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-2xl rounded-lg border border-neutral-200 bg-white p-5 shadow-xl">
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
      </div>
    </div>
  )
}
