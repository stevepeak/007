import type { NodeExecution, WfEngine } from './graph-schema'

// What it takes to START a run, and what starting one gives back.
//
// These live in the engine layer, not next to `startGraphRun` in `./cloudflare`,
// because they are the SDK's PUBLIC VOCABULARY for kicking off a graph — a host
// that puts a service boundary between its caller and its Worker types the wire
// with them, and pulling them from `./cloudflare` would drag `D1Database` /
// `DurableObjectNamespace` / `Workflow` into that host's typecheck for nothing.
// Neither shape names a Cloudflare type; only the *function* does. It stays in
// `./cloudflare` and re-exports these, so `@stevepeak/007/cloudflare` remains a
// complete import surface for a Worker.

export type StartGraphRunInput = {
  workflowVersionId: string
  triggerKind: string
  triggerInput: unknown
  subjectId?: string
  correlationId?: string
  promptVariables?: Record<string, string | undefined>
  /**
   * Eval signal — execute the real graph and write a real trace, but neutralize
   * side-effecting tools (write tools no-op, read tools return their `fixtures`
   * entry). Off for normal runs.
   */
  simulate?: boolean
  /** Canned tool outputs consumed under `simulate`, keyed by tool id. */
  fixtures?: Record<string, unknown>
  /**
   * Eval synthesis signal — run every agent node with an empty tool set so the
   * model answers from its seeded message history alone. See RunContext.
   */
  freezeTools?: boolean
  /** Marks the produced `wf_run` as eval-owned (hidden from the Runs explorer). */
  isEval?: boolean
  /**
   * Eval matrix override — swaps the modelId and/or system prompt on every agent
   * node for this run (the eval wrapper's single agent). See RunContext.
   */
  agentOverride?: { modelId?: string; prompt?: string }
  /**
   * Run-scoped step policy layered onto every node's own, TIGHTENING only.
   * Bounds what this one run may spend without touching the published graph —
   * eval runs pass `EVAL_NODE_EXECUTION` so a failing node reports in minutes
   * instead of exhausting the 20-minute AI default four times over.
   */
  executionOverride?: NodeExecution
  /** Optional human label for the RunRoom snapshot. */
  label?: string
  /** Resume mode: replay a prior failed run's completed steps into this run and
   * pick up at the failed node. The prior run must use the same version. */
  resumeFromRunId?: string
  /**
   * Force an execution backend for THIS run, ignoring the graph's own
   * `trigger.config.engine`. A per-run escape hatch for A/B-ing the two
   * backends against the same published version without republishing it —
   * leave it unset for normal runs.
   */
  engine?: WfEngine
}

export type StartGraphRunResult = {
  runId: string
  workflowRunId: string
  /**
   * The Cloudflare Workflows instance id, or `null` on the inline engine (no
   * instance exists — the run lives in its RunRoom). Callers poll `wf_run` by
   * `workflowRunId` either way; this is for instance-level introspection only.
   */
  instanceId: string | null
  /** Which backend actually took the run. */
  engine: WfEngine
}
