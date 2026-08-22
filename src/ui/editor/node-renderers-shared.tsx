import { Handle, Position, type NodeProps } from '@xyflow/react'
import {
  AlertTriangle,
  Flag,
  Forward,
  GitBranch,
  Layers,
  Lightbulb,
  LogIn,
  LogOut,
  Repeat,
  Sparkles,
  Shuffle,
  Split,
  StickyNote,
  Workflow,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

import {
  branchOperatorTakesValue,
  type BranchOperator,
  type WorkflowNode,
} from '../../engine'
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

// Run-view only: nodeId → the agent version that node actually ran, frozen into
// the run's manifest at start. An agent node usually FLOATS to the agent's
// latest published version, so the live catalog can't answer this after the
// fact — without this the run graph would label an old run with today's version.
// Empty in the editor, where the pin (or the catalog's latest) is the truth.
const RunAgentVersionContext = createContext<ReadonlyMap<string, number>>(
  new Map(),
)

export function RunAgentVersionProvider({
  versions,
  children,
}: {
  versions: ReadonlyMap<string, number>
  children: ReactNode
}) {
  return (
    <RunAgentVersionContext.Provider value={versions}>
      {children}
    </RunAgentVersionContext.Provider>
  )
}

/** nodeId → the agent version it ran, for the surrounding run. Empty outside
 *  a run view. Returns the whole map (not one lookup) so a renderer can read it
 *  from an unconditional `useExtra` and index it later during render. */
export function useRunAgentVersions(): ReadonlyMap<string, number> {
  return useContext(RunAgentVersionContext)
}

// The node id currently highlighted from OUTSIDE the canvas — e.g. hovering a
// binding's source in the inspector illuminates that node in the graph. Provided
// around BOTH the canvas and the inspector so one side sets it and the other
// reads it. Defaults to a no-op so components work in preview/read-only trees.
const HoverHighlightContext = createContext<{
  id: string | null
  setHovered: (id: string | null) => void
}>({ id: null, setHovered: () => {} })

export function HoverHighlightProvider({ children }: { children: ReactNode }) {
  const [hovered, setHovered] = useState<string | null>(null)
  const value = useMemo(() => ({ id: hovered, setHovered }), [hovered])
  return (
    <HoverHighlightContext.Provider value={value}>
      {children}
    </HoverHighlightContext.Provider>
  )
}

// Setter for the highlighted node — call on mouse enter/leave of a source ref so
// the referenced node lights up on the canvas.
export function useHoverHighlightSetter(): (id: string | null) => void {
  return useContext(HoverHighlightContext).setHovered
}

function useIsNodeHovered(id: string): boolean {
  return useContext(HoverHighlightContext).id === id
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
  highlighted: boolean
} | null {
  const data = props.data as unknown as EditorNodeData
  const invalid = useIsNodeInvalid(props.id)
  const status = useNodeRunStatus(props.id)
  const highlighted = useIsNodeHovered(props.id)
  if (data.kind !== kind) return null
  return {
    data: data as Extract<EditorNodeData, { kind: K }>,
    invalid,
    status,
    highlighted,
  }
}

/**
 * Synthetic status for a graph node the run never reached — no step was ever
 * recorded for it. Two very different causes produce it, and neither is a
 * failure: an arm a branch routed away from, and a node with no live path into
 * it at all. Both mean the same thing to a reader ("this did not happen"), so
 * they get one treatment.
 *
 * Not a `WfRunStatus` — nothing persists it. The run page derives it for the
 * canvas once a run has settled, since before that "hasn't run" and "hasn't run
 * YET" are indistinguishable.
 */
export const NOT_RUN_STATUS = 'not-run'

/** Dimming for a node the run never reached, and for one it skipped. */
export function notRunClass(status: string | undefined): string | false {
  return (
    (status === NOT_RUN_STATUS && 'opacity-40 saturate-0') ||
    (status === 'skipped' && 'opacity-60')
  )
}

// A small corner badge marking a node's run status — sits just outside the card
// so it reads at a glance without crowding the label.
export function RunStatusDot({ status }: { status: string }) {
  const notRun = status === NOT_RUN_STATUS
  return (
    <span
      className={cn(
        'absolute -top-1 -right-1 size-2.5 rounded-full ring-2 ring-white',
        // Hollow for a node that never ran: a filled dot reads as an outcome,
        // and the whole point is that there wasn't one.
        notRun
          ? 'border border-neutral-300 bg-transparent'
          : (runStatusDotClass[status] ?? 'bg-neutral-300'),
      )}
      aria-label={notRun ? 'Status: did not run' : `Status: ${status}`}
      title={notRun ? 'did not run' : status}
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
  passthrough: {
    icon: Forward,
    accent: 'border-l-lime-400',
    label: 'Passthrough',
  },
  transform: {
    icon: Shuffle,
    accent: 'border-l-rose-400',
    label: 'Transform',
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
  highlighted,
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
  /** Illuminated from outside (e.g. hovering a binding that refs this node). */
  highlighted?: boolean
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
        notRunClass(status),
        selected && 'ring-ring ring-2 ring-offset-1',
        highlighted &&
          !selected &&
          'ring-2 ring-sky-400 ring-offset-1 wf-node-glow',
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
  highlighted,
  subtitle,
}: {
  kind: WorkflowNode['kind']
  label: string
  selected?: boolean
  invalid?: boolean
  status?: string
  /** Illuminated from outside (e.g. hovering a binding that refs this node). */
  highlighted?: boolean
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
        notRunClass(status),
        selected && 'ring-ring ring-2 ring-offset-1',
        highlighted &&
          !selected &&
          'ring-2 ring-sky-400 ring-offset-1 wf-node-glow',
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
  // A structurally-typed operator (this helper takes a loose config), so an
  // unrecognised string still prints itself rather than vanishing.
  const operator = config.operator as BranchOperator
  const name = operator.replaceAll('_', ' ')
  if (!branchOperatorTakesValue(operator)) {
    return `${subject} ${name}`
  }
  return `${subject} ${name} ${JSON.stringify(config.value ?? null)}`
}

// ── defineNode ────────────────────────────────────────────────────────────────
// Most node renderers are the same shape: an optional target handle, a NodeCard
// (or a tight NodePill for the iteration bookends), and a source handle (single,
// yes/no decision, or none). `defineNode` builds that renderer from a small spec
// so those nodes become one-line table rows instead of ~18-line copies. Nodes
// with genuinely custom canvas JSX (Iteration/Note containers, Switch's dynamic
// per-case handles) stay hand-written — folding them in would need render-prop
// escape hatches that read worse than the explicit component.

export type NodeSourceKind = 'single' | 'decision' | 'none'

export type NodeAppearance = {
  /** Overrides the kind icon (an agent shows its own icon). */
  icon?: LucideIcon
  /** Color-chip classes wrapping the override icon. */
  iconChip?: string
  /** Fully custom icon element (a tool's inline-SVG brand icon). */
  iconSlot?: ReactNode
}

type NarrowedNodeData<K extends EditorNodeData['kind']> = Extract<
  EditorNodeData,
  { kind: K }
>

export type NodeSpec<K extends EditorNodeData['kind'], E = undefined> = {
  kind: K
  /** Left-side input handle. Default true; a Trigger sets false. */
  hasTarget?: boolean
  /** Right-side output handle(s). Default 'single'; may depend on data/extra. */
  source?:
    NodeSourceKind | ((data: NarrowedNodeData<K>, extra: E) => NodeSourceKind)
  /** Card subtitle — static, or derived from the node's data (+ extra lookup).
   *  `props` is passed too so a subtitle can key off the node's id (e.g. an
   *  agent node reading the version it ran from the run context). */
  subtitle?:
    | string
    | ((
        data: NarrowedNodeData<K>,
        extra: E,
        props: NodeProps,
      ) => string | undefined)
  /** An unconditional hook for async lookups (agents/tools/workflows/events). */
  useExtra?: () => E
  /** Icon override for the card (an agent's icon, a tool's brand mark). */
  appearance?: (
    data: NarrowedNodeData<K>,
    extra: E,
  ) => NodeAppearance | undefined
  /** Render a tight pill instead of the card when non-null (iteration bookends).
   *  Handles still follow hasTarget/source. */
  pill?: (
    data: NarrowedNodeData<K>,
    props: NodeProps,
  ) => { label: string; subtitle?: string } | null
}

export function defineNode<K extends EditorNodeData['kind'], E = undefined>(
  spec: NodeSpec<K, E>,
): (props: NodeProps) => ReactNode {
  return function NodeRenderer(props: NodeProps) {
    const r = useNodeRenderer(props, spec.kind)
    // Called unconditionally — `spec.useExtra` is stable for a given component,
    // so this stays hook-safe even though `r` may be null for a mismatched kind.
    const extra = spec.useExtra?.() as E
    if (!r) return null
    const { data, invalid, status, highlighted } = r
    const source =
      typeof spec.source === 'function'
        ? spec.source(data, extra)
        : (spec.source ?? 'single')
    const subtitle =
      typeof spec.subtitle === 'function'
        ? spec.subtitle(data, extra, props)
        : spec.subtitle
    const pill = spec.pill?.(data, props) ?? null
    const appear = spec.appearance?.(data, extra)
    return (
      <>
        {(spec.hasTarget ?? true) ? (
          <Handle type="target" position={Position.Left} />
        ) : null}
        {pill ? (
          <NodePill
            kind={spec.kind}
            label={pill.label}
            selected={props.selected}
            invalid={invalid}
            status={status}
            highlighted={highlighted}
            subtitle={pill.subtitle}
          />
        ) : (
          <NodeCard
            kind={spec.kind}
            label={data.label}
            selected={props.selected}
            invalid={invalid}
            status={status}
            highlighted={highlighted}
            subtitle={subtitle}
            icon={appear?.icon}
            iconChip={appear?.iconChip}
            iconSlot={appear?.iconSlot}
          />
        )}
        {source === 'decision' ? (
          <DecisionHandles />
        ) : source === 'single' ? (
          <Handle type="source" position={Position.Right} />
        ) : null}
      </>
    )
  }
}
