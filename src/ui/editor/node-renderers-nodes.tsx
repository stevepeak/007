import {
  Handle,
  NodeResizer,
  Position,
  useReactFlow,
  type NodeProps,
} from '@xyflow/react'
import { AlertTriangle, StickyNote } from 'lucide-react'

import {
  ITERATION_ITEM_TRIGGER_KIND,
  MANUAL_TRIGGER_KIND,
  PERIODIC_TRIGGER_KIND,
  SWITCH_DEFAULT_CASE,
} from '../../engine'
import { agentColor, agentIcon } from '../agent-appearance'
import { cn } from '../cn'
import { useAgents, useTools, useTriggerEvents, useWorkflows } from '../hooks'
import { ToolIcon } from '../tool-icon'
import { NoteMarkdown } from './note-markdown'
import {
  branchConditionLabel,
  DecisionHandles,
  KIND_STYLE,
  NodeCard,
  NodePill,
  RunStatusDot,
  useNodeRenderer,
} from './node-renderers-shared'

export function TriggerNodeRenderer(props: NodeProps) {
  const r = useNodeRenderer(props, 'trigger')
  const events = useTriggerEvents()
  if (!r) return null
  const { data, invalid, status } = r
  const { triggerKind, cron } = data.config
  // Events show their human description, never the internal event kind. Until
  // the catalog loads (or for an unknown kind) we fall back to a bare 'Event'.
  const eventLabel = events.data?.find(
    (e) => e.kind === triggerKind,
  )?.description
  // The iteration `Item` bookend renders as a tiny pill so the loop container
  // stays tight; every other trigger keeps the full card.
  if (triggerKind === ITERATION_ITEM_TRIGGER_KIND) {
    return (
      <>
        <NodePill
          kind="trigger"
          label="Current item"
          selected={props.selected}
          invalid={invalid}
          status={status}
        />
        <Handle type="source" position={Position.Right} />
      </>
    )
  }
  const subtitle =
    triggerKind === MANUAL_TRIGGER_KIND
      ? 'Manual'
      : triggerKind === PERIODIC_TRIGGER_KIND
        ? `Schedule · ${cron ?? '—'}`
        : eventLabel
          ? `Event · ${eventLabel}`
          : 'Event'
  return (
    <>
      <NodeCard
        kind="trigger"
        label={data.label}
        selected={props.selected}
        invalid={invalid}
        status={status}
        subtitle={subtitle}
      />
      <Handle type="source" position={Position.Right} />
    </>
  )
}

export function AgentNodeRenderer(props: NodeProps) {
  const r = useNodeRenderer(props, 'agent')
  const agents = useAgents()
  if (!r) return null
  const { data, invalid, status } = r
  const agent = data.config.agentId
    ? (agents.data ?? []).find((a) => a.id === data.config.agentId)
    : undefined
  // A YES/NO (boolean) output agent doubles as a branch: it exposes yes/no
  // source handles and routes its outgoing edges by the answer, so the author
  // wires the two arms directly instead of dropping a separate Branch node.
  const isDecision = agent?.output?.kind === 'boolean'
  return (
    <>
      <Handle type="target" position={Position.Left} />
      <NodeCard
        kind="agent"
        label={data.label}
        selected={props.selected}
        invalid={invalid}
        status={status}
        subtitle={agent ? agent.name : 'No agent selected'}
        icon={agent ? agentIcon(agent.icon) : undefined}
        iconChip={agent ? agentColor(agent.color).chip : undefined}
      />
      {isDecision ? (
        <DecisionHandles />
      ) : (
        <Handle type="source" position={Position.Right} />
      )}
    </>
  )
}

export function ToolNodeRenderer(props: NodeProps) {
  const r = useNodeRenderer(props, 'tool')
  const tools = useTools()
  if (!r) return null
  const { data, invalid, status } = r
  const tool = data.config.toolId
    ? (tools.data ?? []).find((t) => t.id === data.config.toolId)
    : undefined
  return (
    <>
      <Handle type="target" position={Position.Left} />
      <NodeCard
        kind="tool"
        label={data.label}
        selected={props.selected}
        invalid={invalid}
        status={status}
        subtitle={tool ? tool.name : data.config.toolId || 'No tool selected'}
        iconSlot={
          tool ? (
            <ToolIcon icon={tool.icon} className="mt-0.5 size-5" />
          ) : undefined
        }
      />
      <Handle type="source" position={Position.Right} />
    </>
  )
}

function BranchNodeRenderer(props: NodeProps) {
  const r = useNodeRenderer(props, 'branch')
  if (!r) return null
  const { data, invalid, status } = r
  return (
    <>
      <Handle type="target" position={Position.Left} />
      <NodeCard
        kind="branch"
        label={data.label}
        selected={props.selected}
        invalid={invalid}
        status={status}
        subtitle={branchConditionLabel(data.config)}
      />
      <DecisionHandles />
    </>
  )
}

