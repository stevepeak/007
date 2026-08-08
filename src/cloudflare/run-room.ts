import { DurableObject } from 'cloudflare:workers'

import type { WfSdkConfig } from '../engine/config'
import { errorMessage } from '../engine/run-node'
import type { RunAnswerChunk, RunLogEntry } from '../engine/stream-sink'
import type { WfRunStatus } from '../storage/schema-common'

import type { GraphWorkflowParams } from './graph-workflow'
import { runInlineGraph } from './inline-run'
import { adoptTail, appendBounded, readTail } from './run-room-buffer'

// Per-run coordination room — the SDK's live-progress backend, and (on the
// inline engine) the run's execution host.
//
// - Workflow steps call `append` / `appendLog` / `setStatus` / `setOutput` /
//   `setError` via DO RPC.
// - Browsers connect via WebSocket (hibernation API) for live progress; the
//   room sends a full snapshot on connect so late subscribers catch up.
// - State is persisted in the DO's SQLite storage so reconnecting clients can
//   replay. Generic — carries no domain/workflow-name coupling.
//
// Two progress surfaces coexist: the legacy free-text `progress` channel (a
// flat string[], fed per the node's `informUser`) and the structured `logs`
// feed (RunLogEntry[]) that powers the run viewer's Logs panel. The durable
// wf_run_log table is the source of truth for a completed run; this buffer is
// just the live/reconnect window, so it's bounded.

// The room speaks the run lifecycle verbatim — including the `done` (answer
// final, background arms still running) vs `completed` (nothing left to run)
// split, so a live subscriber sees the same two beats a poller of `wf_run`
// does. An alias rather than a restatement: one vocabulary, one place to edit.
export type WfRunRoomStatus = WfRunStatus

export type WfRunRoomState = {
  runId: string
  label: string | null
  status: WfRunRoomStatus
  progress: string[]
  logs: RunLogEntry[]
  output: unknown
  error: string | null
}

/**
 * The room's scalar fields — everything that is overwritten rather than
 * appended to. These share one `'state'` key, which is right for them: each
 * write replaces a handful of bytes.
 *
 * The two APPEND-ONLY fields (`logs`, `progress`) are deliberately NOT here.
 * They used to be, and appending one entry re-serialized the entire array, so a
 * run paid O(n²) bytes in storage writes across its own log feed. Worse, the
 * SQLite-backed DO caps a value at 2 MB and log entries carry full reasoning
 * text and tool-call arguments — a long agent run can reach it, at which point
 * `put` rejects and (on the inline path, which catches and warns) the room
 * silently stops persisting. Now each entry is its own key: O(1) per append,
 * and no single value that grows.
 */
type PersistedScalars = Pick<
  WfRunRoomState,
  'label' | 'status' | 'output' | 'error'
>

/** In-memory view: the scalars plus the two append-only buffers and their cursors. */
type RoomMemo = PersistedScalars & {
  progress: string[]
  logs: RunLogEntry[]
  /**
   * Next sequence to assign. Invariant, per buffer: the entries in memory are
   * exactly sequences `[next - buffer.length, next)`, which is what lets
   * `appendBounded` name the keys that fell off the end without re-listing.
   */
  nextLogSeq: number
  nextProgressSeq: number
}

// How many recent entries the room keeps for the reconnect snapshot. The
// durable wf_run_log table holds the full feed; this is only the live tail.
// `progress` is bounded for the same reason `logs` is — it previously had no
// trim at all, so a chatty run grew it without limit.
const MAX_BUFFERED_LOGS = 1000
const MAX_BUFFERED_PROGRESS = 1000

const LOG_PREFIX = 'log:'
const PROGRESS_PREFIX = 'prog:'

/**
 * The room's generic half: live progress state, persistence, and the WebSocket
 * fan-out. Carries no host config and no engine, so it stays the SDK's
 * domain-free progress backend. {@link makeRunRoom} extends it with the inline
 * execution host, which is the only part that needs a {@link WfSdkConfig}.
 */
// Generic over the host Env rather than using the bare `DurableObject`: in a
// host Worker the latter's default env parameter resolves to that Worker's
// ambient `Env`, which would pin this SDK class to one host's bindings.
// `makeRunRoom` supplies the concrete `E`.
export class RunRoomBase<E = unknown> extends DurableObject<E> {
  private memo: RoomMemo | null = null

