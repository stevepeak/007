# Chat latency — making a 007 turn feel like claude.ai

An audit of the **interactive chat path** and the changes that would close the
perceived-speed gap with a first-class chat product.

**This folder is now anchored on the inline engine.** The `'inline'` backend
(`cloudflare/inline-run.ts`, hosted by the run's own `RunRoom` DO, selected per
graph via `trigger.config.engine`) landed after the first draft of these notes
and changed what the work is. Everything interactive runs there; everything
user-facing about a run *has* to work there.

That is not just a routing detail — it inverts the priority order:

- **The inline engine already banked the orchestration win.** No journal, no
  `enter:`/`run:`/`record:` step trio, no multi-step cold start. The old plan's
  "fast path for chat graphs" item is done, and done better than proposed —
  per-graph, any shape, one engine picker in the trigger inspector.
- **The inline engine is the only place streaming can exist.** As
  `inline-run.ts:33-36` puts it: the sink is a local call, and a token stream is
  *structurally impossible* across a `step.do` boundary whose body is journaled
  as JSON. Streaming isn't a change to "the engine" — it's an inline-engine
  feature.
- **The inline engine needs more feedback than the durable one, not less.** It
  gave up step retry, resume, and durability across eviction
  (`inline-run.ts:38-46`). When an inline run goes wrong there is no replay to
  fall back on: **the live feed and the persisted trace are the only account of
  what happened.** Feedback quality is load-bearing here in a way it never was
  when Cloudflare could just re-run the step.

So the remaining work splits into two halves: **make the inline feed fast and
rich** (items 1, 2, 4) and **close the parity gaps inline still carries** (item
3). The host chat route (item 5) is unchanged by any of it and still polls.

## Where the time goes now

For a chat turn on the inline engine:

| Phase | Cost | Status |
|-------|------|--------|
| Route pre-flight (auth, chat load, attachments, assignment) | 4 sequential D1/tRPC round-trips | **open** — [05](./05-host-path-wins.md) |
| `startGraphRun` → engine probe → `createRun` → `room.init` → `startInline` | 1 extra D1 read + 2 writes, then returns immediately | acceptable; probe read noted in [03](./03-inline-engine-parity.md) |
| Manifest freeze + `markRunRunning` + room status | 3 awaited writes, no journal | **largely solved** by inline |
| Per node | one `await`, no step trio | **solved** by inline |
| Model generation | non-streaming `generateText` — user sees nothing for the whole loop | **open, dominant** — [01](./01-token-streaming.md) |
| Feed delivery | 3 polling loops, up to 700ms tail | **open** — [02](./02-push-transport.md) |
| Per feed entry | awaited D1 insert + full-state DO `storage.put` | **open, worsens with streaming** — [04](./04-feedback-path-cost.md) |

The dominant term is still that **nothing streams**: `generateText` /
`generateObject` (`engine/nodes/agent-generation.ts:312`, `:232`) mean
time-to-first-token equals time-to-last-token, and the route delivers the answer
as a single `text-delta` (`apps/web/app/api/chat/route.ts:382`). The inline engine
removed the *overhead* around that wait; it did not remove the wait.

## The queue

| # | Change | Doc | Wins | Effort |
|---|--------|-----|------|--------|
| 1 | **Token streaming on the inline engine** — the reason inline exists | [01-token-streaming.md](./01-token-streaming.md) | TTFT: whole-turn → ~1s | **M** |
| 2 | **Push transport** — subscribe to the room that is now also the executor | [02-push-transport.md](./02-push-transport.md) | −700ms tail, −4 rt/s/user, frees a Worker per turn | **S–M** |
| 3 | **Inline parity gaps** — error detail, per-node spans, node budget, dead-run reaper | [03-inline-engine-parity.md](./03-inline-engine-parity.md) | inline failures become legible | **S** |
| 4 | **Feedback-path cost inside the room** — per-entry write amplification | [04-feedback-path-cost.md](./04-feedback-path-cost.md) | unblocks 1 at token rate | **S–M** |
| 5 | **Host path wins** — pre-flight, payload size, poll cadence | [05-host-path-wins.md](./05-host-path-wins.md) | ~0.3–1s | **S** each |

## Current-state audit

- **Inline engine: done and wired end to end.** `resolveGraphEngine`
  (`engine/graph-engine.ts:33`) probes `trigger.config.engine` with a deliberately
  loose schema; `startGraphRun` branches at `cloudflare/start-run.ts:139-142`;
  `makeRunRoom` adds `startInline` and hands the walk to `ctx.waitUntil`
  (`cloudflare/run-room.ts:238-263`); the host exports it with Sentry DO
  instrumentation (`apps/workflows/src/index.ts:75-77`). The author-facing picker
  and its trade-off copy exist (`ui/editor/node-inspector-sections.tsx:26-31`).
  Default is `'durable'` (`graph-engine.ts:27`), so nothing changed for existing
  graphs.
- **Timeout/stall visibility: done, and shared.** `resolveNodeTimeoutMs`
  (`engine/node-timeout.ts:27`) is the author's one knob for both backends;
  `modelBudgetFor` (`engine/model-budget.ts:67`) derives in-process bounds from it
  so an abort is catchable, loggable, and attributable rather than an invisible
  external kill. Inline *must* supply it (`engine/executor.ts:30-41`) — it has no
  `step.do` behind it. This is the single most important thing the inline engine
  got right, and it's why inline is safe to run unattended at all.
