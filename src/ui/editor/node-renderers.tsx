import {
  Handle,
  NodeResizer,
  Position,
  useReactFlow,
  type NodeProps,
} from '@xyflow/react'
import {
  AlertTriangle,
  Flag,
  GitBranch,
  Layers,
  Lightbulb,
  LogIn,
  LogOut,
  Repeat,
  Sparkles,
  Split,
  StickyNote,
  Workflow,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import { createContext, useContext, type ReactNode } from 'react'

import {
  ITERATION_ITEM_TRIGGER_KIND,
  MANUAL_TRIGGER_KIND,
  PERIODIC_TRIGGER_KIND,
  SWITCH_DEFAULT_CASE,
  type WorkflowNode,
} from '../../engine'
import { agentColor, agentIcon } from '../agent-appearance'
import { cn } from '../cn'
import { useAgents, useTools, useTriggerEvents, useWorkflows } from '../hooks'
import { ToolIcon } from '../tool-icon'
import { NoteMarkdown } from './note-markdown'

// All editor node data is the engine node minus id+position (xyflow owns
// those). The distributive conditional preserves the discriminated union — a
// plain Omit collapses the discriminator and breaks `data.kind === 'x'`
// narrowing.
export type EditorNodeData = WorkflowNode extends infer N
  ? N extends WorkflowNode
    ? Omit<N, 'id' | 'position'>
    : never
  : never

// Set of node ids the editor has flagged as misconfigured (an error-severity
// issue). Provided around the canvas; each renderer reads it to highlight
// itself. Defaults to empty so renderers work in read-only/preview contexts.
const InvalidNodesContext = createContext<ReadonlySet<string>>(new Set())

export function InvalidNodesProvider({
  ids,
  children,
}: {
  ids: ReadonlySet<string>
  children: ReactNode
}) {
  return (
    <InvalidNodesContext.Provider value={ids}>
      {children}
    </InvalidNodesContext.Provider>
  )
}

function useIsNodeInvalid(id: string): boolean {
  return useContext(InvalidNodesContext).has(id)
}

// Per-node run status (nodeId → 'completed' | 'failed' | 'running' | 'skipped' |
// 'queued'), provided around the canvas in run-view mode so each renderer tints
// itself and shows a status dot. Empty in the editor, so renderers stay neutral.
const RunStatusContext = createContext<ReadonlyMap<string, string>>(new Map())

export function RunStatusProvider({
  statuses,
  children,
}: {
  statuses: ReadonlyMap<string, string>
  children: ReactNode
}) {
  return (
    <RunStatusContext.Provider value={statuses}>
      {children}
    </RunStatusContext.Provider>
  )
}

function useNodeRunStatus(id: string): string | undefined {
  return useContext(RunStatusContext).get(id)
}

const RUN_STATUS_DOT: Record<string, string> = {
  completed: 'bg-emerald-500',
  failed: 'bg-rose-500',
  running: 'bg-blue-500 animate-pulse',
  skipped: 'bg-neutral-300',
  queued: 'bg-amber-400',
}

// A small corner badge marking a node's run status — sits just outside the card
// so it reads at a glance without crowding the label.
function RunStatusDot({ status }: { status: string }) {
  return (
    <span
      className={cn(
        'absolute -top-1 -right-1 size-2.5 rounded-full ring-2 ring-white',
        RUN_STATUS_DOT[status] ?? 'bg-neutral-300',
      )}
      aria-label={`Status: ${status}`}
      title={status}
    />
  )
}

const KIND_STYLE: Record<
  WorkflowNode['kind'],
  { icon: LucideIcon; accent: string; label: string }
> = {
  trigger: { icon: LogIn, accent: 'border-l-emerald-400', label: 'Trigger' },
  agent: { icon: Sparkles, accent: 'border-l-violet-400', label: 'Agent' },
  tool: { icon: Wrench, accent: 'border-l-sky-400', label: 'Tool' },
  branch: { icon: GitBranch, accent: 'border-l-orange-400', label: 'Branch' },
  switch: { icon: Split, accent: 'border-l-orange-500', label: 'Switch' },
  iteration: {
    icon: Repeat,
    accent: 'border-l-fuchsia-400',
    label: 'Iteration',
  },
  workflow: {
    icon: Workflow,
    accent: 'border-l-indigo-400',
    label: 'Workflow',
  },
  'feature-request': {
    icon: Lightbulb,
    accent: 'border-l-yellow-400',
    label: 'Feature Request',
  },
  race: { icon: Flag, accent: 'border-l-teal-400', label: 'Race' },
  aggregate: {
    icon: Layers,
    accent: 'border-l-cyan-400',
    label: 'Aggregate',
  },
  note: { icon: StickyNote, accent: 'border-l-amber-300', label: 'Note' },
  output: { icon: LogOut, accent: 'border-l-zinc-400', label: 'Output' },
}

function NodeCard({
  kind,
  label,
  selected,
  invalid,
  status,
  subtitle,
  icon: IconOverride,
  iconChip,
  iconSlot,
}: {
  kind: WorkflowNode['kind']
  label: string
  selected?: boolean
  /** The node has a blocking issue — highlight it so it's obvious on canvas. */
  invalid?: boolean
  /** Run status in the run viewer — tints the card + shows a corner dot. */
  status?: string
  subtitle?: string
  /** Overrides the kind icon (e.g. an agent node shows its agent's icon). */
  icon?: LucideIcon
  /** Color-chip classes wrapping the override icon. */
  iconChip?: string
  /** Fully custom icon element (e.g. a tool's inline-SVG brand icon). */
  iconSlot?: ReactNode
}) {
  const style = KIND_STYLE[kind]
  const Icon = style.icon
  // A failed run step reads as red (same treatment as an author-time issue); a
  // running step glows blue; a skipped one dims. Completed keeps the kind accent
  // and relies on the green corner dot.
  const failed = status === 'failed'
  const running = status === 'running'
  return (
    <div
      className={cn(
        'bg-card relative rounded-md border border-l-4 shadow-sm transition-colors',
        invalid || failed
          ? 'border-rose-300 border-l-rose-500 ring-1 ring-rose-300'
          : running
            ? 'border-blue-300 border-l-blue-500 ring-1 ring-blue-200 wf-node-glow'
            : style.accent,
        status === 'skipped' && 'opacity-60',
        selected && 'ring-ring ring-2 ring-offset-1',
      )}
      style={{ minWidth: 200, maxWidth: 260 }}
    >
      {status ? <RunStatusDot status={status} /> : null}
      <div className="flex items-start gap-2 px-3 py-2">
        {iconSlot ? (
          iconSlot
        ) : IconOverride ? (
          <span
            className={cn(
              'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded',
              iconChip,
            )}
          >
            <IconOverride className="size-3.5" />
          </span>
        ) : (
          <Icon className="text-muted-foreground mt-0.5 size-4 shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          <div className="text-muted-foreground text-[10px] font-medium tracking-wide uppercase">
            {style.label}
          </div>
          <div className="truncate text-sm font-medium">{label}</div>
          {subtitle ? (
            <div className="text-muted-foreground mt-0.5 truncate text-xs">
              {subtitle}
            </div>
          ) : null}
        </div>
        {invalid ? (
          <AlertTriangle
            className="mt-0.5 size-4 shrink-0 text-rose-500"
            aria-label="This node has an issue"
          />
        ) : null}
      </div>
    </div>
  )
}

// A minimal one-row pill for the iteration bookends (the `Item` start and
// `Result` output). No uppercase kind row / subtitle — it stays tight inside the
// iteration container instead of reading as a bulky card.
function NodePill({
  kind,
  label,
  selected,
  invalid,
  status,
  subtitle,
}: {
  kind: WorkflowNode['kind']
  label: string
  selected?: boolean
  invalid?: boolean
  status?: string
  /** Shown only as a hover title so the pill stays a single line. */
  subtitle?: string
}) {
  const style = KIND_STYLE[kind]
  const Icon = style.icon
  const failed = status === 'failed'
  const running = status === 'running'
  return (
    <div
      title={subtitle}
      className={cn(
        'bg-card relative inline-flex items-center gap-1.5 rounded-full border border-l-4 px-2.5 py-1 shadow-sm transition-colors',
        invalid || failed
          ? 'border-rose-300 border-l-rose-500 ring-1 ring-rose-300'
          : running
            ? 'border-blue-300 border-l-blue-500 ring-1 ring-blue-200 wf-node-glow'
            : style.accent,
        status === 'skipped' && 'opacity-60',
        selected && 'ring-ring ring-2 ring-offset-1',
      )}
    >
      {status ? <RunStatusDot status={status} /> : null}
      <Icon className="text-muted-foreground size-3.5 shrink-0" />
      <span className="truncate text-xs font-medium">{label}</span>
      {invalid ? (
        <AlertTriangle
          className="size-3.5 shrink-0 text-rose-500"
          aria-label="This node has an issue"
        />
      ) : null}
    </div>
  )
}

function TriggerNodeRenderer(props: NodeProps) {
  const data = props.data as unknown as EditorNodeData
  const invalid = useIsNodeInvalid(props.id)
  const status = useNodeRunStatus(props.id)
  const events = useTriggerEvents()
  if (data.kind !== 'trigger') return null
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

function AgentNodeRenderer(props: NodeProps) {
  const data = props.data as unknown as EditorNodeData
  const agents = useAgents()
  const invalid = useIsNodeInvalid(props.id)
  const status = useNodeRunStatus(props.id)
  if (data.kind !== 'agent') return null
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

function ToolNodeRenderer(props: NodeProps) {
  const data = props.data as unknown as EditorNodeData
  const tools = useTools()
  const invalid = useIsNodeInvalid(props.id)
  const status = useNodeRunStatus(props.id)
  if (data.kind !== 'tool') return null
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

// Two source handles, one per condition. xyflow matches `id` to
// edge.sourceHandle so the connection lands on the right side. Used by the
// Branch renderer — it routes yes/no.
function DecisionHandles() {
  return (
    <>
      <Handle
        type="source"
        position={Position.Right}
        id="yes"
        style={{ top: '35%', background: 'rgb(34, 197, 94)' }}
      />
      <Handle
        type="source"
        position={Position.Right}
        id="no"
        style={{ top: '65%', background: 'rgb(239, 68, 68)' }}
      />
    </>
  )
}

function branchConditionLabel(config: {
  source?: { nodeId: string; path: string }
  operator: string
  value?: unknown
}): string {
  // Show the picked field path when the author drilled in, else a generic
  // 'upstream' for a whole-output ref, else 'input' for the passthrough.
  const subject = config.source?.path || (config.source ? 'upstream' : 'input')
  if (config.operator === 'is_empty' || config.operator === 'is_not_empty') {
    return `${subject} ${config.operator}`
  }
  return `${subject} ${config.operator} ${JSON.stringify(config.value ?? null)}`
}

function BranchNodeRenderer(props: NodeProps) {
  const data = props.data as unknown as EditorNodeData
  const invalid = useIsNodeInvalid(props.id)
  const status = useNodeRunStatus(props.id)
  if (data.kind !== 'branch') return null
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
  const data = props.data as unknown as EditorNodeData
  const invalid = useIsNodeInvalid(props.id)
  const status = useNodeRunStatus(props.id)
  if (data.kind !== 'switch') return null
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
  const data = props.data as unknown as EditorNodeData
  const invalid = useIsNodeInvalid(props.id)
  const status = useNodeRunStatus(props.id)
  const { setNodes } = useReactFlow()
  if (data.kind !== 'iteration') return null
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
          {data.config.itemsPath === undefined
            ? 'No list selected'
            : data.config.itemsPath
              ? `for each · ${data.config.itemsPath}`
              : 'for each item'}
        </div>
      </div>
      <Handle type="source" position={Position.Right} />
    </>
  )
}

function WorkflowNodeRenderer(props: NodeProps) {
  const data = props.data as unknown as EditorNodeData
  const workflows = useWorkflows()
  const invalid = useIsNodeInvalid(props.id)
  const status = useNodeRunStatus(props.id)
  if (data.kind !== 'workflow') return null
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
  const data = props.data as unknown as EditorNodeData
  const invalid = useIsNodeInvalid(props.id)
  const status = useNodeRunStatus(props.id)
  if (data.kind !== 'feature-request') return null
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
  const data = props.data as unknown as EditorNodeData
  const invalid = useIsNodeInvalid(props.id)
  const status = useNodeRunStatus(props.id)
  if (data.kind !== 'race') return null
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
  const data = props.data as unknown as EditorNodeData
  const invalid = useIsNodeInvalid(props.id)
  const status = useNodeRunStatus(props.id)
  if (data.kind !== 'aggregate') return null
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
  const data = props.data as unknown as EditorNodeData
  const { setNodes } = useReactFlow()
  if (data.kind !== 'note') return null
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
  const data = props.data as unknown as EditorNodeData
  const invalid = useIsNodeInvalid(props.id)
  const status = useNodeRunStatus(props.id)
  if (data.kind !== 'output') return null
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

// The `wf-` prefix keeps our custom node classNames outside xyflow's built-in
// selectors (`.react-flow__node-output` etc.), which would otherwise layer a
// 150px bordered box on top of our renderer.
const EDITOR_NODE_TYPE_PREFIX = 'wf-'

export function editorTypeForKind(kind: WorkflowNode['kind']): string {
  return `${EDITOR_NODE_TYPE_PREFIX}${kind}`
}

export const NODE_TYPES = {
  [editorTypeForKind('trigger')]: TriggerNodeRenderer,
  [editorTypeForKind('agent')]: AgentNodeRenderer,
  [editorTypeForKind('tool')]: ToolNodeRenderer,
  [editorTypeForKind('branch')]: BranchNodeRenderer,
  [editorTypeForKind('switch')]: SwitchNodeRenderer,
  [editorTypeForKind('iteration')]: IterationNodeRenderer,
  [editorTypeForKind('workflow')]: WorkflowNodeRenderer,
  [editorTypeForKind('feature-request')]: FeatureRequestNodeRenderer,
  [editorTypeForKind('race')]: RaceNodeRenderer,
  [editorTypeForKind('aggregate')]: AggregateNodeRenderer,
  [editorTypeForKind('note')]: NoteNodeRenderer,
  [editorTypeForKind('output')]: OutputNodeRenderer,
}
