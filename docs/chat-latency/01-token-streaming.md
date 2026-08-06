# 1 — Token streaming (inline engine)

**The single highest-impact change left for perceived speed.** Today
time-to-first-token equals time-to-last-token; this makes them independent.

**This is an inline-engine feature, not an engine-wide one.** The durable backend
journals each `step.do` body as JSON, so there is no way for a partial value to
leave a running step — `inline-run.ts:33-36` states this outright. Attempting
streaming on the durable path means inventing a side-channel that bypasses the
journal, which is the thing the journal exists to prevent. Inline has no such
boundary: the sink is a local method call on the DO that also owns the WebSocket
fan-out.

## Current state

| Piece | State |
|-------|-------|
| Model driver | `generateText` (tool loop, `engine/nodes/agent-generation.ts:312`) / `generateObject` (structured, `:232`) — both non-streaming |
| Per-step visibility | `onStepFinish` fires only after a *completed* round-trip; emits `thinking` / `progress` / `tool` entries |
| Heartbeat workaround | `logModelCallStart` / `logModelCallEnd` bookend the call because, per the comment at `agent-generation.ts:136-141`, dispatch and outcome are "the two moments that actually exist without streaming" |
| Budget/abort | `armTotalBudget` (`agent-generation.ts:101-123`) + the SDK's `timeout: { stepMs, toolMs }` and `abortSignal` (`:322-323`) |
| Sink text channel | `StreamSink.append(channel, text)` — declared (`engine/stream-sink.ts:50`), wired on both backends, **zero producers** |
| Inline sink | `createInlineSink` (`cloudflare/inline-run.ts:74-122`) — `append` forwards to `room.append`, a local call inside the DO |
| Room text channel | `RunRoomBase.append` pushes onto `state.progress` and `storage.put`s the **entire** state object per call (`cloudflare/run-room.ts:106-113`) |
| Host delivery | route polls to `completed`, writes one `text-delta` with the whole answer (`apps/web/app/api/chat/route.ts:367-386`) |
| Provider shim | `veniceFetch` does `res.clone().json()` to inline `reasoning_content` — needs a fully buffered body, and explicitly passes `text/event-stream` through untouched (`packages/ai-model/src/index.ts`) |

Precedent worth noting: `server/copilot/run-copilot.ts:34` already uses
`streamText().toUIMessageStreamResponse()`. The copilot streams; the graph engine
does not. Closing that asymmetry is this item.

## What to build

### a. A streaming tool loop in the engine

Add a streaming variant of `runToolLoop` behind a new
`RunAgentGenerationArgs` flag (e.g. `streamTokens?: boolean`), defaulted off so
evals, ingest, sub-agents, and the playground are untouched:

- `streamText` instead of `generateText`, same `tools`, same
  `stopWhen: stepCountIs(maxTurns)`, same `onStepFinish`, same
  `timeout` / `abortSignal` — the meta and trace shape must stay **byte-identical**
  to the non-streaming path.
- Consume `textStream` (or the `text-delta` parts of `fullStream`) and forward each
  chunk to `sink.append('tokens', chunk)`.
- `await result.text` at the end and return the same `AgentNodeResult`. The node's
  recorded output does not change — the stream is strictly additive.
- Reasoning deltas, where the provider emits them, go to a separate channel
  (`'reasoning'`) so the "Show thinking" affordance can render them without
  interleaving into the answer body. Note this is the *third* consumer of
  reasoning after the `thinking` (dev) and `progress` (user, gated on
  `informUser.reasoning`) levels — reuse the existing gating rather than adding a
  fourth toggle.

Keep `runStructuredGeneration` non-streaming: object/boolean agents produce no
user-visible prose and route decisions, so a partial object is meaningless.