- **Streaming: 0% done, seam still open.** `StreamSink.append(channel, text)` is
  declared (`engine/stream-sink.ts:50`) and wired on both backends — and still has
  **no producers in the engine**. On inline it now reaches
  `RunRoomBase.append` as a *local method call* (`inline-run.ts:81-87`), not an RPC
  hop. That is the whole gap between the two backends on this feature.
- **Push transport: ~70% done, still dormant.** `RunRoomBase.fetch` upgrades a
  WebSocket via the hibernation API and sends a snapshot on connect
  (`run-room.ts:162-185`); `broadcast` fans out on every state change. Missing: a
  route that upgrades a browser, a subscription token, and a client consumer. This
  got *more* attractive with inline — the executor and the fan-out are now the same
  object, so a delta reaches a subscriber with zero hops.
- **Inline parity: four real gaps.** Provider-error detail
  (`errorFeedLine`/`errorStored`/`apiErrorDetail`), per-node Sentry spans
  (`withNodeSpan`), and `NonRetryableError` classification are referenced **only**
  from `cloudflare/graph-workflow-dispatch.ts` — the inline executor catches with a
  bare `errorMessage(err)` (`engine/executor.ts:198`). And
  `new Scheduler(deps.graph)` (`executor.ts:61`) drops the host's configured
  `limits.nodeBudget`, which the durable path passes
  (`graph-workflow.ts:172`). Details in [03](./03-inline-engine-parity.md).
- **Feed write cost: unchanged, and now more exposed.** The inline sink awaits a D1
  insert *and* a room broadcast per entry (`inline-run.ts:88-120`), and
  `RunRoomBase.appendLog` `storage.put`s the entire state object on every call
  (`run-room.ts:117-126`) — O(n²) over a run's feed. Fine for a dozen lines a
  minute; fatal at token rate. [04](./04-feedback-path-cost.md).

## Suggested sequencing

1. **#4 then #1** — in that order. Streaming lands on the feedback path, so fix the
   path's per-entry cost first or the first thing streaming does is quadratic DO
   storage writes. #4 is small and independently correct.
2. **#2** — with the executor and the fan-out in the same DO, a subscription is
   the natural delivery for #1's deltas. Land it alongside, keeping the existing
   poll as the reconnect fallback.
3. **#3** — independent, small, and the thing that makes inline failures debuggable.
   Do it early if inline is already carrying production chat traffic; the cost of
   *not* having it is paid at exactly the worst moment.
4. **#5** — opportunistic host-side cleanups. Note the chat route's bridge already
   became a real handoff (it no longer fails a healthy run on expiry), which moved
   two items: the post-turn extras now depend on request survival, and settling a
   dead run's row became an SDK responsibility (#3, Gap 4).

## Cross-cutting constraints

- **Two backends, one trace.** The stated contract is that both engines leave an
  identical `wf_run` / `wf_run_step` / `wf_run_log` trace and "the run viewer
  cannot tell them apart" (`inline-run.ts:146-150`). Every change here must hold
  that, or explicitly and visibly break it. The shared bookends
  (`engine/run-log-entries.ts`) and the shared timeout knob
  (`engine/node-timeout.ts`) are the pattern to follow: put the shape in `engine/`,
  let each backend map it.
- **Durability of a chat turn does not come from the engine.** It comes from the
  `pending` assistant placeholder (`chats.beginAgentTurn`) plus
  `chats.resumePendingTurn`. That is what makes `'inline'` an acceptable choice for
  chat despite having no resume, and it's the invariant #5's bridge work leans on.
- **Determinism still binds the durable backend.** Step names = node ids,
  replay-stable `sequence`, no `Date.now()` in the orchestrator, live bindings
  built inside each `step.do`. Inline is free of all of it — which is exactly why
  inline-only features (streaming) must not be smuggled into shared code paths in
  a way that breaks the durable one.
- **The engine stays provider-agnostic.** Streaming is a shape in `engine/` mapped
  by the backend; `getModel` stays the only provider seam.
- **Evals run on the in-process executor too.** `executeWorkflow` is shared by
  `eval/`, tests, and the playground (which pass no `resolveModelBudget` —
  `executor.ts:36-41`). Any change to it must leave those callers alone.

## How to know it worked

None of these are currently recorded. Instrument first — and now that there are
two backends, **record the engine on every measurement**: the whole point of the
per-graph picker is being able to compare, and `StartGraphRunResult.engine`
(`start-run.ts:70`) plus a null `cloudflareRunId` (the inline marker,
`inline-run.ts:200-202`) already make a run's backend identifiable after the fact.

| Metric | Definition | Today (est.) | Target |
|--------|-----------|--------------|--------|
| **TTFT** | request accepted → first `text-delta` on the wire | = full turn (10–60s) | < 1.5s |
| **Pre-model overhead** | request accepted → first provider byte | inline: ~0.6–1.5s · durable: 1.5–4s | < 500ms |
| **Tail latency** | provider's last token → client render | 350–700ms (poll) | < 100ms |
| **Round-trips in flight** | D1 + DO calls while a turn runs | ~4/s/user | ~0 (push) |
| **Writes per feed entry** | D1 inserts + DO `storage.put`s | 2 (one O(n)) | ≤1 amortized |

`startGraphRun`'s engine probe (`start-run.ts:89-101`) is an honest extra D1 read
on the start path — measure it before deciding whether to cache the resolved
engine on `wf_workflow_version`.
