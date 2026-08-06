# 5 — Host path wins

Small, independent changes in the host's chat route and model factory. None is
transformative alone; together they're worth several hundred milliseconds per turn
plus a meaningful reduction in payload size and writes. The inline engine changed
none of these — the route is the same on either engine.

## a. Serial pre-flight

`apps/web/app/api/chat/route.ts` awaits six things in sequence before the stream
opens:

| Step | Line | Depends on |
|------|------|-----------|
| `withAuth` (session) | `:128` | — |
| `trpc.chats.loadForAgent` | `:144` | auth |
| `trpc.chats.ensureAttachmentsReady` | `:155` | chatId only |
| `resolveAssignedVersion` | `:276` | nothing (global per `triggerKind`) |
| `startGraphRun` | `:286` | the three above |
| `trpc.chats.beginAgentTurn` | `:313` | `run.workflowRunId` |

`loadForAgent`, `ensureAttachmentsReady`, and `resolveAssignedVersion` are mutually
independent → `Promise.all`. Two D1 round-trips saved.

`beginAgentTurn` needs the run id and currently blocks the stream from opening.
Preferred fix: don't await it before opening the stream — its result
(`assistantMessageId`) isn't needed until `onTurnFinish`. The placeholder still
lands durably; it just stops gating first byte.

Note `ensureAttachmentsReady` can legitimately block for a while — it re-kicks
stuck ingest runs and waits (`:182-199`). That's a correct
refusal-over-wrong-answer trade and shouldn't be removed, but it means a turn with
a freshly-uploaded attachment has a floor unrelated to anything else in this
folder. Surface it as its own state ("indexing your document…") so it doesn't read
as a slow model.

Also: `startGraphRun` now does an extra `getVersionGraph` read to resolve the
engine (`packages/007/src/cloudflare/start-run.ts:89-101`, with an honest comment
about it). Unavoidable as written — the choice is *which host to hand the run to*.
If it measures, cache the resolved engine on the version row at publish time; don't
guess before measuring.

## b. Payload size — the thread rides in three times

Per turn, the full UI message array is:

1. POSTed from the browser (`useChat` sends all messages —
   `apps/web/app/hooks/use-chat-stream.ts:77-83`)
2. serialized into the run params (`triggerInput` — `start-run.ts:117-134`)
3. recorded to D1 **twice**, as both `input` and `output` of the trigger step

On the durable engine that third one is `graph-workflow.ts:200-209`; on inline it's
`engine/executor.ts:97-104`. **Both backends do it**, so this is not something the
inline engine fixed — it's a shared engine behavior, and the right place to fix it
is the shared one.

Then `convertToModelMessages(messages)` re-walks it inside the node
(`engine/nodes/agent-generation.ts:309`). Cost grows linearly with thread length,
every turn.

Fixes, by leverage:

- **Trigger step recording:** don't store the whole message array as both input and
  output. Store a blob-ref (`cloudflare/blob-spill.ts` + `blob-resolver.ts` exist
  for exactly this) or a trimmed descriptor. The trace needs to know *what*
  triggered the run, not to carry a second copy of the transcript.
- **Client → server:** send only the new message plus the chat id and rehydrate
  history server-side. The route already has to filter notes, soft-deleted, and
  firm-post messages out of the client-supplied array (`route.ts:98-157`) — a
  signal the server should own this anyway.
- **Context window:** nothing trims history before it reaches the model. Long
  threads pay in tokens, cost, and latency at once. A window/summarize policy on the
  agent's `conversation` binding is out of scope here but should be tracked.

## c. Prompt caching

Venice is consumed as an OpenAI-compatible endpoint via `createOpenAI(...).chat()`
(`packages/ai-model/src/index.ts`); no caching directives are sent. If the provider
supports prompt caching, the system prompt plus the stable history prefix are the
obvious candidates — a legal system prompt with an attached-documents blurb is
large and near-identical across turns of one thread. Confirm provider support
before investing; if unsupported, note it and close the item.

## d. Bridge semantics — fixed; two consequences left

`GRAPH_BRIDGE_TIMEOUT_MS` is now a genuine **handoff** rather than a deadline. On
expiry the route sets `graphHandedOff` (`route.ts:396`), closes the stream, and
leaves `wf_run` alone; a poll-loop error hands off the same way (`:406`) instead of
blaming the run; `markRunFailedIfPending` is deleted. This was previously destroying
answers that were seconds from landing, and it's the right shape now. Nothing to do
here — recorded because it changes what the two remaining items are:

1. **Post-turn extras are conditional on request survival.** Memory extraction and
   auto-title run only on the non-handoff path, which the code says outright: "a
   turn that outruns the bridge skips them" (`route.ts:433-439`). Best-effort
   features, but the fix is structural — move them behind run completion via
   `config.onRunComplete` rather than the SSE stream closing. Tracked in
   [02](./02-push-transport.md)d, since push removes the bridge that creates the
   fork.
2. **A dead run's row is never settled.** The host bounds the user-visible case
   (`resumePendingTurn` abandons a placeholder older than `ABANDONED_TURN_MS` —
   `packages/api/src/routers/chats/agent.ts:31`), but `wf_run` stays `running`
   forever. That's an SDK-side gap, not a host one: see
   [03](./03-inline-engine-parity.md) Gap 4 for the DO-alarm fix.

## e. Poll cadence (interim, only if [02](./02-push-transport.md) slips)

- Merge the route's two per-tick round-trips (`getGraphRunLog` at `route.ts:351`,
  `getRun` at `:370`) into one RPC returning status + logs together. Halves tick
  cost immediately.
- Drop `GRAPH_POLL_MS` from 700 → ~250ms (`route.ts:31`). Cuts the discovery tail by
  ~450ms at ~3× the request rate — acceptable only because it's temporary.
- On the inline engine, remember each `getGraphRunLog` poll is an RPC into the DO
  currently *running the walk* (`apps/workflows/src/index.ts:198`), so raising the
  rate contends with the work. Prefer the merge over the cadence change if only one
  is done.

Delete both when push lands.

## f. `veniceFetch` double-buffering

`res.clone().json()` on every non-streaming completion buffers the body twice to
inline `reasoning_content`. Measurable on long answers, and structurally
incompatible with streaming. Superseded by the SSE transform in
[01](./01-token-streaming.md)e — listed here so it isn't lost if #1 is deferred.

## g. `buildRunDeps` per node — leave it alone

On the durable path `config.buildRunDeps` runs inside each `run:` closure
(`graph-workflow-dispatch.ts:271`), constructing a Drizzle client and a Qdrant
client per node per attempt. This is **required**: a live binding can't cross a
`step.do` boundary.

The inline executor calls it **once per run** (`engine/executor.ts:91`) — strictly
better, and free, since there's no step boundary to respect. Noted here so the
durable behavior isn't mistaken for a leak: construction is cheap (no connection
establishment). No action on either path.
