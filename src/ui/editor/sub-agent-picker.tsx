import { Search, Workflow, X } from 'lucide-react'
import { useMemo, useState } from 'react'

import {
  previewSpawnTools,
  type SubAgentsConfig,
  type SubAgentTarget,
} from '../../engine'
import type { WfAgentSummary, WfWorkflowSummary } from '../../server/protocol'
import { agentColor, agentIcon } from '../agent-appearance'
import { cn } from '../cn'
import { useWfComponents } from '../context'
import { useAgents, useWorkflows } from '../hooks'

// Configures an agent's DELEGATION whitelist: the agents/workflows it may spawn
// as sub-agents, plus the guardrails (concurrency + total cap) and the stop
// signal. Selection is owned by the caller (`value` + `onChange`) so it plugs
// into the agent editor's `patch({ subAgents })` flow. A live preview shows the
// exact `spawn_*` tool names/descriptions the engine will synthesize.

const DEFAULT_SUB_AGENTS: SubAgentsConfig = {
  targets: [],
  maxConcurrent: 4,
  maxSpawns: 10,
  allowStopSignal: true,
}

export type SubAgentPickerProps = {
  value: SubAgentsConfig | undefined
  onChange: (next: SubAgentsConfig) => void
  /** The agent being edited — excluded from its own whitelist. */
  currentAgentId: string
}

type PickOption = {
  key: string
  kind: 'agent' | 'workflow'
  id: string
  name: string
  description: string
  agent?: WfAgentSummary
}

function targetKey(t: Pick<SubAgentTarget, 'kind' | 'id'>): string {
  return `${t.kind}:${t.id}`
}

export function SubAgentPicker({
  value,
  onChange,
  currentAgentId,
}: SubAgentPickerProps) {
  const cfg = value ?? DEFAULT_SUB_AGENTS
  const agents = useAgents()
  const workflows = useWorkflows()
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)

  const options = useMemo<PickOption[]>(() => {
    const a = (agents.data ?? [])
      .filter((x: WfAgentSummary) => x.id !== currentAgentId)
      .map((x: WfAgentSummary) => ({
        key: `agent:${x.id}`,
        kind: 'agent' as const,
        id: x.id,
        name: x.name,
        description: x.description ?? '',
        agent: x,
      }))
    const w = (workflows.data ?? [])
      .filter((x: WfWorkflowSummary) => !x.archived)
      .map((x: WfWorkflowSummary) => ({
        key: `workflow:${x.id}`,
        kind: 'workflow' as const,
        id: x.id,
        name: x.name,
        description: x.description ?? '',
      }))
    return [...a, ...w]
  }, [agents.data, workflows.data, currentAgentId])

  const byKey = useMemo(
    () => new Map(options.map((o) => [o.key, o])),
    [options],
  )

  const selectedKeys = useMemo(
    () => new Set(cfg.targets.map(targetKey)),
    [cfg.targets],
  )
  // Already-picked targets drop out of the results — the list is what you can
  // still add, not everything that exists.
  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    return options
      .filter((o) => !selectedKeys.has(o.key))
      .filter(
        (o) =>
          q.length === 0 ||
          o.name.toLowerCase().includes(q) ||
          o.description.toLowerCase().includes(q),
      )
      .sort((x, y) => x.name.localeCompare(y.name))
  }, [options, query, selectedKeys])

  function patch(next: Partial<SubAgentsConfig>) {
    onChange({ ...cfg, ...next })
  }

  function add(o: PickOption) {
    if (selectedKeys.has(o.key)) return
    patch({
      targets: [...cfg.targets, { kind: o.kind, id: o.id, version: null }],
    })
    setQuery('')
  }

  function remove(t: SubAgentTarget) {
    patch({ targets: cfg.targets.filter((x) => targetKey(x) !== targetKey(t)) })
  }

  // Live preview of the synthesized spawn tools, resolving each target's display
  // name + (agent) prompt variables from the loaded summaries.
  const preview = useMemo(
    () =>
      previewSpawnTools(cfg.targets, (t) => {
        const o = byKey.get(targetKey(t))
        return {
          displayName: o?.name ?? t.id,
          promptVariables:
            t.kind === 'agent' ? (o?.agent?.inputVariables ?? []) : undefined,
        }
      }),
    [cfg.targets, byKey],
  )

  return (
    <div className="space-y-4">
      <SelectedTargets targets={cfg.targets} byKey={byKey} onRemove={remove} />

      <TargetSearch
        query={query}
        onQuery={setQuery}
        open={open}
        onOpenChange={setOpen}
        results={results}
        anyOptions={options.length > 0}
        onAdd={add}
      />

      <Guardrails cfg={cfg} onPatch={patch} />

      <SpawnToolPreview preview={preview} />
    </div>
  )
}

