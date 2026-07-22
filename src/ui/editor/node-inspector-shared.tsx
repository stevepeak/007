import { Workflow } from 'lucide-react'

import type {
  JsonSchema,
  WorkflowGraph,
  WorkflowNode,
} from '../../engine'
import type { ToolOption, WfWorkflowSummary } from '../../server/protocol'
import { RichSelect } from '../rich-select'
import { ToolIcon } from '../tool-icon'

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

// Shared field className used across the per-kind inspectors.
export const field = 'space-y-1'

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
