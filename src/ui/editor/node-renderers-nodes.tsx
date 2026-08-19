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
import { toolChip } from '../tool-appearance'
import { ToolIcon } from '../tool-icon'
import { NoteMarkdown } from './note-markdown'
import {
  branchConditionLabel,
  defineNode,
  KIND_STYLE,
  NodeCard,
  RunStatusDot,
  useNodeRenderer,
  useRunAgentVersions,
} from './node-renderers-shared'

// Most nodes are a card with target/source handles — see `defineNode`. Only the
// three canvas-container / dynamic-handle nodes (Switch, Iteration, Note) below
// keep hand-written JSX. Look up the selected agent/tool/workflow off the live
// catalog so the card reflects renames without re-saving the graph.
function resolveAgent(
  config: { agentId?: string | null },
  agents: ReturnType<typeof useAgents>,
) {
  return config.agentId
    ? (agents.data ?? []).find((a) => a.id === config.agentId)
    : undefined
}

// An agent node needs two lookups, so its `useExtra` bundles them: the live
// agent catalog (name / icon / output contract) and — in the run viewer — the
// per-node version the run actually froze.
function useAgentNodeExtra() {
  return { agents: useAgents(), runVersions: useRunAgentVersions() }
}

type AgentNodeExtra = ReturnType<typeof useAgentNodeExtra>

function resolveTool(
  config: { toolId?: string | null },
  tools: ReturnType<typeof useTools>,
) {
  return config.toolId
    ? (tools.data ?? []).find((t) => t.id === config.toolId)
    : undefined
}

export const TriggerNodeRenderer = defineNode({
  kind: 'trigger',
  // A trigger starts the graph, so it has no input; the iteration `Item` bookend
  // renders as a tight pill so the loop container stays compact.
  hasTarget: false,
  useExtra: useTriggerEvents,
  pill: (data) =>
    data.config.triggerKind === ITERATION_ITEM_TRIGGER_KIND
      ? { label: 'Current item' }
      : null,
  subtitle: (data, events) => {
    const { triggerKind, cron, engine } = data.config
    // The Item bookend of an iteration subgraph isn't a startable trigger, so
    // it never carries an engine.
    const suffix =
      triggerKind === ITERATION_ITEM_TRIGGER_KIND || engine !== 'inline'
        ? ''
        : ' · Inline'
    if (triggerKind === MANUAL_TRIGGER_KIND) return `Manual${suffix}`
    if (triggerKind === PERIODIC_TRIGGER_KIND)
      return `Schedule · ${cron ?? '—'}${suffix}`
    // Events show their human description, never the internal event kind. Until
    // the catalog loads (or for an unknown kind) we fall back to a bare 'Event'.
    const eventLabel = events.data?.find(
      (e) => e.kind === triggerKind,
    )?.description
    return `${eventLabel ? `Event · ${eventLabel}` : 'Event'}${suffix}`
  },
})

export const AgentNodeRenderer = defineNode({
  kind: 'agent',
  useExtra: useAgentNodeExtra,
  // A YES/NO (boolean) output agent doubles as a branch: it exposes yes/no source
  // handles and routes its outgoing edges by the answer, so the author wires the
  // two arms directly instead of dropping a separate Branch node.
  source: (data, extra) =>
    resolveAgent(data.config, extra.agents)?.output?.kind === 'boolean'
      ? 'decision'
      : 'single',
  // "Legal Researcher · v4" — the version matters as much as the name, since an
  // agent node is a pointer that usually floats. See `agentNodeVersion`.
  subtitle: (data, extra, props) => {
    const agent = resolveAgent(data.config, extra.agents)
    if (!agent) return 'No agent selected'
    const version = agentNodeVersion(data.config, agent, extra, props.id)
    return version == null ? agent.name : `${agent.name} · v${version}`
  },
  appearance: (data, extra) => {
    const agent = resolveAgent(data.config, extra.agents)
    return agent
      ? { icon: agentIcon(agent.icon), iconChip: agentColor(agent.color).chip }
      : undefined
  },
})

// The version an agent node shows. In a run, the only honest answer is what the
// run froze (a floating node resolved once, at start — today's latest may be
// newer). In the editor there is no run, so it's the node's pin, or the version
// a float would resolve to right now. Null only for a never-published agent.
function agentNodeVersion(
  config: { version?: number | null },
  agent: { latestVersionNumber: number | null },
  extra: AgentNodeExtra,
  nodeId: string,
): number | null {
  return (
    extra.runVersions.get(nodeId) ?? config.version ?? agent.latestVersionNumber
  )
}

