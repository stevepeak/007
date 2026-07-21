import { rehydrateBlobRefs } from './blob-ref'
import type {
  BlobRefResolver,
  ImageRefResolver,
  ModelFactory,
} from './config'
import type { WfRunManifestEntry } from './graph'
import { executeAgentNode } from './nodes/agent'
import { executeAggregateNode } from './nodes/aggregate'
import { executeBranchNode } from './nodes/branch'
import { executeFeatureRequestNode } from './nodes/feature-request'
import {
  executeSubgraph,
  resolveIterationList,
  runIteration,
} from './nodes/iteration'
import { executeRaceNode } from './nodes/race'
import { executeSwitchNode } from './nodes/switch'
import { executeToolNode } from './nodes/tool'
import { executeWorkflowNode } from './nodes/workflow'
import type { RunRecorder } from './run-recorder'
import type { ExecuteInstruction } from './scheduler'
import type { StreamSink } from './stream-sink'
import type { ToolRegistry } from './tool-registry'

// Recorder-free, scheduler-free node dispatch. This is the shared seam between
// the in-process executor and the Cloudflare `GraphWorkflow`: each backend owns
// durability (inline await vs `step.do`) and persistence (the recorder), while
// `runNode` owns node semantics. Keeping it pure means the two backends can't
// drift in what a node *does*.

export type NodeRunResult = {
  /** Fed to `scheduler.report()` → becomes downstream input. */
  schedulerOutput: unknown
  /** Persisted to the run-step row's `output`. */
  recordedOutput: unknown
  meta?: unknown
  /**
   * Decision nodes only (branch/switch) — the routing decision that selects
   * the live outgoing edge. A branch emits 'yes'|'no'; a switch emits a case
   * key or 'default'. Matched against `edge.condition`.
   */
  branchResult?: string
  branchReasoning?: string
}

export type RunNodeContext<TDeps> = {
  getModel: ModelFactory
  toolRegistry: ToolRegistry<TDeps>
  toolDeps: TDeps
  /** Live node-output cache (from `scheduler.getOutputs()`) for tool refs. */
  nodeOutputs: Map<string, unknown>
  promptVariables?: Record<string, string | undefined>
  /** Frozen run manifest — resolves agent nodes' `promptId` to a template. */
  manifest?: WfRunManifestEntry[]
  sink?: StreamSink
  /**
   * Host blob-ref resolver (from `WfSdkConfig.resolveBlobRef`). When present,
   * agent/tool node inputs that resolve to a {@link WfBlobRef} are rehydrated to
   * their real value before the node runs. Omitted → refs pass through as-is.
   */
  resolveBlobRef?: BlobRefResolver<TDeps>
  /**
   * Host image-ref resolver (from `WfSdkConfig.resolveImageRef`). When present,
   * an agent node's `imageInputs` that resolve to a {@link WfBlobRef} are read
   * to model-ready images inside the node's step. Omitted → image-ref inputs
   * throw (a text-only run wires none).
   */
  resolveImageRef?: ImageRefResolver<TDeps>
  /** Eval signal — under simulate, side-effecting tools are neutralized. */
  simulate?: boolean
  /** Canned tool outputs consumed under `simulate`, keyed by tool id. */
  fixtures?: Record<string, unknown>
  /**
   * When set, an iteration node records each inner subgraph node once per item
   * (scoped by the container id + item index) through this recorder, so the run
   * viewer can drill into an individual item's trace. Omitted → iteration still
   * runs, but only its single aggregate step is persisted (by the backend).
   */
  subStepRecorder?: RunRecorder
}

