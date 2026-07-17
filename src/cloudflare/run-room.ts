import { DurableObject } from 'cloudflare:workers'

import type { RunLogEntry } from '../engine/stream-sink'

// Per-run coordination room — the SDK's live-progress backend.
//
// - Workflow steps call `append` / `appendLog` / `setStatus` / `setOutput` /
//   `setError` via DO RPC.
// - Browsers connect via WebSocket (hibernation API) for live progress; the
//   room sends a full snapshot on connect so late subscribers catch up.
// - State is persisted in the DO's SQLite storage so reconnecting clients can
//   replay. Generic — carries no domain/workflow-name coupling.
//
// Two progress surfaces coexist: the legacy free-text `progress` channel (a
// flat string[], still fed by agent `exposeThinking`) and the structured `logs`
// feed (RunLogEntry[]) that powers the run viewer's Logs panel. The durable
// wf_run_log table is the source of truth for a completed run; this buffer is
// just the live/reconnect window, so it's bounded.

export type WfRunRoomStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type WfRunRoomState = {
  runId: string
  label: string | null
  status: WfRunRoomStatus
  progress: string[]
  logs: RunLogEntry[]
  output: unknown
  error: string | null
}

type PersistedState = Omit<WfRunRoomState, 'runId'>

// How many recent structured entries the room keeps for the reconnect snapshot.
// The durable wf_run_log table holds the full feed; this is only the live tail.
const MAX_BUFFERED_LOGS = 1000

export class RunRoom extends DurableObject {
  private memo: PersistedState | null = null

  private async load(): Promise<PersistedState> {
    if (this.memo) return this.memo
    const stored = await this.ctx.storage.get<PersistedState>('state')
    this.memo = stored ?? {
      label: null,
      status: 'queued',
      progress: [],
      logs: [],
      output: null,
      error: null,
    }
    // Back-compat: rooms persisted before the structured feed existed have no
    // `logs` array — normalise so appends don't hit `undefined`.
    if (!this.memo.logs) this.memo.logs = []
    return this.memo
  }

  private async save(state: PersistedState): Promise<void> {
    this.memo = state
    await this.ctx.storage.put('state', state)
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
      state.progress.push(text)
      await this.save(state)
    }
    this.broadcast({ type: 'stream', channel, data: text })
  }

  // Structured progress entry — buffered (bounded) for reconnect + broadcast
  // live. The durable feed is written separately by the engine to wf_run_log.
  async appendLog(entry: RunLogEntry): Promise<void> {
    const state = await this.load()
    const stamped: RunLogEntry = { ...entry, ts: entry.ts ?? Date.now() }
    state.logs.push(stamped)
    if (state.logs.length > MAX_BUFFERED_LOGS) {
      state.logs = state.logs.slice(-MAX_BUFFERED_LOGS)
    }
    await this.save(state)
    this.broadcast({ type: 'log', data: stamped })
  }

  async setStatus(status: WfRunRoomStatus): Promise<void> {
    const state = await this.load()
    state.status = status
    await this.save(state)
    this.broadcast({ type: 'status', data: status })
  }

  async setOutput(output: unknown): Promise<void> {
    const state = await this.load()
    state.output = output
    state.status = 'completed'
    await this.save(state)
    this.broadcast({ type: 'output', data: output })
    this.broadcast({ type: 'status', data: 'completed' })
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
    return { runId, ...state }
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