/** The delegation whitelist as it stands. */
function SelectedTargets({
  targets,
  byKey,
  onRemove,
}: {
  targets: SubAgentTarget[]
  byKey: Map<string, PickOption>
  onRemove: (t: SubAgentTarget) => void
}) {
  if (targets.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-neutral-200 p-3 text-center text-xs text-neutral-400">
        No sub-agents yet. Add agents or workflows this agent may delegate to.
      </div>
    )
  }
  return (
    <ul className="space-y-1.5">
      {targets.map((t) => {
        const o = byKey.get(targetKey(t))
        return (
          <li
            key={targetKey(t)}
            className="flex items-center gap-2.5 rounded-md border border-neutral-200 bg-white p-2"
          >
            <TargetIcon option={o} kind={t.kind} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-neutral-800">
                {o?.name ?? t.id}
                <span className="ml-2 rounded bg-neutral-100 px-1 py-px text-[10px] font-medium uppercase tracking-wide text-neutral-500">
                  {t.kind}
                </span>
              </span>
              {o?.description ? (
                <span className="block truncate text-xs text-neutral-400">
                  {o.description}
                </span>
              ) : null}
            </span>
            <button
              type="button"
              aria-label={`Remove ${o?.name ?? t.id}`}
              onClick={() => onRemove(t)}
              className="shrink-0 rounded p-1 text-neutral-400 transition-colors hover:bg-red-50 hover:text-red-600"
            >
              <X className="size-4" />
            </button>
          </li>
        )
      })}
    </ul>
  )
}

/**
 * Type-ahead over every agent and workflow this agent could delegate to.
 *
 * The blur close is deferred ~120ms so a click on a result lands before the
 * list unmounts; the result buttons also add on `mouseDown` rather than
 * `click`, which is what makes the pick register at all.
 */
function TargetSearch({
  query,
  onQuery,
  open,
  onOpenChange,
  results,
  anyOptions,
  onAdd,
}: {
  query: string
  onQuery: (q: string) => void
  open: boolean
  onOpenChange: (open: boolean) => void
  results: PickOption[]
  /** Whether anything exists to pick — words the empty state. */
  anyOptions: boolean
  onAdd: (o: PickOption) => void
}) {
  const { Input } = useWfComponents()
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-neutral-400" />
      <Input
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        onFocus={() => onOpenChange(true)}
        onBlur={() => setTimeout(() => onOpenChange(false), 120)}
        placeholder="Search agents & workflows to delegate to…"
        className="pl-8"
      />
      {open ? (
        <div className="absolute z-50 mt-1 max-h-64 w-full overflow-auto rounded-md border border-neutral-200 bg-white p-1 shadow-lg">
          {results.length === 0 ? (
            <div className="p-2 text-xs text-neutral-400">
              {anyOptions ? 'Nothing matches.' : 'No agents or workflows available.'}
            </div>
          ) : (
            results.map((o) => (
              <button
                key={o.key}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault()
                  onAdd(o)
                }}
                className="flex w-full items-center gap-2.5 rounded-md p-2 text-left transition-colors hover:bg-neutral-50"
              >
                <TargetIcon option={o} kind={o.kind} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-neutral-800">
                    {o.name}
                  </span>
                  <span className="block truncate text-xs text-neutral-400">
                    {o.description || o.kind}
                  </span>
                </span>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  )
}

/** Bounds on the fan-out, and whether a child may cut the wait short. */
function Guardrails({
  cfg,
  onPatch,
}: {
  cfg: SubAgentsConfig
  onPatch: (next: Partial<SubAgentsConfig>) => void
}) {
  const { Input, Label } = useWfComponents()
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label>Max concurrent</Label>
          <Input
            type="number"
            min={1}
            max={20}
            value={cfg.maxConcurrent}
            onChange={(e) =>
              onPatch({
                maxConcurrent: Math.max(1, Number.parseInt(e.target.value, 10) || 1),
              })
            }
          />
        </div>
        <div className="space-y-1">
          <Label>Max sub-agents</Label>
          <Input
            type="number"
            min={1}
            max={50}
            value={cfg.maxSpawns}
            onChange={(e) =>
              onPatch({
                maxSpawns: Math.max(1, Number.parseInt(e.target.value, 10) || 1),
              })
            }
          />
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm text-neutral-800">
        <input
          type="checkbox"
          checked={cfg.allowStopSignal}
          onChange={(e) => onPatch({ allowStopSignal: e.target.checked })}
        />
        Let a sub-agent signal “stop” to short-circuit the wait
      </label>
    </>
  )
}

/**
 * The tools this whitelist actually synthesizes. Shown because the connection
 * between "pick a target" and "the agent gains a `spawn_x` tool" is otherwise
 * invisible until a run.
 */
function SpawnToolPreview({
  preview,
}: {
  preview: { toolName: string }[]
}) {
  if (preview.length === 0) return null
  return (
    <div className="space-y-1.5 rounded-md border border-neutral-200 bg-neutral-50/60 p-3">
      <div className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">
        Tools this agent will get
      </div>
      <ul className="space-y-1">
        {preview.map((p) => (
          <li key={p.toolName} className="text-xs text-neutral-600">
            <code className="rounded bg-neutral-200/70 px-1 py-px font-mono text-[11px] text-neutral-800">
              {p.toolName}
            </code>
          </li>
        ))}
        <li className="text-xs text-neutral-600">
          <code className="rounded bg-neutral-200/70 px-1 py-px font-mono text-[11px] text-neutral-800">
            await_subagents
          </code>{' '}
          <span className="text-neutral-400">· wait for results</span>
        </li>
      </ul>
    </div>
  )
}

function TargetIcon({
  option,
  kind,
}: {
  option?: PickOption
  kind: 'agent' | 'workflow'
}) {
  if (kind === 'workflow') {
    return (
      <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-sky-100 text-sky-600">
        <Workflow className="size-3.5" />
      </span>
    )
  }
  const Icon = agentIcon(option?.agent?.icon)
  return (
    <span
      className={cn(
        'flex size-6 shrink-0 items-center justify-center rounded-md',
        agentColor(option?.agent?.color).chip,
      )}
    >
      <Icon className="size-3.5" />
    </span>
  )
}