export async function runNode<TDeps>(
  instruction: ExecuteInstruction,
  ctx: RunNodeContext<TDeps>,
): Promise<NodeRunResult> {
  const node = instruction.node
  const input = instruction.input

  // Bind the host blob resolver to this run's deps once — agent/tool nodes use
  // it to rehydrate any blob-ref input inside their own step. Undefined when the
  // host declares no resolver (no tool spills large values).
  const rehydrate = ctx.resolveBlobRef
    ? (value: unknown) =>
        rehydrateBlobRefs(value, (ref) =>
          ctx.resolveBlobRef!(ref, ctx.toolDeps),
        )
    : undefined

  // Bind the host image resolver to this run's deps, mirroring `rehydrate`.
  const resolveImage = ctx.resolveImageRef
    ? (ref: Parameters<typeof ctx.resolveImageRef>[0]) =>
        ctx.resolveImageRef!(ref, ctx.toolDeps)
    : undefined

  switch (node.kind) {
    case 'agent': {
      const r = await executeAgentNode({
        node,
        input,
        getModel: ctx.getModel,
        toolRegistry: ctx.toolRegistry,
        toolDeps: ctx.toolDeps,
        sink: ctx.sink,
        promptVariables: ctx.promptVariables ?? {},
        nodeOutputs: ctx.nodeOutputs,
        manifest: ctx.manifest ?? [],
        rehydrate,
        resolveImage,
        simulate: ctx.simulate,
        fixtures: ctx.fixtures,
      })
      return {
        schedulerOutput: r.output,
        recordedOutput: r.output,
        meta: r.meta,
        // A YES/NO agent routes its outgoing yes/no edges like a Branch. Its
        // output still flows downstream unchanged (unlike branch/switch, which
        // pass their input through) — the `{ answer, reason }` is the value.
        branchResult: r.decision,
        branchReasoning: r.decisionReasoning,
      }
    }
    case 'tool': {
      const r = await executeToolNode({
        node,
        nodeOutputs: ctx.nodeOutputs,
        toolRegistry: ctx.toolRegistry,
        toolDeps: ctx.toolDeps,
        rehydrate,
        simulate: ctx.simulate,
        fixtures: ctx.fixtures,
      })
      return {
        schedulerOutput: r.output,
        recordedOutput: r.output,
        meta: r.meta,
      }
    }
    case 'branch': {
      // A Branch does NOT forward data — its output IS its decision
      // (`{ result, reasoning }`), so a downstream ref to a Branch yields the
      // boolean it decided. Nodes that need the pre-Branch data ref the producer
      // directly (all past outputs stay globally accessible). The yes/no comes
      // from a code predicate and still routes the outgoing yes/no edges.
      const r = executeBranchNode({ node, input, nodeOutputs: ctx.nodeOutputs })
      const decision = { result: r.result, reasoning: r.reasoning }
      return {
        schedulerOutput: decision,
        recordedOutput: decision,
        branchResult: r.result,
        branchReasoning: r.reasoning,
      }
    }
    case 'switch': {
      // Multi-way sibling of `branch`: like Branch it emits its decision
      // (`{ result, reasoning }`, where result is the winning case key or
      // 'default') rather than forwarding its input, and routes its case edges.
      const r = executeSwitchNode({ node, input })
      const decision = { result: r.result, reasoning: r.reasoning }
      return {
        schedulerOutput: decision,
        recordedOutput: decision,
        branchResult: r.result,
        branchReasoning: r.reasoning,
      }
    }
    case 'workflow': {
      // Call another workflow inline: its frozen graph runs as a subgraph and
      // its Output value becomes this node's output. The same `ctx` threads
      // through, so the callee's nodes (including nested workflow/agent nodes)
      // resolve against the identical model factory, tools, and manifest.
      const r = await executeWorkflowNode({ node, input, ctx })
      return {
        schedulerOutput: r.output,
        recordedOutput: r.output,
        meta: r.meta,
      }
    }
    case 'feature-request': {
      const r = await executeFeatureRequestNode({ node, input })
      return {
        schedulerOutput: r.output,
        recordedOutput: r.output,
        meta: r.meta,
      }
    }
    case 'race': {
      // First-to-finish join. The Scheduler already resolved `input` to the
      // winning upstream's output (single value); the node just passes it
      // through so downstream nodes consume the winner unchanged.
      const r = await executeRaceNode({ node, input })
      return {
        schedulerOutput: r.output,
        recordedOutput: r.output,
      }
    }
    case 'aggregate': {
      // Wait-for-all fan-in join. The Scheduler already resolved `input` to the
      // ordered list of every producer's output (one element each); the node
      // just passes that list through so a downstream sibling can iterate it.
      const r = await executeAggregateNode({ node, input })
      return {
        schedulerOutput: r.output,
        recordedOutput: r.output,
        meta: r.meta,
      }
    }
    case 'iteration': {
      // Fan the input list out over the embedded subgraph, running each item
      // inline. `runIteration` owns concurrency, stop-on-error, and ordered
      // collection; the node's output is the array of per-item results. The
      // durable Cloudflare backend drives iteration itself (each item its own
      // top-level `step.do`) rather than through this inline path, because
      // `step.do` calls cannot nest inside another step.
      const r = await runIteration({
        node,
        // The list is a ref into an upstream node's output, resolved against the
        // run's global outputs — not read out of the forwarded input.
        list: resolveIterationList(node, ctx.nodeOutputs),
        runItem: (item, index) =>
          executeSubgraph(
            node.config.subgraph,
            item,
            ctx,
            ctx.subStepRecorder
              ? {
                  recorder: ctx.subStepRecorder,
                  parentNodeId: node.id,
                  itemIndex: index,
                }
              : undefined,
          ),
      })
      return {
        schedulerOutput: r.results,
        recordedOutput: r.results,
        meta: r.meta,
      }
    }
    default: {
      // Trigger/Output are handled by the driver loop — landing here means the
      // graph schema is wider than runNode expects.
      const unexpected = node as { kind: string; id: string }
      throw new Error(
        `Unhandled node kind '${unexpected.kind}' for node ${unexpected.id}.`,
      )
    }
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
