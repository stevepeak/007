import { Handle, Position, type NodeProps } from '@xyflow/react'
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

import { type WorkflowNode } from '../../engine'
import { cn } from '../cn'
import { runStatusDotClass } from '../run-status'

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

// Shared renderer preamble. Casts the xyflow node data once (the single
// `props.data` cast in this file), subscribes to the invalid + run-status
// contexts unconditionally — React forbids conditional hooks, so these always
// run — then narrows to the requested kind, returning null when this renderer
// isn't the one for the node's kind. Each renderer becomes:
//   const r = useNodeRenderer(props, 'agent')
//   if (!r) return null
//   const { data, invalid, status } = r
export function useNodeRenderer<K extends EditorNodeData['kind']>(
  props: NodeProps,
  kind: K,
): {
  data: Extract<EditorNodeData, { kind: K }>
  invalid: boolean
  status: string | undefined
} | null {
  const data = props.data as unknown as EditorNodeData
  const invalid = useIsNodeInvalid(props.id)
  const status = useNodeRunStatus(props.id)
  if (data.kind !== kind) return null
  return {
    data: data as Extract<EditorNodeData, { kind: K }>,
    invalid,
    status,
  }
}

// A small corner badge marking a node's run status — sits just outside the card
// so it reads at a glance without crowding the label.
export function RunStatusDot({ status }: { status: string }) {
  return (
    <span
      className={cn(
        'absolute -top-1 -right-1 size-2.5 rounded-full ring-2 ring-white',
        runStatusDotClass[status] ?? 'bg-neutral-300',
      )}
      aria-label={`Status: ${status}`}
      title={status}
    />
  )
}

export const KIND_STYLE: Record<
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

export function NodeCard({
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
export function NodePill({
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

// Two source handles, one per condition. xyflow matches `id` to
// edge.sourceHandle so the connection lands on the right side. Used by the
// Branch renderer — it routes yes/no.
export function DecisionHandles() {
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

export function branchConditionLabel(config: {
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
