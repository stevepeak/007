// Thin abstraction over a run's progress channel so the engine can publish
// without a hard dependency on any backend type. Each Cloudflare backend passes
// an adapter that persists to `wf_run_log`; tests pass an in-memory recorder.
//
// There used to be a second, free-text channel here — `append(channel, text)`,
// the "legacy progress" surface. It was removed with the RunRoom fan-out: it had
// no producer anywhere in the SDK (nothing ever called it), and both backends
// terminated it in the room's unread progress buffer. User-facing progress lives
// on `log` at the `progress` level, which is persisted and actually read.

// Severity / kind of a structured run-log entry. Drives the icon + colour the
// Logs panel renders, and lets the run viewer derive the currently-active node
// (`node-start` with no matching `node-end`).
//   - node-start / node-end : a node was entered / finished (carries nodeId)
//   - progress              : a curated, USER-FACING "what's happening" line —
//                             the only level an end-user progress surface shows.
//                             Every node emits one at start; agents add more per
//                             the node's `informUser` sub-toggles. Distinct from
//                             the dev-only levels below so the two audiences
//                             never conflate.
//   - info                  : a human-readable progress line we emit ourselves
//   - thinking              : an agent's internal reasoning for a step (dev feed)
//   - tool                  : an agent invoked a tool (dev feed)
//   - warn / error          : something went wrong (error carries the message)
//   - state                 : a RUN-level lifecycle marker (queued / running /
//                             done / completed / failed), written straight to
//                             `wf_run_log` beside the status change rather than
//                             emitted by a node. Node-less, so the activity feed
//                             renders it between node rows at the moment it
//                             happened — the only place the true settle time of
//                             a `done`-then-drain run is visible.
export type RunLogLevel =
  | 'node-start'
  | 'node-end'
  | 'progress'
  | 'info'
  | 'thinking'
  | 'tool'
  | 'warn'
  | 'error'
  | 'state'

/**
 * The `state` level as a value, for the storage writer and the feed reader.
 * Lives here with the rest of the level vocabulary so the two cannot drift.
 */
export const RUN_STATE_LEVEL = 'state' satisfies RunLogLevel

// One structured progress event. Emitted by the engine as a run executes and
// persisted to `wf_run_log`, so a completed run replays its whole feed. `nodeId`/`nodeKind`/`sequence` are stamped by the
// per-node sink wrapper so a caller deep inside a node handler need not know
// where it sits in the walk.
export type RunLogEntry = {
  /** Epoch millis. Stamped by the sink when the caller omits it. */
  ts?: number
  level: RunLogLevel
  /** Human-readable line shown in the Logs panel. */
  message: string
  nodeId?: string
  nodeKind?: string
  /** The node's deterministic walk sequence (for stable ordering). */
  sequence?: number
  /** Structured extras (tool name/args, token usage, …) for expansion. */
  meta?: Record<string, unknown>
}

/**
 * A slice of a run's answer, read back by cursor — the READ side of the
 * {@link StreamSink.delta} write side below.
 *
 * The protocol is the whole type: `text` is everything written since the cursor
 * the caller passed, and `cursor` is what to pass next time (the buffer's new
 * length). A caller starts at 0 and echoes back whatever it last received.
 *
 * Only runs on the INLINE engine ever produce anything here — the durable
 * engine cannot stream, so it returns empty text forever and its consumer falls
 * back to the finished answer on `wf_run.output`.
 */
export type RunAnswerChunk = {
  text: string
  cursor: number
}

export interface StreamSink {
  /**
   * Emit a structured log entry. Optional so existing sinks (noop / memory)
   * stay valid; the Cloudflare backends wire it to the `wf_run_log` writer.
   */
  log?: (entry: RunLogEntry) => Promise<void> | void
  /**
   * Emit a fragment of THE ANSWER as it is written — the text an end user is
   * watching appear, not a progress line about it.
   *
   * Its PRESENCE is the signal to stream, and that is the whole mechanism:
   *
   *   • Only the backend that can carry a token stream defines it. The inline
   *     engine does; the durable engine cannot (a `step.do` body is journaled
   *     as JSON, so nothing incremental survives the boundary) and so leaves it
   *     undefined.
   *   • Only the node that produces the run's output receives it — the node
   *     named by the Output node's `config.source`. Every other node's sink has
   *     it undefined, so no intermediate agent's working text can ever be
   *     mistaken for the answer.
   *
   * A node handler therefore decides whether to stream by asking whether this
   * exists, with no flag threaded through the run context and nothing to keep
   * in sync. Undefined is the safe default at every layer.
   *
   * Unlike {@link log}, fragments are NOT persisted — one row per token is not
   * a feed, it is a denial of service. The finished answer is persisted once to
   * `wf_run.output`, which stays the authority.
   */
  delta?: (text: string) => Promise<void> | void
}

// In-memory sink useful for tests / debugging. Captures every structured entry
// in order so assertions can inspect what would have been streamed.
export function createMemorySink(): StreamSink & {
  logs: RunLogEntry[]
} {
  const logs: RunLogEntry[] = []
  return {
    logs,
    log: (entry) => {
      logs.push(entry)
    },
  }
}

/**
 * The same sink with USER-FACING lines removed: `progress` entries are dropped,
 * every other level (the node bookends, info/thinking/tool/warn/error) passes
 * through untouched.
 *
 * Wrapped around the sink an ITERATION hands its subgraph. There is no surface
 * that can show a line from inside a loop: the user's feed is one flat list, so
 * a step that runs thirty times either repeats itself thirty times or
 * interleaves thirty items' narration into nonsense. Until there is a per-item
 * surface to show them in, the loop speaks for its body (`runIteration` emits
 * the author's note and the per-item ticks) and the body stays quiet. The
 * editor disables "Inform user" on a node inside an iteration for the same
 * reason; this is the runtime half, and it is what keeps a graph published
 * before that existed from narrating into the void.
 *
 * The DEVELOPER feed is untouched on purpose — the run viewer still gets every
 * inner node's trace. This mutes who is listening, not what happened.
 */
export function withoutUserProgress(sink: StreamSink): StreamSink
export function withoutUserProgress(
  sink: StreamSink | undefined,
): StreamSink | undefined
export function withoutUserProgress(
  sink: StreamSink | undefined,
): StreamSink | undefined {
  const log = sink?.log
  if (!sink || !log) return sink
  return {
    ...sink,
    log: (entry) => (entry.level === 'progress' ? undefined : log(entry)),
  }
}
