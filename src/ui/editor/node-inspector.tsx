import type { ComponentType } from 'react'

import type { WorkflowNode } from '../../engine'
import { useWfComponents } from '../context'
import {
  BranchInspector,
  IterationInspector,
  SwitchInspector,
} from './node-inspector-control-flow'
import {
  AgentInspector,
  AggregateInspector,
  FeatureRequestInspector,
  NoteInspector,
  RaceInspector,
  ToolInspector,
  TriggerInspector,
  WorkflowInspector,
} from './node-inspector-sections'
import { field, type NodeInspectorProps } from './node-inspector-shared'

export type { NodeInspectorProps } from './node-inspector-shared'

// Per-kind config editor for the selected node. Uses injected primitives so it
// themes with the host; model/tool choices come from the data client. Advanced
// fields (agent outputSchema, tool arg bindings) are left as-is on the node and
// round-trip unchanged — a later pass can add rich editors for them.

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
    <div className="flex h-full w-80 flex-col gap-4 overflow-y-auto border-l border-border p-4">
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
