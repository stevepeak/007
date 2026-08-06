# 5 — Webhook + cron triggers

**Impact: High · Effort: S–M · Status: `periodic`/cron shape exists; nothing is
wired to actually fire, and `webhook` is absent.**

Real-world automation needs runs to start from the outside world, not just a
manual click or a host event call. Two trigger modes:

1. **Cron / schedule** — recurring runs on a cron expression. *Schema exists,
   firing does not.*
2. **Webhook** — a unique inbound URL per published workflow that starts a run
   from an HTTP POST, with signature verification. *Entirely missing.*

Both are trivial on Cloudflare (Cron Triggers, a Worker route) — the SDK just
needs to close the loop.

## Current state (audit)

- **Cron: ~40% done.** `engine/trigger-registry.ts` defines
  `PERIODIC_TRIGGER_KIND = 'periodic'`, `triggerModeOf`, and
  `resolveTriggerInput` (periodic → `{}`). `engine/graph-schema.ts`'s trigger
  node carries `config.cron` and refines that a periodic trigger requires a cron.
  **Missing:** any Cloudflare `scheduled()` handler that reads due schedules and
  calls `startGraphRun` (`grep 'scheduled('` → none).
- **Webhook: 0%.** No `webhook` trigger kind, no inbound route (`grep webhook`
  → none).

## Plan

### A. Cron firing

The schema is ready; wire the tick:

- **Where schedules live:** a published workflow whose trigger is `periodic`
  carries its `cron` on the trigger node. On publish, index active periodic
  workflows so the scheduler handler can find due ones without scanning every
  version. A small `wf_schedule` table (or a query over
  `wf_workflow_assignment` + version graph) keyed by `(workflow_version_id,
  cron, next_run_at)`.
- **The handler:** add a Cloudflare `scheduled()` export in the host Worker
  (SDK provides the helper `runDueSchedules(env, now)` that the host's
  `scheduled()` calls). It finds due schedules and calls the existing
  `startGraphRun(env, { workflowVersionId, triggerKind: 'periodic',
  triggerInput: {} })` for each.
- **Determinism:** the orchestrator still can't use `Date.now()`; the *tick time*
  is an input supplied by the `scheduled()` event (`event.scheduledTime`), passed
  into `runDueSchedules` — never read inside the workflow.
- Cron parsing: use `event.cron` matching against registered schedules, or a
  tiny cron matcher; timezone handling is a config field on the schedule.

### B. Webhook trigger

- **New trigger mode.** Add `WEBHOOK_TRIGGER_KIND = 'webhook'` to
  `RESERVED_TRIGGER_KINDS` in `engine/trigger-registry.ts`, extend
  `TriggerMode`/`triggerModeOf`, and in `resolveTriggerInput` pass the parsed
  request body through (optionally validated against a host-declared schema, like
  events).
- **Inbound route.** The SDK provides `handleWebhook(req, env)` the host mounts
  at e.g. `POST /wf/hooks/:token`:
  - Resolve `:token` → the target published workflow (a stable per-workflow
    webhook token; store in a `wf_webhook` row: `token`, `workflow_version_id`,
    `secret`, `enabled`).
  - Verify the signature/secret (HMAC of the body) before doing anything.
  - Call `startGraphRun(env, { workflowVersionId, triggerKind: 'webhook',
    triggerInput: body })`.
  - Return `{ runId }` (or 202) so the caller can watch the run.
- **Idempotency:** accept an idempotency key header and dedupe run starts (webhook
  sources are at-least-once) — pairs with the reliability work.

### C. UI

- Trigger node inspector: for `periodic`, a cron builder + timezone; for
  `webhook`, show the generated URL + secret with a copy button and an
  enable/disable toggle and "rotate secret".
- These slot into the existing creation flow that already lists trigger events
  (`describeTriggerEvents`).

## Effort & risks

- **A (cron): S–M** — schema done; the schedule index + `scheduled()` helper is
  the work. Biggest care point is the schedule lookup staying cheap.
- **B (webhook): S–M** — one route + one table + signature verify.
- Risk: security — webhook signature verification is mandatory; never start a run
  from an unauthenticated hook. Secret storage goes through the host secret store,
  not plaintext in `wf_*`.
- Risk: don't let a misconfigured cron stampede — cap concurrent scheduled starts
  per workflow (ties to rate-limit work in [01](./01-execution-policy.md)).

## Acceptance criteria

- A published workflow with a `periodic` trigger and `cron: '0 * * * *'` starts a
  run each hour via the host `scheduled()` handler, with no manual action.
- `POST /wf/hooks/<token>` with a valid signature starts a run whose trigger
  input is the request body and returns the `runId`; an invalid signature is
  rejected with 401 and starts nothing.
- Re-delivering the same webhook with the same idempotency key does not start a
  second run.
