import { resolveBinding } from '../binding'
import {
  workflowFromManifest,
  type WfEngine,
  type WfWorkflowManifestEntry,
  type WorkflowCallNode,
} from '../graph'
import type { RunNodeContext } from '../run-node'

import { executeSubgraph } from './iteration'

// The Workflow node calls another workflow and awaits its result. The callee's
// published graph was frozen into the run manifest at run start (transitively,
// so its own agents/sub-workflows are present too); here we resolve it, build the
// callee's trigger input, and hand it to whoever can actually start it.
//
// A callee is a RUN OF ITS OWN wherever a backend can start one: its own
// `wf_run` linked back to this run and this node, executing on the engine the
// CALLEE's trigger declares. The caller never chooses that engine — see the
// Workflow node's schema comment. The backend supplies that ability as
// `ctx.runChildWorkflow`; the engine itself knows nothing about instances,
// rooms, or D1.
//
// Without it the callee's graph runs inline as a subgraph through the same
// `executeSubgraph` loop iteration uses. That is the fallback for the two
// contexts that genuinely cannot spawn: a node nested inside an INLINE
// iteration item (already inside a `step.do`, where nothing may nest), and the
// bare engine in tests and the playground. The same `ctx` threads straight
// through there, so nested nodes resolve exactly as top-level ones do.

export type WorkflowNodeMeta = {
  workflowId: string
  versionId: string
  versionNumber: number
  name: string
  /** The callee's own run, when it got one — the run viewer's drill-down link. */
  childRunId?: string
  /** Which engine the callee ran on, as its own trigger declared. Absent when
   *  it ran inline as a subgraph of this node (no run of its own). */
  engine?: WfEngine
}

export type WorkflowNodeResult = {
  output: unknown
  meta: WorkflowNodeMeta
}

/**
 * Start the callee as its own run and await its answer — the backend's half of
 * a workflow-call node.
 *
 * Injected rather than implemented here because starting a run means touching
 * D1 and a platform (a Workflows instance, a Durable Object), none of which the
 * pure engine may know about. Returns the callee's Output value plus the ids
 * that let a reader open its trace.
 */
export type ChildWorkflowRunner = (args: {
  node: WorkflowCallNode
  /** The callee, resolved and frozen at run start. */
  entry: WfWorkflowManifestEntry
  /** What the callee's trigger is seeded with — see {@link buildCalleeTriggerInput}. */
  triggerInput: unknown
}) => Promise<{ output: unknown; childRunId: string; engine: WfEngine }>

// Build the callee's trigger output. With no `inputs` bindings the node's
// upstream input is passed straight through (identity, like an iteration item);
// otherwise each key/binding builds one field of a trigger-input object.
//
// Exported because every path that starts a callee — inline subgraph, child
// instance, child inline run — must build the SAME input. Sharing this is what
// keeps the callee's engine a choice about where the work runs rather than
// about what it receives.
export function buildCalleeTriggerInput(
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
  const triggerInput = buildCalleeTriggerInput(node, input, ctx.nodeOutputs)
  const base = {
    workflowId: entry.id,
    versionId: entry.versionId,
    versionNumber: entry.versionNumber,
    name: entry.name,
  }
  if (ctx.runChildWorkflow) {
    const child = await ctx.runChildWorkflow({ node, entry, triggerInput })
    return {
      output: child.output,
      meta: { ...base, childRunId: child.childRunId, engine: child.engine },
    }
  }
  const output = await executeSubgraph(entry.graph, triggerInput, ctx)
  return { output, meta: base }
}