**Gate it on the engine, not on the node.** The flag should be set by the inline
backend only (`inline-run.ts` passing it through `runContext` /
`resolveModelBudget`'s sibling), so a graph moved to `'durable'` degrades to
today's behavior automatically instead of silently emitting deltas nothing
delivers.

### b. Interaction with the budget guard

`armTotalBudget` aborts via a `DOMException('TimeoutError')` and the error is
tagged `TOTAL_BUDGET_OVERRUN` (`agent-generation.ts:127-134`) so the durable
dispatch can fail rather than retry. Under streaming:

- An abort mid-stream means **partial text already reached the client**. The node
  still fails, and the failure path must tell the client the answer is incomplete —
  otherwise a truncated answer renders as a finished one. Emit a terminal marker on
  the token channel, not just an `error` log entry.
- Inline has no retry (`inline-run.ts:38-42`), so the stall/overrun distinction
  that the marker exists to serve is moot there. Don't remove the marker — the
  durable path still reads it — but don't build inline logic around it either.

### c. Delta batching

A DO call per token is untenable even locally, because `append` persists. Buffer
in the node and flush on whichever comes first: ~50ms elapsed, ~64 characters, or
stream end / step boundary (always flush). This is a pure function of the buffer —
unit-test it against `createMemorySink()`.

### d. A non-persisting token channel on the room

`RunRoomBase.append` as written would `storage.put` the whole state object per
flush. Add an explicit token path that **broadcasts without persisting**:

- Keep a bounded in-memory tail for snapshot-on-connect; do not push tokens into
  `state.progress`.
- Do not write tokens to `wf_run_log`. The final answer is already persisted as
  `wf_run.output` by `finalizeRun` (`inline-run.ts:224`), so a persisted token log
  is pure duplication of the one value that *is* durable.
- Mid-stream connect gets the in-memory tail; post-eviction reconnect gets the
  authoritative answer from `wf_run.output` via the existing resume path. Both are
  already-supported cases.

This overlaps [04](./04-feedback-path-cost.md) — do 04 first and this becomes a
small addition to a path that's already been made cheap.

### e. Provider path (Venice)

`veniceFetch`'s buffered rewrite is incompatible with streaming *and* currently
passes SSE through untouched — meaning on a streaming path reasoning would be
silently dropped. Add an SSE branch that transforms the event stream, mapping
`choices[].delta.reasoning_content` into reasoning deltas as they arrive. This is
host-side (`packages/ai-model`), not SDK, but it **gates the feature for every
Venice model**, so it is part of this item, not a follow-up.

### f. Host consumption

The route writes `text-delta` per received chunk instead of one at the end. Driven
by the push subscription from [02](./02-push-transport.md); if that slips, the
existing 700ms poll can carry deltas in batches as an interim (ugly, but strictly
better than one blob). Keep the route's `graphText` accumulation so
`onTurnFinish` persists the same assistant body, and keep reading `wf_run.output`
as authoritative — a streamed answer that disagrees with the persisted one loses.

## Risks

- **Truncated answer read as complete** if (b)'s terminal marker is skipped. This is
  the one genuinely new failure mode streaming introduces.
- **Cost of chattiness.** Batching bounds flushes to ~20/s per run worst case;
  verify against DO limits before enabling broadly.
- **Non-streaming providers.** `streamText` still works (one large chunk), so the
  path degrades rather than fails.
- **Eval determinism.** Keep the flag off under `simulate` / `freezeTools` so eval
  traces stay identical to what they record today.
- **Engine drift.** A graph on `'durable'` must not silently lose the feature
  without saying so. The author-facing engine copy
  (`ui/editor/node-inspector-sections.tsx:26-31`) should eventually mention
  streaming as an inline capability — right now it talks only about checkpointing
  and retries.

## Definition of done

- A chat turn on `'inline'` renders its first characters in < 1.5s from request
  accepted.
- `wf_run_step` meta/trace for a streamed agent node is identical to a
  non-streamed one (same steps, same usage, same recorded output).
- A budget overrun mid-stream renders as visibly incomplete, not as an answer.
- The same graph run on `'durable'` behaves exactly as it does today.
- Evals, document ingest, and the playground show no behavioral change.
