# 1 — Execution policy: fallback + rate-limit

**Impact: High · Effort: S–M · Status: retry/timeout/continue-on-error already
shipped; this doc covers the two remaining pieces + the missing UI.**

## What it is

Per-node reliability config so a run degrades gracefully instead of aborting on a
transient provider error or a rate-limit wall. Three mechanics:

1. **Retry / timeout / continue-on-error** — ✅ already built.
2. **Model / provider fallback chains** — on a provider error or 429, fall
   through to an alternate model. *Missing.*
3. **Rate limiting / concurrency caps** — per-workspace / per-provider caps so
   many concurrent runs don't blow the LLM rate limit; queue rather than drop.
   *Missing.*

## Current state (audit)

Already present — do **not** rebuild:

- `engine/graph-schema.ts` → `nodeExecutionSchema`: `continueOnError`,
  `timeoutMs`, `retries { limit, delayMs, backoff }`, attached to every node via
  `baseNode.execution`.
- `cloudflare/graph-workflow-dispatch-step-opts.ts` → `stepOptsFor()` maps that
  policy onto Cloudflare `WorkflowStepConfig`, layered over per-kind defaults
  (`AI_STEP_OPTS` for agent/workflow, `DEFAULT_STEP_OPTS` otherwise).
- `cloudflare/graph-workflow-dispatch.ts:272` honors `continueOnError` (records
  the failure, continues with `null` output; skipped for decision nodes).

Missing:

- No fallback model concept anywhere (`grep fallback` in `engine/`/`cloudflare/`
  → none).
- No rate-limit / throttle / concurrency-cap concept.
- **No inspector UI** to edit `execution` — the schema is authored-by-hand only
  (`grep execution ui/` → only unrelated matches). Retry/timeout is shipped but
  invisible to non-engineers.

## Plan

### A. Model fallback chains (engine shape + agent node)

The natural home is the **agent node** (fallback is a model concern, and
`getModel` already abstracts the provider). Two options — recommend the first:

- **Option 1 (node-level list):** extend the agent node config with
  `fallbackModelIds?: string[]`. In `nodes/agent.ts`, wrap the model call so a
  provider error or rate-limit error retries the *same* step with the next model
  in the list before surfacing. Because this is inside the node's own
  `step.do`, it's replay-safe (the whole closure re-runs on retry).
- **Option 2 (execution-policy field):** add `fallback?: { modelIds: string[] }`
  to `nodeExecutionSchema`. More generic but only agent/workflow nodes can use
  it, so Option 1 keeps the shape honest.

Implementation notes:
- Classify which errors are fallback-worthy (transient/429/5xx/provider-down) vs.
  fatal (bad request). Reuse `engine/error-detail.ts` (already does richer
  `APICallError` capture per the debug-tooling memory).
- Record which model actually answered in the step `meta` so the run viewer can
  show "fell back to X".
- Keep engine provider-agnostic: it only iterates `modelId` strings through the
  host's `getModel`; it never knows the provider.

### B. Rate limiting / concurrency caps

Cloudflare Workflows retries steps but has no built-in cross-run throttle. Two
layers:

- **In-run concurrency:** iteration already caps at `config.concurrency` (max
  20). Add an optional **run-level** concurrency ceiling on parallel agent
  branches if profiling shows fan-out bursts.
- **Cross-run / per-provider throttle:** this belongs at run *admission*, not in
  the orchestrator (which must stay deterministic). Options:
  - A Durable Object rate-limiter keyed by `providerId` (or workspace) that
    `startGraphRun` consults before `create()` — queue/delay when over budget.
  - Or lean on Cloudflare Queues in front of `startGraphRun` for burst
    smoothing.
- Config surface: a host-level knob in `WfSdkConfig` (e.g.
  `limits?: { perProvider?: Record<string, { rps: number }> }`), *not* a
  per-node field — rate limits are a host/provider concern, not graph authoring.

> Determinism guard: do **not** read a token-bucket inside the orchestrator loop
> or inside `step.do` in a way that changes the walk. Admission control happens
> *before* the workflow instance is created.

### C. Inspector UI for execution policy (the quick win)

Surface the already-working retry/timeout/continue-on-error in the node
inspector:

- Add an "Execution" section to the node inspector (in `ui/editor/`) rendering
  `execution` via the existing AutoForm-over-JSON-Schema stack
  (`ui/autoform`) — the schema is already zod, so a JSON-Schema projection is
  cheap.
- Fields: continue-on-error toggle, timeout (ms), retry limit + backoff select.
- Add fallback-model multiselect (reuse `ModelSelect`) once (A) lands.

## Effort & risks

- **C (UI): S** — pure surfacing of shipped behavior; highest impact-to-effort.
- **A (fallback): S–M** — localized to `nodes/agent.ts` + error classification.
- **B (rate-limit): M** — new DO or Queue; the design (admission vs orchestrator)
  is the only real risk. Ship A+C first; B only when burst limits actually bite.

## Acceptance criteria

- An agent node with `fallbackModelIds: ['a','b']` whose primary 429s completes
  using `b`, and the run step records which model answered.
- Editing retry/timeout/continue-on-error in the inspector round-trips through
  draft → publish → run and changes real `step.do` behavior.
- A burst of N concurrent runs against one provider stays under its rate limit
  (queued, not dropped) with B enabled.
