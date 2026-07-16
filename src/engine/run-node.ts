import { rehydrateBlobRefs } from './blob-ref'
import type {
  BlobRefResolver,
  ImageRefResolver,
  ModelFactory,
} from './config'
import type { WfRunManifestEntry } from './graph'
import { executeAgentNode } from './nodes/agent'
import { executeBranchNode } from './nodes/branch'
import { executeFeatureRequestNode } from './nodes/feature-request'
import { executeSubgraph, runIteration } from './nodes/iteration'
import { executeJudgeNode } from './nodes/judge'
import { executeSwitchNode } from './nodes/switch'
import { executeToolNode } from './nodes/tool'
import { executeWorkflowNode } from './nodes/workflow'
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
   * Decision nodes only (judge/branch/switch) — the routing decision that
   * selects the live outgoing edge. Binary nodes emit 'yes'|'no'; a switch
   * emits a case key or 'default'. Matched against `edge.condition`.
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
    case 'judge': {
      const r = await executeJudgeNode({ node, input, getModel: ctx.getModel })
      // A decision node passes its input straight through as its output so
      // nodes after it see what it saw; the recorded output is the decision +
      // reasoning for the inspector.
      return {
        schedulerOutput: input,
        recordedOutput: { result: r.result, reasoning: r.reasoning },
        meta: r.meta,
        branchResult: r.result,
        branchReasoning: r.reasoning,
      }
    }
    case 'branch': {
      // Deterministic sibling of `judge`: same pass-through + decision contract,
      // but the yes/no comes from a code predicate rather than a model.
      const r = executeBranchNode({ node, input, nodeOutputs: ctx.nodeOutputs })
      return {
        schedulerOutput: input,
        recordedOutput: { result: r.result, reasoning: r.reasoning },
        branchResult: r.result,
        branchReasoning: r.reasoning,
      }
    }
    case 'switch': {
      // Multi-way sibling of `branch`: passes its input through, but the routing
      // decision is a case key (or 'default') rather than yes/no.
      const r = executeSwitchNode({ node, input })
      return {
        schedulerOutput: input,
        recordedOutput: { result: r.result, reasoning: r.reasoning },
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
    case 'iteration': {
      // Fan the input list out over the embedded subgraph, running each item
      // inline. `runIteration` owns concurrency, stop-on-error, and ordered
      // collection; the node's output is the array of per-item results. The
      // durable Cloudflare backend drives iteration itself (each item its own
      // top-level `step.do`) rather than through this inline path, because
      // `step.do` calls cannot nest inside another step.
      const r = await runIteration({
        node,
        input,
        runItem: (item) => executeSubgraph(node.config.subgraph, item, ctx),
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