  /**
   * The run's answer, as it is being written — the text a reader is watching
   * appear. Appended by the node that produces the run's output (see
   * `StreamSink.delta`) and read incrementally by a waiting consumer via
   * {@link getAnswerSince}.
   *
   * DELIBERATELY IN MEMORY, and deliberately not persisted at all — neither in
   * {@link PersistedScalars} nor as its own keys. Every other field here is
   * written through `storage.put` on each change, which is right at
   * one-event-per-node granularity and ruinous at one-event-per-token (the
   * key-per-entry split below makes appends cheap, not free). Nothing is lost
   * by keeping it in memory: the finished
   * answer is persisted once, authoritatively, to `wf_run.output`, and every
   * consumer reconciles against that at the end. This buffer only exists to
   * make the wait legible.
   *
   * Consequence, accepted: a consumer that attaches after the room is evicted
   * sees no partial text and simply waits for the final answer.
   */
  private answer = ''

  private async load(): Promise<RoomMemo> {
    if (this.memo) return this.memo
    // Rooms written before the append-only split carried both arrays inside the
    // `'state'` blob. Read them off it so a run in flight across a deploy keeps
    // its tail; from here on they live under their own keys, and the legacy
    // copies fall away with the next scalar `save`.
    const [stored, logs, progress] = await Promise.all([
      this.ctx.storage.get<PersistedScalars & Partial<WfRunRoomState>>('state'),
      readTail<RunLogEntry>(this.ctx.storage, LOG_PREFIX, MAX_BUFFERED_LOGS),
      readTail<string>(
        this.ctx.storage,
        PROGRESS_PREFIX,
        MAX_BUFFERED_PROGRESS,
      ),
    ])
    const logTail = adoptTail(logs, stored?.logs ?? [], MAX_BUFFERED_LOGS)
    const progressTail = adoptTail(
      progress,
      stored?.progress ?? [],
      MAX_BUFFERED_PROGRESS,
    )
    this.memo = {
      label: stored?.label ?? null,
      status: stored?.status ?? 'queued',
      output: stored?.output ?? null,
      error: stored?.error ?? null,
      logs: logTail.values,
      nextLogSeq: logTail.nextSeq,
      progress: progressTail.values,
      nextProgressSeq: progressTail.nextSeq,
    }
    return this.memo
  }

  /** Persist the scalar half. Small and fixed-size — one key is correct here. */
  private async save(state: RoomMemo): Promise<void> {
    this.memo = state
    await this.ctx.storage.put('state', {
      label: state.label,
      status: state.status,
      output: state.output,
      error: state.error,
    } satisfies PersistedScalars)
  }

  private broadcast(event: {
    type: string
    data: unknown
    channel?: string
  }): void {
    const payload = JSON.stringify(event)
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(payload)
      } catch {
        // Socket closed underneath us — Cloudflare will clean it up.
      }
    }
  }

  async init(label?: string): Promise<void> {
    const state = await this.load()
    state.label = label ?? null
    state.status = 'queued'
    await this.save(state)
  }

  async append(channel: string, text: string): Promise<void> {
    const state = await this.load()
    if (channel === 'progress') {
      await appendBounded(
        this.ctx.storage,
        state.progress,
        text,
        PROGRESS_PREFIX,
        state.nextProgressSeq++,
        MAX_BUFFERED_PROGRESS,
      )
    }
    this.broadcast({ type: 'stream', channel, data: text })
  }

  // Structured progress entry — buffered (bounded) for reconnect + broadcast
  // live. The durable feed is written separately by the engine to wf_run_log.
  async appendLog(entry: RunLogEntry): Promise<void> {
    const state = await this.load()
    const stamped: RunLogEntry = { ...entry, ts: entry.ts ?? Date.now() }
    await appendBounded(
      this.ctx.storage,
      state.logs,
      stamped,
      LOG_PREFIX,
      state.nextLogSeq++,
      MAX_BUFFERED_LOGS,
    )
    this.broadcast({ type: 'log', data: stamped })
  }

  /**
   * Append a fragment of the run's answer. Synchronous and storage-free — this
   * is on the token path, so it must stay a string concat and a broadcast.
   */
  appendAnswer(text: string): void {
    if (!text) return
    this.answer += text
    this.broadcast({ type: 'answer', data: text })
  }

  /**
   * Read the answer written since `cursor`, plus the cursor to pass next time.
   *
   * A cursor rather than a "give me everything" read so a poller writes each
   * fragment exactly once and the response stays proportional to what is NEW,
   * not to the answer so far. Out-of-range cursors are clamped rather than
   * rejected: a caller holding a stale cursor (the room restarted and the
   * buffer is empty) should quietly resynchronise, not fail the turn.
   */
  getAnswerSince(cursor: number): RunAnswerChunk {
    const from = Math.max(0, Math.min(cursor, this.answer.length))
    return { text: this.answer.slice(from), cursor: this.answer.length }
  }

  async setStatus(status: WfRunRoomStatus): Promise<void> {
    const state = await this.load()
    state.status = status
    await this.save(state)
    this.broadcast({ type: 'status', data: status })
  }

  /**
   * Publish the run's answer. `settled` says whether that was also the end of
   * the walk: false leaves the room `done` (the answer is on screen, background
   * arms are still running and still writing to the log feed), and a later
   * `setStatus('completed')` closes it out.
   */
  async setOutput(output: unknown, settled = true): Promise<void> {
    const status: WfRunRoomStatus = settled ? 'completed' : 'done'
    const state = await this.load()
    state.output = output
    state.status = status
    await this.save(state)
    this.broadcast({ type: 'output', data: output })
    this.broadcast({ type: 'status', data: status })
  }

  async setError(error: string): Promise<void> {
    const state = await this.load()
    state.error = error
    state.status = 'failed'
    await this.save(state)
    this.broadcast({ type: 'error', data: error })
    this.broadcast({ type: 'status', data: 'failed' })
  }

  async getState(runId: string): Promise<WfRunRoomState> {
    const state = await this.load()
    // Field-by-field rather than a spread: `RoomMemo` also carries the buffers'
    // internal cursors, and a spread would ship those over RPC.
    return {
      runId,
      label: state.label,
      status: state.status,
      progress: state.progress,
      logs: state.logs,
      output: state.output,
      error: state.error,
    }
  }

  /**
   * WebSocket upgrade handler. Accepts the socket via the hibernation API so
   * the room can sleep between events. Sends the full current state on connect.
   */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 })
    }
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket]
    this.ctx.acceptWebSocket(server)

    const state = await this.load()
    server.send(
      JSON.stringify({
        type: 'snapshot',
        data: {
          status: state.status,
          progress: state.progress,
          logs: state.logs,
          output: state.output,
          error: state.error,
        },
      }),
    )

    return new Response(null, { status: 101, webSocket: client })
  }

  override webSocketMessage(_ws: WebSocket, _msg: string | ArrayBuffer): void {
    // Read-only stream — ignore client messages.
  }

  override webSocketClose(ws: WebSocket, code: number): void {
    try {
      ws.close(code, 'closing')
    } catch {
      // ignore
    }
  }
}

