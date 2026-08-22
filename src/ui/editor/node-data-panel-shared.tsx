import { useMemo } from 'react'

import type {
  ArgBinding,
  JsonSchema,
  WorkflowGraph,
  WorkflowNode,
} from '../../engine'
import { useAgents, useTools, useTriggerEvents, useWorkflows } from '../hooks'

import {
  accessibleData,
  buildIoMaps,
  withIterationItemSchema,
} from './node-io'

// The data-mapping surface for the inspector: the node's required inputs (each
// bindable to an upstream node's output or a literal) and a read-only tree of
// all data accessible to the node based on the graph.

// Agent (prompt variables → `inputs`), tool (arguments → `args`) and workflow
// (the callee's trigger payload → `inputs`) nodes carry per-input bindings.
export function bindingsOf(node: WorkflowNode): Record<string, ArgBinding> {
  if (node.kind === 'agent') return node.config.inputs ?? {}
  if (node.kind === 'tool') return node.config.args ?? {}
  if (node.kind === 'workflow') return node.config.inputs ?? {}
  return {}
}

export function withBinding(
  node: WorkflowNode,
  key: string,
  binding: ArgBinding | null,
): WorkflowNode {
  const next = { ...bindingsOf(node) }
  if (binding == null) delete next[key]
  else next[key] = binding
  if (node.kind === 'agent')
    return { ...node, config: { ...node.config, inputs: next } }
  if (node.kind === 'tool')
    return { ...node, config: { ...node.config, args: next } }
  if (node.kind === 'workflow')
    return { ...node, config: { ...node.config, inputs: next } }
  return node
}

// The agent node's `conversation` binding lives outside the `inputs`/`args` map
// (it resolves to a message list, not a stringified prompt var), so it has its
// own setter. Passing null clears the link — the node then falls back to the
// implicit primary-edge behavior.
export function withConversation(
  node: WorkflowNode,
  binding: ArgBinding | null,
): WorkflowNode {
  if (node.kind !== 'agent') return node
  const config = { ...node.config }
  if (binding == null) delete config.conversation
  else config.conversation = binding
  return { ...node, config }
}

// Shared hook: resolve the tool/agent/trigger metadata maps once from the data
// client (react-query caches, so calling it in more than one panel is cheap).
export function useIoMaps() {
  const tools = useTools()
  const agents = useAgents()
  const triggerEvents = useTriggerEvents()
  // Workflows come along for the Workflow node: its bindable inputs are the
  // CALLEE's trigger payload, and the callee's trigger kind rides on the list
  // item (the same query the callee picker already uses, so it's cached).
  const workflows = useWorkflows()
  return useMemo(
    () =>
      buildIoMaps(
        tools.data ?? [],
        agents.data ?? [],
        triggerEvents.data ?? [],
        workflows.data ?? [],
      ),
    [tools.data, agents.data, triggerEvents.data, workflows.data],
  )
}

// Shared hook: resolve the metadata maps (folding in the enclosing loop's `Item`
// schema) and, from them, the tree of upstream data a node can map from. Every
// data-mapping panel needs this same trio; some also read `maps` directly (e.g.
// to derive the node's own required inputs or provided output shape).
export function useAccessibleData(
  node: WorkflowNode,
  graph: WorkflowGraph,
  itemSchema?: JsonSchema,
) {
  const baseMaps = useIoMaps()
  const maps = useMemo(
    () => withIterationItemSchema(baseMaps, itemSchema),
    [baseMaps, itemSchema],
  )
  const accessible = useMemo(
    () => accessibleData(graph, node.id, maps),
    [graph, node.id, maps],
  )
  return { accessible, maps }
}
