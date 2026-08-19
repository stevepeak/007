import { DurableObject } from 'cloudflare:workers'

import type { WfSdkConfig } from '../engine/config'
import { errorMessage } from '../engine/run-node'
import type { RunAnswerChunk } from '../engine/stream-sink'

import type { GraphWorkflowParams } from './graph-workflow'
import { runInlineGraph } from './inline-run'

// Per-run coordination room. Two responsibilities, both live:
//
// - On the inline engine, this DO **is** the run's execution host (`startInline`).
// - It holds the run's answer as it is written, so a consumer can watch the text
//   appear (`appendAnswer` → `getAnswerSince`).
//
// Deliberately holds NO durable state. It once persisted the run's status,
// output, error, label, and a bounded log/progress buffer, and fanned all of it
// out over a WebSocket — see the history of this file. Nothing ever connected:
// the upgrade handler had no route in front of it and `getState` had no call
// site in the entire monorepo, so every one of those writes was paid for and
// never read. D1 (`wf_run`, `wf_run_log`) was and remains the source of truth
// that consumers actually read, via the poll path.
//
// That removal is why there is no cleanup alarm here and nothing to bound: a
// room owns one run (`idFromName(runId)`), and it now leaves nothing behind.
// If a push transport is ever built (`docs/chat-latency/02-push-transport.md`
// still specifies it), the fan-out comes back with the client that reads it —
// re-adding a broadcast to these methods is a smaller job than keeping an
// unread one warm.

/**
 * The room's generic half. Carries no host config and no engine, so it stays
 * the SDK's domain-free run backend. {@link makeRunRoom} extends it with the
 * inline execution host, which is the only part that needs a {@link WfSdkConfig}.
 */
// Generic over the host Env rather than using the bare `DurableObject`: in a
// host Worker the latter's default env parameter resolves to that Worker's
// ambient `Env`, which would pin this SDK class to one host's bindings.
// `makeRunRoom` supplies the concrete `E`.
export class RunRoomBase<E = unknown> extends DurableObject<E> {
  /**
   * The run's answer, as it is being written — the text a reader is watching
   * appear. Appended by the node that produces the run's output (see
   * `StreamSink.delta`) and read incrementally by a waiting consumer via
   * {@link getAnswerSince}.
   *
   * In memory, never persisted. Writing one row per token is not a feed, it is
   * a denial of service, and nothing is lost by leaving it out: the finished
   * answer is persisted once, authoritatively, to `wf_run.output`, and every
   * consumer reconciles against that at the end. This buffer only exists to
   * make the wait legible.
   *
   * Consequence, accepted: a consumer that attaches after the room is evicted
   * sees no partial text and simply waits for the final answer.
   */
  private answer = ''

  /**
   * Append a fragment of the run's answer. Synchronous and storage-free — this
   * is on the token path, so it must stay a string concat.
   */
  appendAnswer(text: string): void {
    if (!text) return
    this.answer += text
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
 * which shows up at the call site as `room.getAnswerSince(...)` losing its type.
 */
export interface RunRoom extends RunRoomBase, InlineHostRpc {}

export type RunRoomClass<E extends { WF_DB: D1Database }> = new (
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
export function makeRunRoom<TDeps, E extends { WF_DB: D1Database }>(
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
