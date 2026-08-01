import type { WfSdkConfig } from '../../engine/config'
import type { AgentConfig, WorkflowGraph } from '../../engine/graph'
import type { WfDb } from '../../storage/client'
import type {
  AgentPreviewResult,
  RetryRunMode,
  ToolContextField,
  WfChangeSummary,
  WfEvalTargetKind,
  WfToolPreviewResult,
} from '../protocol'

// Server-side implementation of the data protocol. The host mounts the returned
// handler at one POST route (e.g. `app/api/wf/route.ts`) and supplies:
//   • resolveDb      — the request-scoped WfDb (from its D1 binding)
//   • resolveContext — the authenticated { userId } for attribution
// Workflows and agents are a single global set; the host gatekeeps who may
// reach this route (e.g. admins only), so the SDK itself stays auth-free.

export type WfServerContext = { userId?: string }

export type CreateWfSdkHandlersOptions<TDeps> = {
  config: Pick<
    WfSdkConfig<TDeps>,
    | 'getModel'
    | 'listModels'
    | 'listProviders'
    | 'fetchModelCatalog'
    | 'toolRegistry'
    | 'triggers'
  >
  resolveDb: (req: Request) => WfDb | Promise<WfDb>
  resolveContext: (req: Request) => WfServerContext | Promise<WfServerContext>
  /**
   * Optional: the host's live bindings (Cloudflare `env`), passed to
   * `config.getModel` so the SDK can generate publish-dialog change summaries
   * itself. The SDK owns the summarization (prompt, diff, schema, persistence);
   * the host only supplies the same model seam it already wires for agents. If
   * omitted (and no `summarizeChanges` override), summaries fall back to a
   * heuristic structural diff.
   */
  resolveEnv?: (req: Request) => unknown
  /**
   * Optional: which model the SDK summarizes changes with. Defaults to the
   * host's first offered model (`listModels()[0]`).
   */
  summaryModelId?: string
  /**
   * Optional: build a "View trace in Sentry" deep-link for a run from its stable
   * trace id. The host owns the URL shape (org slug, region, route) since only it
   * knows its Sentry config. Returns null to omit the link. Surfaced on
   * `WfRunDetail.run.sentryTraceUrl`.
   */
  sentryTraceUrl?: (traceId: string) => string | null
  /**
   * Optional override for the built-in AI summarizer — supply this only to
   * replace the SDK's summarization entirely (most hosts don't need to). Returns
   * a git-style `{ short, long }`.
   */
  summarizeChanges?: (input: {
    previousGraph: WorkflowGraph | null
    nextGraph: WorkflowGraph
    ctx: WfServerContext
    req: Request
  }) => Promise<WfChangeSummary>
  /**
   * Optional background-work scheduler. When a version is published *without* a
   * ready AI summary, the SDK uses this to generate + persist the summary after
   * the response is sent (on Cloudflare, pass `ctx.waitUntil`). If omitted, the
   * summary is simply left null until the next explicit `summarizeChanges` call.
   */
  waitUntil?: (promise: Promise<unknown>) => void
  /**
   * Optional playground runner for the agent editor — runs one agent draft in
   * isolation against a scratch input. The host supplies live bindings (`env`)
   * and typically delegates to the SDK's `executeAgentPreview` helper (per the
   * injection contract, the model + tools come from the host). If omitted, the
   * `runAgentPreview` method rejects with a "not configured" error.
   */
  runAgentPreview?: (input: {
    config: AgentConfig
    input: string
    promptVariables: Record<string, string>
    ctx: WfServerContext
    req: Request
  }) => Promise<AgentPreviewResult>
  /**
   * Optional playground runner for the tool detail page — runs one tool FOR REAL
   * against scratch args. Unlike `runAgentPreview` (which simulates tools), this
   * executes the actual tool with the host's live per-run deps, so it can hit
   * external services, incur cost, and mutate real data. The host supplies live
   * bindings (`env`) and typically delegates to the SDK's `executeToolPreview`
   * helper. If omitted, the `runToolPreview` method rejects with a "not
   * configured" error.
   */
  runToolPreview?: (input: {
    toolId: string
    args: Record<string, unknown>
    /**
     * The playground's context inputs (keyed by the `key`s declared in
     * `toolContextFields`). The host maps these into the RunContext it hands
     * `executeToolPreview` — e.g. `context.clientOrgId` → `correlationId`.
     */
    context: Record<string, string>
    ctx: WfServerContext
    req: Request
  }) => Promise<WfToolPreviewResult>
  /**
   * Optional: the context inputs the tool playground should collect before a
   * real run — the ambient scope (client, acting user, …) that a tool reads from
   * its per-run deps rather than from its AI-visible arguments. Surfaced to the
   * UI verbatim via `listToolContextFields`; the values come back through
   * `runToolPreview`'s `context` bag for the host to map into the RunContext.
   * Omit if the host's tools need no ambient context.
   */
  toolContextFields?: ToolContextField[]
  /**
   * Optional re-dispatch hook for the run viewer's Retry button. The SDK loads
   * the finished run, reconstructs its trigger input from the recorded trigger
   * step, and resolves the workflow's latest version, then hands the host a
   * ready-to-run descriptor; the host owns the actual workflow-instance start
   * (it has the runtime bindings) and returns the new run id. Modes:
   * - `restart` → start fresh on `latestVersionId` from the beginning.
   * - `resume`  → start on `originalVersionId` passing `resumeFromRunId` so the
   *   engine replays the prior run's completed steps and picks up at the failure.
   * If omitted, the `retryRun` method rejects with "not configured".
   */
  retryRun?: (input: {
    mode: RetryRunMode
    source: {
      runId: string
      workflowId: string
      /** The version the failed run executed (used by `resume`). */
      originalVersionId: string
      /** The workflow's current latest version (used by `restart`). */
      latestVersionId: string | null
      triggerKind: string
      triggerInput: unknown
      subjectId: string | null
      correlationId: string | null
    }
    ctx: WfServerContext
    req: Request
  }) => Promise<{ runId: string }>
  /**
   * Optional eval-run launcher. The SDK resolves the row, its set's target, and
   * the concrete `workflowVersionId` to run (for an agent target it creates/reuses
   * the hidden Phase-5 wrapper workflow), then hands the host a ready descriptor.
   * The host only starts the graph run — `WORKFLOWS.startGraphRun({
   * workflowVersionId, triggerKind, triggerInput, promptVariables, simulate: true,
   * isEval: true, fixtures })` — and returns the new `wf_run` id (its
   * `workflowRunId`, the id `getRun`/`gradeEvalResult` read). The host owns the
   * start because it holds the runtime bindings. If omitted, `startEvalRun`
   * rejects with "not configured".
   */
  startEvalRun?: (input: {
    evalRunId: string
    rowId: string
    target: { kind: WfEvalTargetKind; id: string }
    /** The concrete version to run — the workflow's latest, or the agent wrapper's. */
    workflowVersionId: string
    /** The trigger kind to start under (agent wrappers are always `manual`). */
    triggerKind: string
    /** The row's initial-condition trigger input (`{}` when unset). */
    triggerInput: unknown
    /** The row's initial-condition prompt variables (`{}` when unset). */
    promptVariables: Record<string, string>
    /** Canned read-tool outputs, keyed by tool id (consumed under `simulate`). */
    fixtures: Record<string, unknown>
    /**
     * Synthesis mode — run the agent with an empty tool set (the host passes this
     * into `startGraphRun` as `freezeTools`). True when the Sample was authored
     * with a seeded conversation + freeze; the `triggerInput` then already carries
     * the seeded `{ messages }`. Undefined/false → the normal tool-calling path.
     */
    freezeTools?: boolean
    /**
     * Matrix cell overrides — swap the target agent's model / system prompt for
     * this run (the host passes them into `startGraphRun` as `agentOverride`).
     * Undefined → the agent's saved value (the plain, non-matrix path).
     */
    modelId?: string
    promptBody?: string
    ctx: WfServerContext
    req: Request
  }) => Promise<{ wfRunId: string }>
  /**
   * Optional: which model `gradeEvalResult` uses for `llm_judge` checks that
   * don't pin their own `modelId`. Defaults to the host's first offered model
   * (`listModels()[0]`).
   */
  evalJudgeModelId?: string
}