// Multi-way routing: one source handle per case key plus the `default`
// fallback, stacked down the right edge. Each handle's `id` is the case key, so
// xyflow lands an edge's `sourceHandle` on the arm whose `edge.condition`
// matches — the same id↔condition contract the yes/no DecisionHandles use.
function SwitchNodeRenderer(props: NodeProps) {
  const r = useNodeRenderer(props, 'switch')
  if (!r) return null
  const { data, invalid, status } = r
  const arms = [...data.config.cases.map((c) => c.key), SWITCH_DEFAULT_CASE]
  const subject = data.config.path || 'input'
  return (
    <>
      <Handle type="target" position={Position.Left} />
      <NodeCard
        kind="switch"
        label={data.label}
        selected={props.selected}
        invalid={invalid}
        status={status}
        subtitle={`${subject} → ${arms.length} route${arms.length === 1 ? '' : 's'}`}
      />
      {arms.map((key, i) => (
        <Handle
          key={key}
          type="source"
          position={Position.Right}
          id={key}
          style={{
            top: `${Math.round(((i + 1) / (arms.length + 1)) * 100)}%`,
            background:
              key === SWITCH_DEFAULT_CASE
                ? 'rgb(148, 163, 184)'
                : 'rgb(249, 115, 22)',
          }}
        />
      ))}
    </>
  )
}

// The iteration node is a resizable CONTAINER: its subgraph nodes render as React
// Flow children inside this box. The box itself carries the outer handles — the
// list flows into the left, the collected results leave the right — while the
// inner `Item`/`Result` bookend child nodes carry data across the boundary.
function IterationNodeRenderer(props: NodeProps) {
  const r = useNodeRenderer(props, 'iteration')
  const { setNodes } = useReactFlow()
  if (!r) return null
  const { data, invalid, status } = r
  const style = KIND_STYLE.iteration
  const Icon = style.icon
  return (
    <>
      <NodeResizer
        isVisible={props.selected}
        minWidth={320}
        minHeight={160}
        onResizeEnd={(_evt, params) =>
          setNodes((ns) =>
            ns.map((n) =>
              n.id === props.id
                ? {
                    ...n,
                    data: {
                      ...(n.data as Record<string, unknown>),
                      config: {
                        ...((n.data as { config: Record<string, unknown> })
                          .config ?? {}),
                        width: params.width,
                        height: params.height,
                      },
                    },
                  }
                : n,
            ),
          )
        }
      />
      <Handle type="target" position={Position.Left} />
      <div
        className={cn(
          'relative flex h-full w-full flex-col rounded-lg border border-l-4 bg-fuchsia-50/40 shadow-sm',
          invalid || status === 'failed'
            ? 'border-rose-300 border-l-rose-500 ring-1 ring-rose-300'
            : status === 'running'
              ? 'border-blue-300 border-l-blue-500 ring-1 ring-blue-200'
              : style.accent,
          status === 'skipped' && 'opacity-60',
          props.selected && 'ring-ring ring-2 ring-offset-1',
        )}
      >
        {status ? <RunStatusDot status={status} /> : null}
        <div className="flex items-center gap-2 rounded-t-lg border-b border-fuchsia-200/60 bg-white/70 px-3 py-1.5">
          <Icon className="text-muted-foreground size-4 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="text-muted-foreground text-[10px] font-medium tracking-wide uppercase">
              {style.label} · ×{data.config.concurrency}
              {data.config.stopOnError ? ' · stop on error' : ''}
            </div>
            <div className="truncate text-sm font-medium">{data.label}</div>
          </div>
          {invalid ? (
            <AlertTriangle
              className="size-4 shrink-0 text-rose-500"
              aria-label="This node has an issue"
            />
          ) : null}
        </div>
        <div className="text-muted-foreground px-3 py-1 text-[11px]">
          {data.config.source === undefined
            ? 'No list selected'
            : `for each · ${data.config.source.path || 'whole output'}`}
        </div>
      </div>
      <Handle type="source" position={Position.Right} />
    </>
  )
}

function WorkflowNodeRenderer(props: NodeProps) {
  const r = useNodeRenderer(props, 'workflow')
  const workflows = useWorkflows()
  if (!r) return null
  const { data, invalid, status } = r
  const called = data.config.workflowId
    ? (workflows.data ?? []).find((w) => w.id === data.config.workflowId)
    : undefined
  return (
    <>
      <Handle type="target" position={Position.Left} />
      <NodeCard
        kind="workflow"
        label={data.label}
        selected={props.selected}
        invalid={invalid}
        status={status}
        subtitle={called ? called.name : 'No workflow selected'}
      />
      <Handle type="source" position={Position.Right} />
    </>
  )
}

