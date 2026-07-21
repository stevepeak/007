import { Workflow } from 'lucide-react'
import type { ComponentType } from 'react'

import {
  BRANCH_OPERATORS,
  MANUAL_TRIGGER_KIND,
  PERIODIC_TRIGGER_KIND,
  type JsonSchema,
  type WorkflowGraph,
  type WorkflowNode,
} from '../../engine'
import type { ToolOption, WfWorkflowSummary } from '../../server/protocol'
import { AgentSelect } from '../agent-select'
import { useWfComponents } from '../context'
import { useAgents, useTools, useTriggerEvents, useWorkflows } from '../hooks'
import {
  DataRefField,
  IterationListField,
  NodeInputsPanel,
} from './node-data-panel'
import { RichSelect } from '../rich-select'
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
  /** The id of the workflow being edited — so a Workflow node's picker can
   * exclude the current workflow (a direct self-call is always a cycle). */
  currentWorkflowId?: string
}

// Shared field/select classNames used across the per-kind inspectors.
const field = 'space-y-1'
const selectCls =
  'h-9 w-full rounded-md border border-neutral-300 bg-transparent px-2 text-sm outline-none focus:border-neutral-500'

function triggerModeLabel(triggerKind: string): string {
  if (triggerKind === MANUAL_TRIGGER_KIND) return 'Manually'
  if (triggerKind === PERIODIC_TRIGGER_KIND) return 'On a schedule'
  return 'On an event'
}

function TriggerInspector({ node, onChange }: NodeInspectorProps) {
  const { Input, Label } = useWfComponents()
  const triggerEvents = useTriggerEvents()
  if (node.kind !== 'trigger') return null
  return (
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
  )
}

function AgentInspector({
  node,
  graph,
  onChange,
  itemSchema,
}: NodeInspectorProps) {
  const { Label } = useWfComponents()
  const agents = useAgents()
  const agentOptions = agents.data ?? []
  if (node.kind !== 'agent') return null
  return (
    <>
      <div className={field}>
        <Label>Agent</Label>
        <AgentSelect
          agents={agentOptions}
          value={{
            agentId: node.config.agentId,
            version: node.config.version ?? null,
          }}
          onChange={({ agentId, version }) =>
            onChange({
              ...node,
              config: { ...node.config, agentId, version },
            })
          }
        />
      </div>
      <div className="border-t border-neutral-200" />
      <NodeInputsPanel
        node={node}
        graph={graph}
        onChange={onChange}
        itemSchema={itemSchema}
      />
    </>
  )
}

function ToolInspector({
  node,
  graph,
  onChange,
  itemSchema,
}: NodeInspectorProps) {
  const { Label } = useWfComponents()
  const tools = useTools()
  // A tool node runs a tool deterministically with bound args, so it offers
  // every registered tool — both `function` tools (built for tool nodes, e.g.
  // update_document / extract_text) and the `ai-tool` tools an agent can call.
  const toolOptions = tools.data ?? []
  if (node.kind !== 'tool') return null
  return (
    <>
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
      <div className="border-t border-neutral-200" />
      <NodeInputsPanel
        node={node}
        graph={graph}
        onChange={onChange}
        itemSchema={itemSchema}
      />
    </>
  )
}

function BranchInspector({
  node,
  graph,
  onChange,
  itemSchema,
}: NodeInspectorProps) {
  const { Input, Label } = useWfComponents()
  if (node.kind !== 'branch') return null
  return (
    <>
      <div className={field}>
        <Label>Input</Label>
        <DataRefField
          node={node}
          graph={graph}
          value={node.config.source}
          itemSchema={itemSchema}
          onChange={(source) =>
            onChange({
              ...node,
              config: { ...node.config, source },
            })
          }
        />
        <p className="text-muted-foreground text-xs">
          Connect the upstream value to test. Leave unset to test the whole
          incoming input.
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
  )
}

