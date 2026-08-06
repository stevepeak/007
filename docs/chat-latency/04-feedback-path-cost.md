# 4 — Feedback-path cost inside the room

Every user-facing signal a run produces — progress notes, reasoning, tool
announcements, node bookends, and (after [01](./01-token-streaming.md)) tokens —
travels the same path. On the inline engine that path runs **inside the Durable
Object that is also executing the walk**, so its per-entry cost is charged directly
against the run it's describing.

Do this before streaming. Streaming multiplies entry volume by two or three orders
of magnitude; landing it on the current path means the first thing it does is
quadratic DO storage writes.

## Current state — two writes per entry, one of them O(n)

`createInlineSink` (`cloudflare/inline-run.ts:88-120`), per entry:

1. `await appendRunLog(db, …)` — a D1 insert, awaited.
2. `await room.appendLog(stamped)` — local call → `RunRoomBase.appendLog`.

And `RunRoomBase.appendLog` (`run-room.ts:117-126`), per entry:

- pushes onto `state.logs`, trims to `MAX_BUFFERED_LOGS = 1000`,
- `await this.save(state)` → **`storage.put('state', state)` writes the entire state
  object**, including the whole `logs` array and `progress` array,
- then `broadcast`.

So the cost of the Nth entry in a run is proportional to N. Serializing and
persisting a 1000-entry array to record one new line is O(n²) across a run. Same
shape in `append` for the `progress` channel (`run-room.ts:106-113`).

Numbers, roughly: a chatty tool-calling agent emitting reasoning + a `tool` line +
a `progress` line per step over 10 steps is ~30 entries — fine. A streamed answer
flushing every 50ms for 30 seconds is ~600 flushes, each rewriting a growing
array, inside the object trying to run the model.

The durable path has the same room cost but different D1 behavior: it fires
`appendRunLog` **without awaiting** (`graph-workflow-dispatch.ts:311-327`, `void` +
`.catch`), and rewrites the node's whole feed once at terminal time via
`replaceNodeLogs`. Three writes per line, but none of them awaited in the hot path.

Inline awaits both writes. Callers in the agent loop use `void sink.log?.(…)`
(`agent-generation.ts` throughout), so the *loop* doesn't block — but the awaits
create unawaited promises inside the DO that still contend for the same thread,
and ordering is only safe because `ordinals` is assigned synchronously before the
await (`inline-run.ts:94-95`). That's correct today and fragile to change.

## What to build

### a. Stop rewriting the world on every entry

Replace the single `state` blob with an append-friendly layout. Options, in
preference order:

1. **SQLite-backed rows.** The DO has SQLite storage; a `logs` table with an
   incrementing key makes an append O(1) and the snapshot a bounded `SELECT … ORDER
   BY id DESC LIMIT n`. Cleanest, and removes the trim-on-every-write.
2. **Split keys.** Keep `state` for status/output/error (small, rarely written) and
   store log entries under `log:<ordinal>` keys, reading a bounded range for the
   snapshot. No schema work, still O(1) per append.
3. **In-memory + periodic flush.** Keep the tail in memory, persist every N entries
   or M ms. Cheapest to write, but loses the tail on eviction — acceptable for
   tokens (see [01](./01-token-streaming.md)d), not for the log feed that must
   survive a reconnect.

Whichever is chosen, **tokens should not persist at all** — the answer is durable
as `wf_run.output`.

### b. Batch the D1 inserts

Buffer entries in the inline sink and flush on an interval (~250ms) or a count
threshold, as a multi-row insert. Two constraints:

- **Ordinals must stay assigned synchronously** at emit time, as they are today
  (`inline-run.ts:94-95`), so batching can't reorder a node's feed.
- **The buffer must be flushed on every terminal path** — node end, run finalize,
  and the failure path in `runInlineGraph`'s catch (`inline-run.ts:231-250`).
  Inline has no `record:`-step rewrite to restore a dropped tail
  ([03](./03-inline-engine-parity.md), Gap 4), so an unflushed buffer at failure
  time means the account of *why it failed* is what gets lost. This is the one place
  where "best-effort" is not good enough.

### c. Don't await the room broadcast for its persistence

Broadcast is the latency-sensitive half (it's what a subscriber sees); persistence
is the durability half. Once (a) makes the append cheap they're both fast, but the
order should be: stamp → broadcast → persist. A subscriber shouldn't wait on
storage to see a line.

### d. Reconsider the `progress` string[] channel

`state.progress` is described in the room's own header comment as the "legacy
free-text" channel coexisting with the structured `logs` feed
(`run-room.ts:20-24`). It's a second persisted array with the same O(n) write
behavior, carrying data that the structured feed also carries at
`level: 'progress'`. If nothing depends on the flat array any more, deleting it
removes half this problem. Check the snapshot consumers first
(`run-room.ts:171-182` sends both).

## Why this matters more on inline than durable

On the durable engine, feed writes happen inside a `step.do` that is already
paying journal costs, on a Worker isolate that isn't hosting anything else, and any
line lost live is restored by the terminal `replaceNodeLogs` rewrite.

On the inline engine, feed writes happen **on the critical path of the run
itself**, in a single-threaded object, with no rewrite to repair losses. The
feedback path stops being instrumentation and becomes part of the workload. That's
the whole reason this is its own item rather than a footnote.

## Definition of done

- Cost of appending the Nth feed entry is independent of N.
- Per-entry writes on the inline path are ≤1 amortized D1 write and ≤1 O(1) DO
  write.
- A failed inline run's feed contains every entry emitted before the failure,
  including the last one.
- Snapshot-on-connect still returns a bounded, ordered tail for a reconnecting
  subscriber.