function FeatureRequestNodeRenderer(props: NodeProps) {
  const r = useNodeRenderer(props, 'feature-request')
  if (!r) return null
  const { data, invalid, status } = r
  return (
    <>
      <Handle type="target" position={Position.Left} />
      <NodeCard
        kind="feature-request"
        label={data.label}
        selected={props.selected}
        invalid={invalid}
        status={status}
        subtitle={data.config.description || 'Placeholder — passes through'}
      />
      <Handle type="source" position={Position.Right} />
    </>
  )
}

// A Race node: a first-to-finish join. Many upstreams wire into its single
// target handle; whichever finishes first wins and flows out the source handle.
function RaceNodeRenderer(props: NodeProps) {
  const r = useNodeRenderer(props, 'race')
  if (!r) return null
  const { data, invalid, status } = r
  return (
    <>
      <Handle type="target" position={Position.Left} />
      <NodeCard
        kind="race"
        label={data.label}
        selected={props.selected}
        invalid={invalid}
        status={status}
        subtitle="First upstream to finish wins"
      />
      <Handle type="source" position={Position.Right} />
    </>
  )
}

// An Aggregate node: a wait-for-all fan-in join. Many upstreams wire into its
// single target handle; once all complete it emits an ordered list (one element
// per producer) out the source handle for a sibling to iterate.
function AggregateNodeRenderer(props: NodeProps) {
  const r = useNodeRenderer(props, 'aggregate')
  if (!r) return null
  const { data, invalid, status } = r
  return (
    <>
      <Handle type="target" position={Position.Left} />
      <NodeCard
        kind="aggregate"
        label={data.label}
        selected={props.selected}
        invalid={invalid}
        status={status}
        subtitle="Collects all upstreams into a list"
      />
      <Handle type="source" position={Position.Right} />
    </>
  )
}

// A sticky note: a resizable, portless canvas annotation that renders its
// Markdown body. It has no Handles, so it can never be wired into the graph, and
// the engine never executes it. Purely a place to jot notes on the canvas.
function NoteNodeRenderer(props: NodeProps) {
  const r = useNodeRenderer(props, 'note')
  const { setNodes } = useReactFlow()
  if (!r) return null
  // A note is never executed, so its invalid/status are inert — it only needs
  // the narrowed data.
  const { data } = r
  return (
    <>
      <NodeResizer
        isVisible={props.selected}
        minWidth={160}
        minHeight={100}
        onResizeEnd={(_evt, params) =>
          setNodes((ns) =>
            ns.map((n) =>
              n.id === props.id
                ? {
                    ...n,
                    data: {
                      ...(n.data as Record<string, unknown>),
                      config: {
                        ...((n.data as { config: Record<string, unknown> })
                          .config ?? {}),
                        width: params.width,
                        height: params.height,
                      },
                    },
                  }
                : n,
            ),
          )
        }
      />
      <div
        className={cn(
          'flex h-full w-full flex-col rounded-md border border-amber-200 bg-amber-50 shadow-sm',
          props.selected && 'ring-ring ring-2 ring-offset-1',
        )}
      >
        <div className="flex items-center gap-1.5 rounded-t-md border-b border-amber-200/70 bg-amber-100/70 px-2 py-1">
          <StickyNote className="size-3.5 shrink-0 text-amber-600" />
          <div className="truncate text-[11px] font-medium text-amber-800">
            {data.label}
          </div>
        </div>
        {/* `nowheel` lets the note scroll internally without panning the canvas. */}
        <div className="nowheel min-h-0 flex-1 overflow-y-auto px-2.5 py-2 text-xs text-amber-950">
          {data.config.text.trim() ? (
            <NoteMarkdown text={data.config.text} />
          ) : (
            <span className="text-amber-500/80 italic">
              Empty note — add Markdown in the inspector.
            </span>
          )}
        </div>
      </div>
    </>
  )
}

function OutputNodeRenderer(props: NodeProps) {
  const r = useNodeRenderer(props, 'output')
  if (!r) return null
  const { data, invalid, status } = r
  // The `Result` bookend inside an iteration (a nested child has a `parentId`)
  // renders as a tiny pill; a top-level output keeps the full card.
  if (props.parentId != null) {
    return (
      <>
        <Handle type="target" position={Position.Left} />
        <NodePill
          kind="output"
          label={data.label}
          selected={props.selected}
          invalid={invalid}
          status={status}
          subtitle="Forwards the live upstream result"
        />
      </>
    )
  }
  return (
    <>
      <Handle type="target" position={Position.Left} />
      <NodeCard
        kind="output"
        label={data.label}
        selected={props.selected}
        invalid={invalid}
        status={status}
        subtitle="Forwards the live upstream result"
      />
    </>
  )
}

export {
  AggregateNodeRenderer,
  BranchNodeRenderer,
  FeatureRequestNodeRenderer,
  IterationNodeRenderer,
  NoteNodeRenderer,
  OutputNodeRenderer,
  RaceNodeRenderer,
  SwitchNodeRenderer,
  WorkflowNodeRenderer,
}
