# 3 — Inline engine: what it banked, and the parity gaps left

The inline engine (`cloudflare/inline-run.ts`, hosted by `RunRoom` via
`makeRunRoom` → `startInline`) already delivered the orchestration win this folder
originally proposed as future work. This doc records what's done, then the four
places where inline's *feedback* is worse than the durable path's — which matters
more here than anywhere else, because inline has no retry and no resume, so **the
feed and the trace are the only account of a failure.**

## What it banked

| Old proposal | Status |
|---|---|
| Fuse the 5 pre-model `step.do`s | **Superseded.** Inline has no journal at all: `getVersionGraph` → `resolveRunManifest` → `setRunManifest` → `markRunRunning` → `room.setStatus` are plain awaits (`inline-run.ts:186-204`) |
| Parallelize `enter:`'s three writes | **Superseded.** No `enter:` step; the executor records `running` + emits the bookend inline (`engine/executor.ts:128-145`) |
| "Fast path for single-agent chat graphs" | **Done, and better.** Not shape-restricted and not chat-restricted — a per-graph engine choice on the trigger node, versioned with the graph, with a per-run override for A/B (`start-run.ts:51-57`) |
| Keep the `run:`/`record:` split intact | **Preserved.** Inline records `running` then upserts the terminal row on the same `(run_id, node_id, item_index)` key — same rows, no journal |

Two design choices worth calling out as correct and load-bearing:

- **The shared timeout knob.** `resolveNodeTimeoutMs` (`engine/node-timeout.ts:27`)
  lives in `engine/` precisely so both backends can't disagree: durable hands it to
  `step.do` *and* derives the in-process budget from it; inline has no step, so the
  budget is its only bound (`engine/executor.ts:30-41`,
  `inline-run.ts:214-221`). One authored number, two enforcements.
- **In-process enforcement over external kill.** `model-budget.ts:1-17` explains
  why: a `step.do` timeout aborts from outside, so no catch runs, nothing lands in
  `wf_run_step.error`, and a stall is invisible by construction.
  `STEP_TIMEOUT_SLACK_MS` (`model-budget.ts:24`) guarantees the catchable abort
  wins the race. Without this, inline would be unsafe to run unattended at all —
  it's what makes the whole engine viable.

## Gap 1 — provider-error detail is lost on inline

`engine/error-detail.ts` provides `apiErrorDetail` / `errorFeedLine` /
`errorStored`, which surface an `APICallError`'s status code and provider response
body — the part that says *why* (rate limited, payment required, bad model id).
They are referenced **only** from `cloudflare/graph-workflow-dispatch.ts:189-203`.

The inline executor catches with a bare `errorMessage(err)`
(`engine/executor.ts:198`), stores that in `wf_run_step.error`, and puts it in the
`✕ … failed` bookend (`engine/run-log-entries.ts:31-48`). So an inline chat run
that fails on a 402 shows a generic message where a durable ingest run shows the
provider's actual complaint.

The irony: the durable path needs that capture because **Cloudflare rebuilds an
error thrown out of `step.do`**, dropping everything but message and stack
(`graph-workflow-dispatch.ts:155-162`). Inline has no such boundary — the real
error object is right there in the catch. Inline could produce *better* detail than
durable with less machinery. It currently produces worse.

**Fix:** call `errorFeedLine(err)` / `errorStored(err)` in the inline executor's
catch. `error-detail.ts` is already engine-level and provider-agnostic, so this is
an import and two call sites, with no new abstraction.

## Gap 2 — no per-node spans on inline

`withNodeSpan` (`cloudflare/tracing.ts:55`) wraps each durable node execution in a
Sentry span, pinned into one distributed trace via `continueTrace` on the
`traceId`. It's called only from `graph-workflow-dispatch.ts:381`.

But `startGraphRun` mints that `traceId` for **every** run and stores it as
`wf_run.sentryTraceId` (`start-run.ts:103-111`) regardless of engine. So an inline
run gets a trace id, the run viewer offers a Sentry deep-link for it, and the link
leads to a trace with no spans in it. The host does wrap the DO itself
(`instrumentDurableObjectWithSentry`, `apps/workflows/src/index.ts:75-77`), so
there's a transaction — but nothing per-node, which is the granularity that makes
the feature useful.

**Fix, two options:**

1. Move the span wrapper to a backend-agnostic seam the inline executor can also
   use (an optional `wrapNode` hook on `ExecuteWorkflowDeps`, supplied by
   `inline-run.ts`, absent for evals/tests). Keeps `@sentry/cloudflare` out of
   `engine/`, consistent with the dependency direction.
2. Failing that, don't mint a `sentryTraceId` for inline runs, so the viewer stops
   offering a link that goes nowhere.

