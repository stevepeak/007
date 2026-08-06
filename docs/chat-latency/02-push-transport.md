# 2 — Push transport (retire the polling loops)

`RunRoom` is a push-capable Durable Object that, on the inline engine, is **also
the process running the workflow**. Nothing pushes to a browser. Every progress
surface polls.

## Why the inline engine makes this cheaper than it was

Before, a delta or log entry crossed: node → RPC → room → (persist) → poll → HTTP
→ client. On inline, the producer and the fan-out live in the same object:

```
node handler → sink.log/append  (local call)
             → RunRoomBase.broadcast → ctx.getWebSockets() → client
```

`createInlineSink` calls `room.appendLog(entry)` directly (`inline-run.ts:116`);
`RunRoomBase.appendLog` already ends in `broadcast` (`run-room.ts:125`), which
already iterates `this.ctx.getWebSockets()` (`run-room.ts:84-97`). **The producer
side is complete.** What's missing is exclusively on the consumer side: a route to
upgrade a browser, a token to authorize it, and a client to read it.

## Current state

- `RunRoomBase.fetch` upgrades via the hibernation API (`ctx.acceptWebSocket`) and
  sends a full snapshot on connect — `run-room.ts:162-185`.
- Snapshot covers `status`, `progress`, `logs`, `output`, `error`, so a late or
  reconnecting subscriber catches up with no extra bookkeeping.
- State persists in DO storage; the log buffer is bounded at
  `MAX_BUFFERED_LOGS = 1000` (`run-room.ts:47`).
- **No auth capability exists.** `startGraphRun` returns `runId`,
  `workflowRunId`, `instanceId`, and now `engine` (`start-run.ts:60-71`) — nothing
  a client could present to open a socket scoped to one run.

So everything polls. Per in-flight chat turn:

| Loop | Cadence | Cost per tick | Source |
|------|---------|---------------|--------|
| Route: reasoning drain | 700ms | RPC → DO `getState` | `api/chat/route.ts:31`, `:351` |
| Route: completion check | 700ms | D1 read (`getRun`) | `api/chat/route.ts:370` |
| Client: `useRunProgress` | 1500ms | HTTP → worker → D1 | `ui/run-progress-source.tsx:52`, `:101` |
| Client: `resumePendingTurn` | on mount / after handoff | tRPC → worker → D1 | `apps/web/app/hooks/use-chat-stream.ts:241` |

~4 round-trips/second/user. The two route loops share a tick
(`route.ts:365-384`) but run as sequential awaits, so each tick is two
round-trips and the answer is discovered up to 700ms after it exists.

There's a second-order cost specific to inline: the route's `getGraphRunLog` poll
is an RPC **into the DO that is currently executing the run**
(`apps/workflows/src/index.ts:198-228`). Every poll contends with the walk for the
same single-threaded object. Polling a durable run's room was free; polling an
inline run's room competes with the work.

## What to build

### a. A run-scoped subscription token

Extend `StartGraphRunResult` with a signed, short-lived token scoped to
`{ runId, workflowRunId }`. Sign with a secret already shared between the
workflows worker and the web app — the shared-secret gate in
`apps/workflows/src/index.ts` is the precedent. Read-only, single-room, no session
derived from it.

### b. A WebSocket route on the workflows worker

`GET /graph-runs/:runId/subscribe?token=…` → validate → forward the upgrade to
`env.RUN_ROOM.get(idFromName(runId)).fetch(request)`. The room's existing `fetch`
does the rest. Cap concurrent sockets per room — more important now that the room
may also be executing.

### c. An SDK client consumer

Add a push-backed source alongside the poll-backed one in
`ui/run-progress-source.tsx`, preserving the public shape
(`RunProgressSnapshot`, `useRunProgress(runId)`) so no consumer changes:

- Connect on mount, seed from `snapshot`, apply `log` / `stream` / `status` /
  `output` / `error` events incrementally.
- **Fall back to the existing `fetch` poll** on socket failure, or when the run is
  already terminal. The poll path stays as the correctness backstop — this is
  additive.
- Reconnect with backoff; the room's snapshot makes recovery self-healing.
- `stream` events already carry a `channel` (`run-room.ts:112`), so
  [01](./01-token-streaming.md)'s token channel is one additional case in the same
  switch.

Keep the `WorkflowProgressProvider` contract: the host injects one transport, now
optionally with `subscribe` beside `fetch`.

### d. Collapse the route's bridge

**The hard part of this is already done.** The bridge is now a genuine handoff:
on expiry the route sets `graphHandedOff` (`api/chat/route.ts:396`), logs, closes
the stream, and leaves `wf_run` alone for `resumePendingTurn` to settle — and a
poll-loop error (a D1 blip, a lost binding) hands off the same way
(`route.ts:406`) rather than blaming the run. `markRunFailedIfPending` is gone.
Killing a healthy run because the request ran out of patience was the old
behavior and it destroyed answers seconds from landing.

What push adds on top of that:

- The route can return as soon as the run is accepted. No 90s bridge, no
  `GRAPH_POLL_MS`, no Worker pinned per concurrent chatter.
- **The post-turn extras stop being conditional.** Today memory extraction and
  auto-title live only on the non-handoff path (`route.ts:433-439` documents this
  explicitly: "a turn that outruns the bridge skips them"). They're best-effort,
  but the fix is structural — move them behind the run's completion via
  `config.onRunComplete` (already invoked as a durable step in `finishRun`, and
  inline-side at `inline-run.ts:226-230`) so they fire on run lifetime rather than
  request lifetime.
- The `graphText` / `graphFailed` / `graphHandedOff` triple state collapses: with
  deltas arriving live and the placeholder settled from run completion, the route
  stops needing to model "did I see the answer before I gave up".

One thing the handoff shifted rather than removed: nothing now flips a run whose
process died to `failed`. The host bounds the *user-visible* case —
`resumePendingTurn` abandons a placeholder older than `ABANDONED_TURN_MS`
(`packages/api/src/routers/chats/agent.ts:31`, node timeout + 5 min) — but the
`wf_run` row itself stays `running` forever. See
[03](./03-inline-engine-parity.md) Gap 4.

## Risks

- **Auth surface.** A new capability. Read-only, short-lived, single-room, validated
  before the upgrade; derive nothing from it but the room address.
- **DO contention on inline.** Sockets and broadcasts share the object with the
  walk. Push is strictly better than polling here (one push per event vs. a poll
  per tick per viewer), but cap fan-out and keep broadcast synchronous and cheap.
- **Hibernation.** `ctx.acceptWebSocket` is already the hibernation API, so an idle
  room sleeps. Confirm token lifetime exceeds a plausible idle window, or allow
  re-auth on reconnect.
- **Local dev.** `next dev` uses the HTTP fallback client (`apps/web/lib/workflows.ts`),
  so keep polling when no subscribe URL is configured — the fallback in (c) gives
  this for free.

## Definition of done

- A chat turn opens one push connection and zero polling loops in the happy path.
- Killing the socket mid-turn degrades to the poll and still renders the answer.
- The Next route no longer stays open for the duration of a turn.
- Memory extraction and auto-title fire on run completion, not request survival.
- Document-ingest progress (the other `useRunProgress` consumer, on the durable
  engine) is unchanged in behavior and push-backed for free.