/**
 * The extra RPC the inline-capable room adds on top of the generic base.
 * Returns `void`, not a promise: the call hands the run off and returns — the
 * DO stub wraps it, so callers still `await` it. Awaiting the WALK instead would
 * hold the caller's request open for the whole run.
 */
type InlineHostRpc = {
  startInline(params: GraphWorkflowParams): void
}

/**
 * The full RPC surface a RunRoom stub exposes — what `startGraphRun` calls, and
 * the type argument for `DurableObjectNamespace<RunRoom>` in a host Env.
 *
 * Declared as an interface rather than a `RunRoomBase & InlineHostRpc`
 * intersection on purpose: the DO stub's RPC mapped types resolve a single named
 * object type cleanly, but collapse an intersection to something unresolvable —
 * which shows up at the call site as `room.getState(...)` losing its type.
 */
export interface RunRoom extends RunRoomBase, InlineHostRpc {}

export type RunRoomClass<E extends { DB: D1Database }> = new (
  ctx: DurableObjectState,
  env: E,
) => RunRoomBase<E> & InlineHostRpc

/**
 * Build the RunRoom class bound to a host {@link WfSdkConfig}. The host exports
 * the result under the name it registers in `wrangler.jsonc`:
 *
 * ```ts
 * export const RunRoom = makeRunRoom<MyDeps, Env>(wfConfig)
 * ```
 *
 * The config is needed for one reason: on the inline engine this DO *is* the
 * run's execution host, so it needs the host's model factory, tools, and deps —
 * exactly what {@link makeGraphWorkflow} needs for the durable engine.
 */
export function makeRunRoom<TDeps, E extends { DB: D1Database }>(
  config: WfSdkConfig<TDeps>,
): RunRoomClass<E> {
  return class RunRoom extends RunRoomBase<E> {
    /**
     * Start an inline run in this room. Returns as soon as the walk is kicked
     * off — the caller (`startGraphRun`) is mirroring the durable path, where
     * `WORKFLOW.create()` likewise returns before the first node fires.
     *
     * The walk itself is handed to `waitUntil` so the DO stays alive for the
     * whole run rather than only for this RPC. `runInlineGraph` never throws
     * (it records its own failure), so nothing can escape into the DO's
     * unhandled-rejection path and take the room down mid-run.
     */
    startInline(params: GraphWorkflowParams): void {
      const walk = runInlineGraph(config, {
        env: this.env,
        room: this,
        params,
      }).catch((err: unknown) => {
        // Belt and braces — runInlineGraph swallows its own failures, so
        // reaching here means the failure recorder itself threw.
        console.error('[wf] inline run escaped its handler:', errorMessage(err))
      })
      this.ctx.waitUntil(walk)
    }
  }
}
