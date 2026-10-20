import type { RunFlags } from './config'
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

export type StartGraphRunInput = RunFlags & {
  workflowVersionId: string
  triggerKind: string
  triggerInput: unknown
  subjectId?: string
  correlationId?: string
  /**
   * The host principal this run acts for (a user id), opaque to the SDK exactly
   * like `subjectId`/`correlationId`. Persisted to `wf_run.actor_id` and used to
   * attribute the run's Sentry spans, so a failed run says WHO it belonged to
   * without a host DB join. Omit for unattended runs (cron, ingest, evals).
   */
  actorId?: string
  /**
   * Opaque host scope for this run, carried verbatim to `buildRunDeps`.
   *
   * The SDK never reads a key and never assigns meaning to one: this is the
   * escape hatch for host scope that isn't identity, and so has no business
   * being squeezed into `subjectId`/`correlationId`/`actorId`. A host with a
   * tenant (a firm, a workspace) puts it here; 007 itself stays
   * single-workspace.
   *
   * A map rather than one more named field, so the NEXT host scope is a key
   * instead of another release of this package.
   *
   * Carried in `GraphWorkflowParams`, which both engines persist themselves, so
   * it survives a resume without a `wf_run` column. Add a column only if a
   * scope ever needs to be QUERIED (filtering the runs explorer by firm) — the
   * three identity columns exist for listing and authorization, not for resume.
   */
  hostContext?: Record<string, string>
  promptVariables?: Record<string, string | undefined>
  /** Marks the produced `wf_run` as eval-owned (hidden from the Runs explorer). */
  isEval?: boolean
  /**
   * Run-scoped step policy layered onto every node's own, TIGHTENING only.
   * Bounds what this one run may spend without touching the published graph —
   * eval runs pass `EVAL_NODE_EXECUTION` so a failing node reports in minutes
   * instead of exhausting the 20-minute AI default four times over.
   */
  executionOverride?: NodeExecution
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
