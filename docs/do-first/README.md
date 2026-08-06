# "Do First" — the high-leverage 007 roadmap

Six additions that materially increase 007's power, chosen because they are
**high impact, small/medium effort, and ride infrastructure the SDK already
has** (Cloudflare Workflows/Durable Objects durability, immutable versions + run
manifest, the in-process eval executor, the tool registry, per-node step
config). The rest of the market brief is intentionally out of scope here — this
folder is only the near-term build queue.

Each feature has its own plan doc with a grounded current-state audit (what
already exists in the codebase vs. what's missing) and a concrete implementation
plan across schema / engine / runtime / storage / UI.

## The six

| # | Feature | Doc | Net-new work | Effort |
|---|---------|-----|--------------|--------|
| 1 | Execution policy — **fallback + rate-limit** (retry/timeout already done) | [01-execution-policy.md](./01-execution-policy.md) | Model fallback chains, concurrency/rate caps, inspector UI | **S–M** |
| 2 | **Interrupt / approval-gate** node (human-in-the-loop) | [02-interrupt-approval.md](./02-interrupt-approval.md) | New node kind, DO `waitForEvent`, `wf_pending_input`, run-viewer card | **M** |
| 3 | **Structured-output repair + guardrail** node | [03-output-repair-guardrails.md](./03-output-repair-guardrails.md) | Repair pass on schema-invalid output, guardrail node kind | **S–M** |
| 4 | **MCP client** support | [04-mcp-client.md](./04-mcp-client.md) | New tool source that mounts external MCP servers as tools | **M** |
| 5 | **Webhook + cron** triggers | [05-webhook-cron-triggers.md](./05-webhook-cron-triggers.md) | Wire `periodic` to CF Cron; add `webhook` trigger mode + route | **S–M** |
| 6 | **Trace-to-eval-case + local simulator** | [06-trace-to-eval-simulator.md](./06-trace-to-eval-simulator.md) | Finish "create sample from run", expose eval executor as a dev runner | **S** |

## Current-state summary (what the audit found)

Several of these are further along than the brief assumed — the highest-leverage
work is often *finishing* or *surfacing* existing plumbing, not greenfield:

- **#1 is ~60% done.** `nodeExecutionSchema` (`continueOnError`, `timeoutMs`,
  `retries{limit,delayMs,backoff}`) exists in `engine/graph-schema.ts` and is
  fully mapped to Cloudflare `WorkflowStepConfig` in
  `cloudflare/graph-workflow-dispatch-step-opts.ts`, with `continueOnError`
  honored in `graph-workflow-dispatch.ts`. **Missing:** provider/model fallback,
  rate-limit/concurrency caps, and any inspector UI to edit the policy.
- **#5 is ~40% done.** The `periodic` trigger kind + `cron` config field already
  exist in `engine/graph-schema.ts` / `engine/trigger-registry.ts`. **Missing:**
  a Cloudflare `scheduled()` handler that turns a cron tick into a run, and a
  `webhook` trigger mode + inbound route entirely.
- **#6 is ~50% done.** The in-process executor (`runWorkflowUnderConditions` in
  `eval/index.ts`) already *is* the local simulator, with `simulate`/`fixtures`
  in `RunContext`; and `ui/evals/create-sample-from-run.tsx` already starts the
  trace→eval flow. **Missing:** a first-class dev runner entry point and closing
  the run→eval-case loop end to end.
- **#2, #3, #4 are greenfield** but small because they slot into existing seams
  (the node-kind union, the tool registry, the agent output contract).

## Suggested sequencing

1. **#1 fallback + rate-limit**, **#5 webhook/cron**, **#6 trace-to-eval** first
   — each is finishing existing plumbing, highest impact-to-effort.
2. **#3 output-repair + guardrails** next — reuses the eval scorers as runtime
   validators; high value for the legal host (PII).
3. **#4 MCP client** — one integration, thousands of tools; blunts the
   connector-breadth gap.
4. **#2 interrupt/approval** — the biggest single capability unlock, slightly
   larger because it touches the scheduler's readiness model and adds a durable
   pause; do it once the smaller wins are banked.

## Cross-cutting notes

- **Determinism is the constant constraint.** Every runtime change must respect
  the invariants in the README: step names = node ids, no `Date.now()`/
  `Math.random()` in the orchestrator, all live-binding-dependent deps built
  *inside* each `step.do`. Called out per-feature where it bites.
- **Engine stays provider-agnostic.** New capabilities define a *shape* in
  `engine/` and let the Cloudflare backend / host map it — the pattern
  `nodeExecutionSchema` already models. No `cloudflare:workers` types leak into
  `engine/`.
