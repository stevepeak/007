// Thin abstraction over a live progress channel (e.g. the RunRoom Durable
// Object) so the engine can publish progress without a hard dependency on the
// DO type. The Cloudflare backend passes an adapter that forwards to
// `RunRoom.append(channel, text)`; tests pass an in-memory recorder.

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
export type RunLogLevel =
  | 'node-start'
  | 'node-end'
  | 'progress'
  | 'info'
  | 'thinking'
  | 'tool'
  | 'warn'
  | 'error'

// One structured progress event. Emitted by the engine as a run executes, both
// broadcast live (RunRoom → SSE) and persisted (wf_run_log) so a completed run
// replays its whole feed. `nodeId`/`nodeKind`/`sequence` are stamped by the
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

export interface StreamSink {
  append: (channel: string, text: string) => Promise<void> | void
  /**
   * Emit a structured log entry. Optional so existing sinks (noop / memory)
   * stay valid; the Cloudflare backend wires it to `RunRoom.appendLog`.
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

// In-memory sink useful for tests / debugging. Captures every (channel, text)
// pair and every structured entry in order so assertions can inspect what would
// have been streamed.
export function createMemorySink(): StreamSink & {
  events: { channel: string; text: string }[]
  logs: RunLogEntry[]
} {
  const events: { channel: string; text: string }[] = []
  const logs: RunLogEntry[] = []
  return {
    events,
    logs,
    append: (channel, text) => {
      events.push({ channel, text })
    },
    log: (entry) => {
      logs.push(entry)
    },
  }
}