function SwitchInspector({ node, onChange }: NodeInspectorProps) {
  const { Input, Label } = useWfComponents()
  if (node.kind !== 'switch') return null
  return (
    <>
      <div className={field}>
        <Label>Input path</Label>
        <Input
          value={node.config.path}
          placeholder="e.g. source  ·  empty = whole input"
          onChange={(e) =>
            onChange({
              ...node,
              config: { ...node.config, path: e.target.value },
            })
          }
        />
        <p className="text-muted-foreground text-xs">
          The value at this path is matched against each case in order.
        </p>
      </div>
      <div className={field}>
        <Label>Cases</Label>
        {node.config.cases.map((c, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <Input
              value={c.key}
              placeholder="key (edge label)"
              onChange={(e) => {
                const cases = node.config.cases.map((x, j) =>
                  j === i ? { ...x, key: e.target.value } : x,
                )
                onChange({ ...node, config: { ...node.config, cases } })
              }}
            />
            <Input
              value={c.value == null ? '' : String(c.value)}
              placeholder="equals value"
              onChange={(e) => {
                const cases = node.config.cases.map((x, j) =>
                  j === i ? { ...x, value: e.target.value } : x,
                )
                onChange({ ...node, config: { ...node.config, cases } })
              }}
            />
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground shrink-0 rounded px-1.5 py-1 text-xs"
              aria-label="Remove case"
              onClick={() => {
                const cases = node.config.cases.filter((_, j) => j !== i)
                onChange({ ...node, config: { ...node.config, cases } })
              }}
            >
              ✕
            </button>
          </div>
        ))}
        <button
          type="button"
          className="border-input hover:bg-accent self-start rounded-md border px-2 py-1 text-xs"
          onClick={() =>
            onChange({
              ...node,
              config: {
                ...node.config,
                cases: [...node.config.cases, { key: '', value: '' }],
              },
            })
          }
        >
          + Add case
        </button>
      </div>
      <p className="text-muted-foreground text-xs">
        Deterministic — no model call. Each case grows an outgoing edge; a
        value matching none takes the always-present <strong>default</strong>{' '}
        edge.
      </p>
    </>
  )
}

function IterationInspector({
  node,
  graph,
  onChange,
  itemSchema,
}: NodeInspectorProps) {
  const { Input, Label } = useWfComponents()
  if (node.kind !== 'iteration') return null
  return (
    <>
      <div className={field}>
        <Label>List</Label>
        <IterationListField
          node={node}
          graph={graph}
          value={node.config.source}
          itemSchema={itemSchema}
          onSelect={(source, elemSchema) =>
            onChange({
              ...node,
              config: {
                ...node.config,
                source,
                itemSchema: elemSchema,
              },
            })
          }
        />
        <p className="text-muted-foreground text-xs">
          Drill into any upstream node's data and pick the{' '}
          <strong>list</strong> to loop over — each element becomes the{' '}
          <strong>Item</strong>. Only arrays can be selected.
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
  )
}

function WorkflowInspector({
  node,
  onChange,
  currentWorkflowId,
}: NodeInspectorProps) {
  const { Label } = useWfComponents()
  const workflows = useWorkflows()
  // A workflow can call any OTHER workflow. Exclude itself — a direct self-call
  // is always a reference cycle (deeper cycles are caught at run start).
  const workflowOptions = (workflows.data ?? []).filter(
    (w) => w.id !== currentWorkflowId,
  )
  if (node.kind !== 'workflow') return null
  return (
    <>
      <div className={field}>
        <Label>Workflow</Label>
        <WorkflowSelect
          workflows={workflowOptions}
          value={node.config.workflowId}
          onChange={(workflowId) =>
            onChange({
              ...node,
              config: { ...node.config, workflowId },
            })
          }
        />
      </div>
      <p className="text-muted-foreground text-xs">
        Runs the selected workflow's latest published version and waits for
        its result, which becomes this node's output. The upstream input is
        passed straight through as the called workflow's trigger input.
      </p>
    </>
  )
}

function FeatureRequestInspector({ node, onChange }: NodeInspectorProps) {
  const { Label, Textarea } = useWfComponents()
  if (node.kind !== 'feature-request') return null
  return (
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
  )
}