export const ToolNodeRenderer = defineNode({
  kind: 'tool',
  useExtra: useTools,
  subtitle: (data, tools) => {
    const tool = resolveTool(data.config, tools)
    return tool ? tool.name : data.config.toolId || 'No tool selected'
  },
  appearance: (data, tools) => {
    const tool = resolveTool(data.config, tools)
    return tool
      ? {
          iconSlot: (
            <span
              className={cn(
                'mt-0.5 flex size-5 shrink-0 items-center justify-center overflow-hidden rounded',
                toolChip(tool.color),
              )}
            >
              <ToolIcon
                icon={tool.icon}
                iconName={tool.iconName}
                className="size-3.5"
              />
            </span>
          ),
        }
      : undefined
  },
})

export const BranchNodeRenderer = defineNode({
  kind: 'branch',
  source: 'decision',
  subtitle: (data) => branchConditionLabel(data.config),
})

export const WorkflowNodeRenderer = defineNode({
  kind: 'workflow',
  useExtra: useWorkflows,
  subtitle: (data, workflows) => {
    const called = data.config.workflowId
      ? (workflows.data ?? []).find((w) => w.id === data.config.workflowId)
      : undefined
    return called ? called.name : 'No workflow selected'
  },
})

export const FeatureRequestNodeRenderer = defineNode({
  kind: 'feature-request',
  subtitle: (data) => data.config.description || 'Placeholder — passes through',
})

// A Passthrough node: an identity/reshape step. One or many upstreams wire into
// its target handle; it emits an author-controlled value (a single binding, an
// object built from bindings, or the forwarded input) out the source handle —
// used to give a converging branch arm the same shape as its sibling.
export const PassthroughNodeRenderer = defineNode({
  kind: 'passthrough',
  subtitle: (data) => {
    const { value, fields } = data.config
    return value
      ? `Value · ${value.kind === 'ref' ? value.path || 'whole output' : 'literal'}`
      : fields && Object.keys(fields).length > 0
        ? `Builds { ${Object.keys(fields).join(', ')} }`
        : 'Forwards input unchanged'
  },
})

// A Race node: a first-to-finish join. Many upstreams wire into its single target
// handle; whichever finishes first wins and flows out the source handle.
export const RaceNodeRenderer = defineNode({
  kind: 'race',
  subtitle: 'First upstream to finish wins',
})

// An Aggregate node: a wait-for-all fan-in join. Many upstreams wire into its
// single target handle; once all complete it emits an ordered list (one element
// per producer) out the source handle for a sibling to iterate.
export const AggregateNodeRenderer = defineNode({
  kind: 'aggregate',
  subtitle: 'Collects all upstreams into a list',
})

export const OutputNodeRenderer = defineNode({
  kind: 'output',
  // Terminal: it returns its bound upstream value, so it has no source handle.
  source: 'none',
  subtitle: 'Returns the bound value to the caller',
  // The `Result` bookend inside an iteration (a nested child has a `parentId`)
  // renders as a tiny pill; a top-level output keeps the full card.
  pill: (data, props) =>
    props.parentId != null
      ? { label: data.label, subtitle: 'Returns the bound value' }
      : null,
})

// Multi-way routing: one source handle per case key plus the `default` fallback,
// stacked down the right edge. Each handle's `id` is the case key, so xyflow
// lands an edge's `sourceHandle` on the arm whose `edge.condition` matches — the
// same id↔condition contract the yes/no DecisionHandles use.
export function SwitchNodeRenderer(props: NodeProps) {
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
export function IterationNodeRenderer(props: NodeProps) {
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
              {/* The fan-out bound belongs on the container itself: it's the one
                  iteration setting that decides whether the block runs at all. */}
              {data.config.maxItems === undefined
                ? ' · no limit'
                : ` · max ${data.config.maxItems}`}
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

// A sticky note: a resizable, portless canvas annotation that renders its
// Markdown body. It has no Handles, so it can never be wired into the graph, and
// the engine never executes it. Purely a place to jot notes on the canvas.
export function NoteNodeRenderer(props: NodeProps) {
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