Option 1 is the real fix; option 2 is the honest stopgap. Either is better than the
current state, which promises observability it doesn't deliver.

## Gap 3 — the host's node budget is dropped inline

`graph-workflow.ts:172` constructs `new Scheduler(graphJson, config.limits?.nodeBudget)`.
`engine/executor.ts:61` constructs `new Scheduler(deps.graph)` — no second
argument, so it silently falls back to `DEFAULT_NODE_BUDGET`
(`engine/scheduler.ts:126`).

A host that raised `limits.nodeBudget` for a wide fan-out graph gets the default
when that graph runs inline, and hits `WorkflowBudgetError` where the durable run
succeeded. Same graph, same version, different outcome by engine — which
contradicts the "both backends leave an identical trace" contract
(`inline-run.ts:146-150`).

**Fix:** thread `config.limits?.nodeBudget` through `executeWorkflow`. One
argument. Also worth an assertion test that both backends refuse the same graph at
the same node count.

## Gap 4 — failure reporting has nowhere to go

`runInlineGraph` "never throws" by design: it records the failure to D1 + the room
and swallows, "because the caller is a fire-and-forget DO task with nowhere to
report to" (`inline-run.ts:152-153`). `startInline` hands the walk to
`ctx.waitUntil` and returns immediately (`run-room.ts:252-263`).

That's correct, but it means the **only** channels through which an inline failure
becomes known are `wf_run.error`, `wf_run_log`, and the room broadcast. Two
consequences:

- **Nothing in the SDK settles a run whose process died.** The nested-catch
  fallback (`inline-run.ts:241-248`) logs to console and leaves the run in whatever
  state it reached, on the assumption that "the host's poller treats a stalled run
  as failed." That is half-true, and it got weaker recently: the chat route used to
  fail a still-`running` run when its bridge expired, and now correctly hands off
  instead (`route.ts:396`, `markRunFailedIfPending` deleted). What remains is
  host-side and message-scoped — `resumePendingTurn` abandons a *placeholder* older
  than `ABANDONED_TURN_MS` (`packages/api/src/routers/chats/agent.ts:31`, the node
  timeout + 5 minutes) and writes a failure body.

  So the user stops waiting, but **`wf_run` stays `running` forever**: it pollutes
  the runs explorer, any status-keyed surface, and cost/latency aggregates, and it
  means the SDK's own record of a dead run is permanently wrong. It also relies on
  the host having built an abandonment bound at all — a different host gets a
  placeholder that spins indefinitely.

  **Fix:** a DO alarm armed when `startInline` accepts the walk and cleared on
  finalize. If it fires with the run still `running`, fail the run with a clear
  reason ("execution host died mid-walk"). That belongs in the SDK, not the host —
  it's the inline engine's own failure mode, and it's the piece that makes
  `'inline'` honest about "a run that dies mid-walk is failed, not resumable"
  (`inline-run.ts:44-46`). Right now such a run is neither.
- Sink writes are best-effort by contract (`inline-run.ts:70-72`, and each of the
  three try/catch blocks in `createInlineSink`). Correct — a dropped progress line
  must never fail the node describing itself — but on inline there is no
  `record:`-step rewrite to restore what was dropped, unlike the durable path where
  `replaceNodeLogs` re-persists the node's whole feed at terminal time. **A line
  lost on inline is lost permanently.** That's an argument for making the write
  path cheap and reliable rather than merely best-effort — see
  [04](./04-feedback-path-cost.md).

## Residual: the durable path still pays for its steps

Not urgent — the durable engine now carries background work (ingest) where
several seconds of orchestration don't matter, and correctness/resumability is
worth more. Recorded for completeness:

- Five pre-model steps remain fusible (`graph-workflow.ts:141-209`), and the three
  writes inside `enter:` remain sequential (`graph-workflow-dispatch.ts:230-243`).
- The trigger step still records its whole payload twice, as both `input` and
  `output` (`graph-workflow.ts:200-209`) — see
  [05](./05-host-path-wins.md) for why that's expensive on chat-shaped payloads.
- The `run:`/`record:` split must stay; fusing it would re-invoke the model on a
  failed record write (`graph-workflow-dispatch.ts:194-201`).

Revisit only if something interactive ever needs to run durably.

## Definition of done

- An inline node failing on a provider error shows the provider's status + body in
  the feed and in `wf_run_step.error`, matching durable.
- An inline run either has per-node spans in its trace, or doesn't advertise a
  trace link.
- The same graph accepts or refuses the same node count on both engines.
- A stalled inline run (DO died mid-walk) settles to `failed` in `wf_run` from
  inside the SDK, without depending on any host-side abandonment bound.
