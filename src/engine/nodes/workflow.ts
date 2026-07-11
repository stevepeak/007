import { resolveBinding } from '../binding'
import { workflowFromManifest, type WorkflowCallNode } from '../graph'
import type { RunNodeContext } from '../run-node'

import { executeSubgraph } from './iteration'

// The Workflow node calls another workflow and awaits its result. The callee's
// published graph was frozen into the run manifest at run start (transitively,
// so its own agents/sub-workflows are present too); here we resolve it, build the
// callee's trigger input, and run the graph inline via the shared `executeSubgraph`
// loop. The callee's Output value is this node's output. Running inline (rather
// than spawning a separate run) mirrors the iteration node and keeps the pure
// engine free of any backend/spawn concern — the same `ctx` (model factory,
// tools, manifest, blob/image resolvers) threads straight through, so nested
// nodes resolve exactly as top-level ones do.

export type WorkflowNodeMeta = {
  workflowId: string
  versionId: string
  versionNumber: number
  name: string
}

export type WorkflowNodeResult = {
  output: unknown
  meta: WorkflowNodeMeta
}

// Build the callee's trigger output. With no `inputs` bindings the node's
// upstream input is passed straight through (identity, like an iteration item);
// otherwise each key/binding builds one field of a trigger-input object.
function buildTriggerInput(
  node: WorkflowCallNode,
  input: unknown,
  nodeOutputs: Map<string, unknown>,
): unknown {
  const entries = Object.entries(node.config.inputs)
  if (entries.length === 0) {
    return input
  }
  const obj: Record<string, unknown> = {}
  for (const [name, binding] of entries) {
    obj[name] = resolveBinding(binding, nodeOutputs, { nodeId: node.id, name })
  }
  return obj
}

export async function executeWorkflowNode<TDeps>(args: {
  node: WorkflowCallNode
  input: unknown
  ctx: RunNodeContext<TDeps>
}): Promise<WorkflowNodeResult> {
  const { node, input, ctx } = args
  const entry = workflowFromManifest(ctx.manifest ?? [], node.config.workflowId)
  if (!entry) {
    throw new Error(
      `Workflow node ${node.id} references workflow ${
        node.config.workflowId || '(none)'
      }, which is not in the run manifest.`,
    )
  }
  const triggerInput = buildTriggerInput(node, input, ctx.nodeOutputs)
  const output = await executeSubgraph(entry.graph, triggerInput, ctx)
  return {
    output,
    meta: {
      workflowId: entry.id,
      versionId: entry.versionId,
      versionNumber: entry.versionNumber,
      name: entry.name,
    },
  }
}
