import { ChevronDown, ListOrdered } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import {
  BRANCH_OPERATORS,
  MANUAL_TRIGGER_KIND,
  PERIODIC_TRIGGER_KIND,
  type JsonSchema,
  type WorkflowGraph,
  type WorkflowNode,
} from '../../engine'
import type { ToolOption, WfAgentSummary } from '../../server/protocol'
import { agentColor, agentIcon } from '../agent-appearance'
import { useWfComponents } from '../context'
import { useAgents, useModels, useTools, useTriggerEvents } from '../hooks'
import { cn } from '../cn'
import { NodeInputsPanel, useIoMaps } from './node-data-panel'
import { accessibleLists } from './node-io'
import { ToolIcon } from '../tool-icon'

// Per-kind config editor for the selected node. Uses injected primitives so it
// themes with the host; model/tool choices come from the data client. Advanced
// fields (agent outputSchema, tool arg bindings) are left as-is on the node and
// round-trip unchanged — a later pass can add rich editors for them.

export type NodeInspectorProps = {
  node: WorkflowNode
  graph: WorkflowGraph
  onChange: (next: WorkflowNode) => void
  /** When the node is inside an iteration, the element schema of the loop's
   * list — so its inputs can bind to the current `Item`'s fields. */
  itemSchema?: JsonSchema
}

function triggerModeLabel(triggerKind: string): string {
  if (triggerKind === MANUAL_TRIGGER_KIND) return 'Manually'
  if (triggerKind === PERIODIC_TRIGGER_KIND) return 'On a schedule'
  return 'On an event'
}

