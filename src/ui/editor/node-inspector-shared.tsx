import { Workflow, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

import type {
  JsonSchema,
  WorkflowGraph,
  WorkflowNode,
} from '../../engine'
import type { ToolOption, WfWorkflowSummary } from '../../server/protocol'
import { cn } from '../cn'
import { RichSelect } from '../rich-select'
import { ToolIcon } from '../tool-icon'

export type NodeInspectorProps = {
  node: WorkflowNode
  graph: WorkflowGraph
  onChange: (next: WorkflowNode) => void
  /** When the node is inside an iteration, the element schema of the loop's
   * list — so its inputs can bind to the current `Item`'s fields. */
  itemSchema?: JsonSchema
  /** The node lives inside an iteration's subgraph. Only top-level dispatch
   * emits progress notes (see `emitNodeStartProgress` in engine/executor.ts),
   * so a subgraph child can never reach the user — the Inform user control is
   * disabled for it. */
  insideIteration?: boolean
  /** The id of the workflow being edited — so a Workflow node's picker can
   * exclude the current workflow (a direct self-call is always a cycle). */
  currentWorkflowId?: string
}

// Shared field className used across the per-kind inspectors.
export const field = 'space-y-1'

// A uniform section heading for the inspector rail: a small uppercase label with
// an optional leading icon. Every top-level section (Inform user, Agent, Needs,
// …) uses this so the rail reads as one system instead of ad-hoc per-section
// styles.
export function SectionHeader({
  icon: Icon,
  children,
  className,
}: {
  icon?: LucideIcon
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'text-muted-foreground flex items-center gap-1.5 text-[11px] font-medium tracking-wide uppercase',
        className,
      )}
    >
      {Icon ? <Icon className="size-3.5 shrink-0" /> : null}
      {children}
    </div>
  )
}

// Wrapper that gives every inspector section the same flat rhythm: a top divider
// and consistent inner spacing. The first section omits the divider.
export function InspectorSection({
  children,
  className,
  divided = true,
}: {
  children: ReactNode
  className?: string
  divided?: boolean
}) {
  return (
    <section
      className={cn(
        'space-y-2.5',
        divided && 'border-border border-t pt-4',
        className,
      )}
    >
      {children}
    </section>
  )
}

// Workflow picker for a Workflow (call-another-workflow) node. Lists each
// callable workflow's name and description; the current workflow is filtered
// out by the caller.
export function WorkflowSelect({
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
      triggerLeading={<Workflow className="size-4 shrink-0 text-muted-foreground" />}
      renderValue={(w) => (
        <span className="min-w-0 flex-1 truncate">{w.name}</span>
      )}
      renderOption={(w) => (
        <>
          <Workflow className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-foreground">
              {w.name}
            </span>
            <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">
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
export function ToolSelect({
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
            <span className="block truncate text-sm font-medium text-foreground">
              {t.name}
            </span>
            <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">
              {t.description}
            </span>
          </span>
        </>
      )}
    />
  )
}