function RaceInspector({ node }: NodeInspectorProps) {
  if (node.kind !== 'race') return null
  return (
    <p className="text-muted-foreground text-xs">
      A first-to-finish join. Wire several upstream nodes into it — whichever
      completes first wins, and its output flows through unchanged. The other
      upstreams keep running, but their results are ignored. Connect inputs
      that produce the same shape of result.
    </p>
  )
}

function AggregateInspector({ node }: NodeInspectorProps) {
  if (node.kind !== 'aggregate') return null
  return (
    <p className="text-muted-foreground text-xs">
      A wait-for-all join. Wire several upstream nodes into it — once they all
      complete, their outputs are collected into a single ordered list (one
      element per upstream, in connection order). Feed that list to a sibling,
      such as an Iteration node, to process the results together.
    </p>
  )
}

function NoteInspector({ node, onChange }: NodeInspectorProps) {
  const { Label, Textarea } = useWfComponents()
  if (node.kind !== 'note') return null
  return (
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
  )
}

// Per-kind inspector dispatch, mirroring `NODE_TYPES` in node-renderers.tsx:
// each `node.kind` maps to the component that edits it. Kinds with no editable
// config (e.g. `output`) are absent, so the dispatcher renders just the shared
// header for them — the same no-op the old inlined conditional produced.
const NODE_INSPECTORS: Partial<
  Record<WorkflowNode['kind'], ComponentType<NodeInspectorProps>>
> = {
  trigger: TriggerInspector,
  agent: AgentInspector,
  tool: ToolInspector,
  branch: BranchInspector,
  switch: SwitchInspector,
  iteration: IterationInspector,
  workflow: WorkflowInspector,
  'feature-request': FeatureRequestInspector,
  race: RaceInspector,
  aggregate: AggregateInspector,
  note: NoteInspector,
}

export function NodeInspector(props: NodeInspectorProps) {
  const { node, onChange } = props
  const { Input, Label } = useWfComponents()

  const Inspector = NODE_INSPECTORS[node.kind]

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

      {Inspector ? <Inspector {...props} /> : null}
    </div>
  )
}

// Workflow picker for a Workflow (call-another-workflow) node. Lists each
// callable workflow's name and description; the current workflow is filtered
// out by the caller.
function WorkflowSelect({
  workflows,
  value,
  onChange,
}: {
  workflows: WfWorkflowSummary[]
  value: string
  onChange: (workflowId: string) => void
}) {
  return (
    <RichSelect
      options={workflows}
      value={value}
      onChange={(w) => onChange(w.id)}
      getKey={(w) => w.id}
      placeholder="Select a workflow…"
      empty="No other workflows to call yet."
      triggerLeading={<Workflow className="size-4 shrink-0 text-neutral-400" />}
      renderValue={(w) => (
        <span className="min-w-0 flex-1 truncate">{w.name}</span>
      )}
      renderOption={(w) => (
        <>
          <Workflow className="mt-0.5 size-4 shrink-0 text-neutral-400" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-neutral-900">
              {w.name}
            </span>
            <span className="mt-0.5 line-clamp-2 block text-xs text-neutral-500">
              {w.description || 'No description yet.'}
            </span>
          </span>
        </>
      )}
    />
  )
}

// Rich tool picker: shows each tool's brand icon and name (a native <select>
// can't render the inline-SVG ToolIcon).
function ToolSelect({
  tools,
  value,
  onChange,
}: {
  tools: ToolOption[]
  value: string
  onChange: (toolId: string) => void
}) {
  return (
    <RichSelect
      options={tools}
      value={value}
      onChange={(t) => onChange(t.id)}
      getKey={(t) => t.id}
      placeholder="Select a tool…"
      empty="No tools registered."
      renderValue={(t) => (
        <>
          <ToolIcon icon={t.icon} className="size-4" />
          <span className="min-w-0 flex-1 truncate">{t.name}</span>
        </>
      )}
      renderOption={(t) => (
        <>
          <ToolIcon icon={t.icon} className="mt-0.5 size-6" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-neutral-900">
              {t.name}
            </span>
            <span className="mt-0.5 line-clamp-2 block text-xs text-neutral-500">
              {t.description}
            </span>
          </span>
        </>
      )}
    />
  )
}