export function NodeInspector({
  node,
  graph,
  onChange,
  itemSchema,
}: NodeInspectorProps) {
  const { Input, Label, Textarea } = useWfComponents()
  const models = useModels()
  const tools = useTools()
  const agents = useAgents()
  const triggerEvents = useTriggerEvents()

  const modelOptions = models.data ?? []
  const agentOptions = agents.data ?? []
  // A tool node runs a tool deterministically with bound args, so it offers
  // every registered tool — both `function` tools (built for tool nodes, e.g.
  // update_document / extract_text) and the `ai-tool` tools an agent can call.
  const toolOptions = tools.data ?? []

  const field = 'space-y-1'
  const selectCls =
    'h-9 w-full rounded-md border border-neutral-300 bg-transparent px-2 text-sm outline-none focus:border-neutral-500'

  return (
    <div className="flex h-full w-80 flex-col gap-4 overflow-y-auto border-l border-neutral-200 p-4">
      <div>
        <div className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
          {node.kind}
        </div>
        <div className={field}>
          <Label>Label</Label>
          <Input
            value={node.label}
            onChange={(e) => onChange({ ...node, label: e.target.value })}
          />
        </div>
      </div>

      {node.kind === 'trigger' ? (
        <div className="space-y-3">
          <div className={field}>
            <Label>Starts</Label>
            <Input value={triggerModeLabel(node.config.triggerKind)} disabled />
          </div>
          {node.config.triggerKind === PERIODIC_TRIGGER_KIND ? (
            <div className={field}>
              <Label>Cron schedule</Label>
              <Input
                value={node.config.cron ?? ''}
                placeholder="0 9 * * *"
                onChange={(e) =>
                  onChange({
                    ...node,
                    config: { ...node.config, cron: e.target.value },
                  })
                }
              />
            </div>
          ) : node.config.triggerKind !== MANUAL_TRIGGER_KIND ? (
            <div className={field}>
              <Label>Event</Label>
              {/* Show the event's human description, never its internal kind. */}
              <Input
                value={
                  triggerEvents.data?.find(
                    (e) => e.kind === node.config.triggerKind,
                  )?.description ?? 'Event'
                }
                disabled
              />
            </div>
          ) : null}
        </div>
      ) : null}

      {node.kind === 'agent' ? (
        <div className={field}>
          <Label>Agent</Label>
          <AgentSelect
            agents={agentOptions}
            value={node.config.agentId}
            onChange={(agentId) =>
              onChange({
                ...node,
                config: { ...node.config, agentId },
              })
            }
          />
        </div>
      ) : null}

      {node.kind === 'tool' ? (
        <div className={field}>
          <Label>Tool</Label>
          <ToolSelect
            tools={toolOptions}
            value={node.config.toolId}
            onChange={(toolId) =>
              onChange({
                ...node,
                config: { ...node.config, toolId },
              })
            }
          />
        </div>
      ) : null}

      {node.kind === 'judge' ? (
        <>
          <div className={field}>
            <Label>Model</Label>
            <select
              className={selectCls}
              value={node.config.modelId}
              onChange={(e) =>
                onChange({
                  ...node,
                  config: { ...node.config, modelId: e.target.value },
                })
              }
            >
              {modelOptions.length === 0 ? (
                <option value={node.config.modelId}>
                  {node.config.modelId}
                </option>
              ) : null}
              {modelOptions.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
          <div className={field}>
            <Label>Test question (yes / no)</Label>
            <Textarea
              rows={3}
              value={node.config.testQuestion}
              onChange={(e) =>
                onChange({
                  ...node,
                  config: { ...node.config, testQuestion: e.target.value },
                })
              }
            />
          </div>
        </>
      ) : null}

      {node.kind === 'branch' ? (
        <>
          <div className={field}>
            <Label>Input path</Label>
            <Input
              value={node.config.path}
              placeholder="e.g. chunks  ·  empty = whole input"
              onChange={(e) =>
                onChange({
                  ...node,
                  config: { ...node.config, path: e.target.value },
                })
              }
            />
            <p className="text-muted-foreground text-xs">
              Dotted path into the incoming value. Leave blank to test the whole
              input.
            </p>
          </div>
          <div className={field}>
            <Label>Condition</Label>
            <select
              className={selectCls}
              value={node.config.operator}
              onChange={(e) =>
                onChange({
                  ...node,
                  config: {
                    ...node.config,
                    operator: e.target
                      .value as (typeof BRANCH_OPERATORS)[number],
                  },
                })
              }
            >
              {BRANCH_OPERATORS.map((op) => (
                <option key={op} value={op}>
                  {op.replace(/_/g, ' ')}
                </option>
              ))}
            </select>
          </div>
          {node.config.operator !== 'is_empty' &&
          node.config.operator !== 'is_not_empty' ? (
            <div className={field}>
              <Label>Value</Label>
              <Input
                value={
                  node.config.value == null ? '' : String(node.config.value)
                }
                onChange={(e) =>
                  onChange({
                    ...node,
                    config: { ...node.config, value: e.target.value },
                  })
                }
              />
            </div>
          ) : null}
          <p className="text-muted-foreground text-xs">
            Deterministic — no model call. The <strong>yes</strong> edge is
            taken when the condition holds.
          </p>
        </>
      ) : null}

      {node.kind === 'iteration' ? (
        <>
          <div className={field}>
            <Label>List</Label>
            <ListSelect
              graph={graph}
              nodeId={node.id}
              value={node.config.itemsPath}
              onSelect={(itemsPath, itemSchema) =>
                onChange({
                  ...node,
                  config: { ...node.config, itemsPath, itemSchema },
                })
              }
            />
            <p className="text-muted-foreground text-xs">
              Pick the list to loop over — each element becomes the{' '}
              <strong>Item</strong>. Only arrays reaching this block are shown.
            </p>
          </div>
          <div className={field}>
            <Label>Concurrency</Label>
            <Input
              type="number"
              min={1}
              max={20}
              value={String(node.config.concurrency)}
              onChange={(e) => {
                const n = Number.parseInt(e.target.value, 10)
                onChange({
                  ...node,
                  config: {
                    ...node.config,
                    concurrency: Number.isNaN(n)
                      ? 1
                      : Math.min(20, Math.max(1, n)),
                  },
                })
              }}
            />
            <p className="text-muted-foreground text-xs">
              How many items run at once (1–20). 1 runs them one at a time.
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={node.config.stopOnError}
              onChange={(e) =>
                onChange({
                  ...node,
                  config: { ...node.config, stopOnError: e.target.checked },
                })
              }
            />
            Stop on first error
          </label>
          <p className="text-muted-foreground text-xs">
            When off, a failed item is recorded and the rest keep running; the
            output collects a placeholder in that item's slot.
          </p>
          <p className="text-muted-foreground text-xs">
            Drag nodes into the block on the canvas to run them per item. The{' '}
            <strong>Item</strong> node is the current element; the{' '}
            <strong>Result</strong> node is that item's output.
          </p>
        </>
      ) : null}

      {node.kind === 'feature-request' ? (
        <div className={field}>
          <Label>Description</Label>
          <Textarea
            rows={4}
            value={node.config.description}
            onChange={(e) =>
              onChange({
                ...node,
                config: { ...node.config, description: e.target.value },
              })
            }
          />
        </div>
      ) : null}

      {node.kind === 'note' ? (
        <div className={field}>
          <Label>Markdown</Label>
          <Textarea
            rows={12}
            className="font-mono text-xs"
            value={node.config.text}
            placeholder={'# Title\n\nNotes with **bold**, `code`, and\n- lists'}
            onChange={(e) =>
              onChange({
                ...node,
                config: { ...node.config, text: e.target.value },
              })
            }
          />
          <p className="text-muted-foreground text-xs">
            A sticky note for the canvas — it never affects the workflow. The
            label above is the note’s title.
          </p>
        </div>
      ) : null}

      {node.kind === 'agent' || node.kind === 'tool' ? (
        <>
          <div className="border-t border-neutral-200" />
          <NodeInputsPanel
            node={node}
            graph={graph}
            onChange={onChange}
            itemSchema={itemSchema}
          />
        </>
      ) : null}
    </div>
  )
}

// List picker for an iteration's source: shows only the arrays reaching the
// block (each with its origin node), so authors select rather than type a path.
// Choosing one also records the element's shape (for inferring `Item`).
function ListSelect({
  graph,
  nodeId,
  value,
  onSelect,
}: {
  graph: WorkflowGraph
  nodeId: string
  value: string | undefined
  onSelect: (path: string, itemSchema?: JsonSchema) => void
}) {
  const maps = useIoMaps()
  const lists = useMemo(
    () => accessibleLists(graph, nodeId, maps),
    [graph, nodeId, maps],
  )
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onDocMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocMouseDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const current =
    value === undefined ? undefined : lists.find((l) => l.path === value)

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex h-9 w-full items-center gap-2 rounded-md border border-neutral-300 bg-transparent px-2 text-left text-sm outline-none focus:border-neutral-500"
      >
        <ListOrdered className="size-4 shrink-0 text-neutral-400" />
        {current ? (
          <span className="min-w-0 flex-1 truncate">
            {current.nodeLabel} · {current.label}
          </span>
        ) : value ? (
          <code className="min-w-0 flex-1 truncate text-xs">{value}</code>
        ) : (
          <span className="text-muted-foreground flex-1">Select a list…</span>
        )}
        <ChevronDown className="size-4 shrink-0 text-neutral-400" />
      </button>

      {open ? (
        <div
          role="listbox"
          className="absolute z-50 mt-1 max-h-72 w-full overflow-y-auto rounded-md border border-neutral-200 bg-white p-1 shadow-lg"
        >
          {lists.length === 0 ? (
            <div className="p-2 text-xs text-neutral-400">
              No lists reach this block yet. Connect a node that outputs an
              array.
            </div>
          ) : null}
          {lists.map((l) => (
            <button
              key={`${l.nodeId}:${l.path}`}
              type="button"
              role="option"
              aria-selected={l.path === value}
              onClick={() => {
                onSelect(l.path, l.itemSchema)
                setOpen(false)
              }}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition hover:bg-neutral-50',
                l.path === value && 'bg-neutral-50',
              )}
            >
              <span className="min-w-0 flex-1 truncate text-sm text-neutral-800">
                {l.nodeLabel}
                <span className="text-neutral-400"> · {l.label}</span>
              </span>
              <span className="shrink-0 text-[10px] text-neutral-400">
                list
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

// Rich agent picker: a native <select> can only render text, so we roll our own
// popover to show each agent's icon, color, name, and description.
function AgentSelect({
  agents,
  value,
  onChange,
}: {
  agents: WfAgentSummary[]
  value: string
  onChange: (agentId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onDocMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocMouseDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const selected = agents.find((a) => a.id === value)
  const SelectedIcon = selected ? agentIcon(selected.icon) : null

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex h-9 w-full items-center gap-2 rounded-md border border-neutral-300 bg-transparent px-2 text-left text-sm outline-none focus:border-neutral-500"
      >
        {selected && SelectedIcon ? (
          <>
            <span
              className={cn(
                'flex size-5 shrink-0 items-center justify-center rounded',
                agentColor(selected.color).chip,
              )}
            >
              <SelectedIcon className="size-3" />
            </span>
            <span className="min-w-0 flex-1 truncate">{selected.name}</span>
          </>
        ) : (
          <span className="text-muted-foreground flex-1">Select an agent…</span>
        )}
        <ChevronDown className="size-4 shrink-0 text-neutral-400" />
      </button>

      {open ? (
        <div
          role="listbox"
          className="absolute z-50 mt-1 max-h-72 w-full overflow-y-auto rounded-md border border-neutral-200 bg-white p-1 shadow-lg"
        >
          {agents.map((a) => {
            const Icon = agentIcon(a.icon)
            const isSelected = a.id === value
            return (
              <button
                key={a.id}
                type="button"
                role="option"
                aria-selected={isSelected}
                onClick={() => {
                  onChange(a.id)
                  setOpen(false)
                }}
                className={cn(
                  'flex w-full items-start gap-2 rounded-md p-2 text-left transition hover:bg-neutral-50',
                  isSelected && 'bg-neutral-50',
                )}
              >
                <span
                  className={cn(
                    'flex size-8 shrink-0 items-center justify-center rounded-md',
                    agentColor(a.color).chip,
                  )}
                >
                  <Icon className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-neutral-900">
                    {a.name}
                  </span>
                  <span className="mt-0.5 line-clamp-2 block text-xs text-neutral-500">
                    {a.description || 'No description yet.'}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

// Rich tool picker: mirrors AgentSelect but shows each tool's brand icon and
// name (a native <select> can't render the inline-SVG ToolIcon).
function ToolSelect({
  tools,
  value,
  onChange,
}: {
  tools: ToolOption[]
  value: string
  onChange: (toolId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onDocMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocMouseDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const selected = tools.find((t) => t.id === value)

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex h-9 w-full items-center gap-2 rounded-md border border-neutral-300 bg-transparent px-2 text-left text-sm outline-none focus:border-neutral-500"
      >
        {selected ? (
          <>
            <ToolIcon icon={selected.icon} className="size-4" />
            <span className="min-w-0 flex-1 truncate">{selected.name}</span>
          </>
        ) : (
          <span className="text-muted-foreground flex-1">Select a tool…</span>
        )}
        <ChevronDown className="size-4 shrink-0 text-neutral-400" />
      </button>

      {open ? (
        <div
          role="listbox"
          className="absolute z-50 mt-1 max-h-72 w-full overflow-y-auto rounded-md border border-neutral-200 bg-white p-1 shadow-lg"
        >
          {tools.length === 0 ? (
            <div className="p-2 text-xs text-neutral-400">
              No tools registered.
            </div>
          ) : null}
          {tools.map((t) => {
            const isSelected = t.id === value
            return (
              <button
                key={t.id}
                type="button"
                role="option"
                aria-selected={isSelected}
                onClick={() => {
                  onChange(t.id)
                  setOpen(false)
                }}
                className={cn(
                  'flex w-full items-start gap-2 rounded-md p-2 text-left transition hover:bg-neutral-50',
                  isSelected && 'bg-neutral-50',
                )}
              >
                <ToolIcon icon={t.icon} className="mt-0.5 size-6" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-neutral-900">
                    {t.name}
                  </span>
                  <span className="mt-0.5 line-clamp-2 block text-xs text-neutral-500">
                    {t.description}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
