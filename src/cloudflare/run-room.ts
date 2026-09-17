import { DurableObject } from 'cloudflare:workers'

import type { WfSdkConfig } from '../engine/config'
import { errorMessage } from '../engine/run-node'
import type { RunAnswerChunk } from '../engine/stream-sink'

import type { CalleeDoneWire } from './callee-protocol'
import { CalleeWaiters } from './callee-waiters'
import type { GraphWorkflowEnv, GraphWorkflowParams } from './graph-workflow'
import { createInflightKeeper, type InflightKeeper } from './inflight'
import { recordInlineRunFailure, runInlineGraph } from './inline-run'

// Per-run coordination room. Two responsibilities, both live:
//
// - On the inline engine, this DO **is** the run's execution host (`startInline`).
// - It holds the run's answer as it is written, so a consumer can watch the text
//   appear (`appendAnswer` → `getAnswerSince`).
//
// Holds ONE piece of durable state, and only while a run is in flight: the
// run's start parameters (`INFLIGHT_KEY`), guarded by a heartbeat alarm. It is
// what lets the room survive its own restart. A deploy restarts every Durable
// Object; the walk was an in-memory promise, so before this the run simply
// stopped — `wf_run` said `running` forever and nothing ever came back to say
// otherwise. Now the alarm outlives the isolate (alarms are persisted), fires
// into a fresh instance that finds the record but no walk, and resumes the run
// in place from its completed `wf_run_step` rows. See `alarm()`.
//
// Everything else the room once persisted — status, output, error, a bounded
// log buffer, WebSocket fan-out — is gone (see the history of this file):
// nothing ever read it, and D1 (`wf_run`, `wf_run_log`) was and remains the
// source of truth consumers actually poll. A finished run leaves nothing
// behind here.

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

  /**
   * Callees this room's run is waiting on — this engine's `step.waitForEvent`.
   * See {@link CalleeWaiters}, which is where the mechanics (and the race) live.
   */
  private callees = new CalleeWaiters()

  /**
   * A spawned callee reporting its result. Called over RPC by the child — from
   * its Workflows instance, or from its own room when it too ran inline.
   */
  deliverCallee(eventType: string, wire: CalleeDoneWire): void {
    this.callees.deliver(eventType, wire)
  }

  /** Park until a called workflow reports back, or `timeoutMs` elapses. */
  waitForCallee(eventType: string, timeoutMs: number): Promise<CalleeDoneWire> {
    return this.callees.wait(eventType, timeoutMs)
  }
}

/**
 * The extra RPC the inline-capable room adds on top of the generic base.
 * Resolves once the run is RECORDED and handed off, not when it finishes —
 * awaiting the walk would hold the caller's request open for the whole run.
 */
type InlineHostRpc = {
  startInline(params: GraphWorkflowParams): Promise<void>
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

// The env is the full backend contract, not just `WF_DB`: on the inline engine
// this room hosts a real run, and a real run can call another workflow — which
// means starting a child instance (`GRAPH_WORKFLOW`) or a child room
// (`RUN_ROOM`), and reporting back into whichever host called it.
export type RunRoomClass<E extends GraphWorkflowEnv> = new (
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
export function makeRunRoom<TDeps, E extends GraphWorkflowEnv>(
  config: WfSdkConfig<TDeps>,
): RunRoomClass<E> {
  return class RunRoom extends RunRoomBase<E> {
    /**
     * The walk in progress, if this instance started one. Its absence while the
     * keeper still holds a record is the whole eviction detector: a fresh
     * instance over old storage has the record and no promise.
     */
    private walk: Promise<void> | undefined

    private readonly keeper: InflightKeeper = createInflightKeeper({
      storage: this.ctx.storage,
      launch: (params, resume) => this.launch(params, resume),
      abandon: (params, message) =>
        recordInlineRunFailure(config, { env: this.env, params }, message),
    })

    /**
     * Start an inline run in this room. Returns as soon as the walk is kicked
     * off — the caller (`startGraphRun`) is mirroring the durable path, where
     * `WORKFLOW.create()` likewise returns before the first node fires.
     *
     * The in-flight record and the heartbeat are written FIRST: a run that is
     * not on record cannot be resumed, so the walk must not start before the
     * write lands (see `inflight.ts`).
     */
    async startInline(params: GraphWorkflowParams): Promise<void> {
      await this.keeper.start(params)
    }

    /** The heartbeat — see `InflightKeeper.alarm`. */
    override async alarm(): Promise<void> {
      await this.keeper.alarm({ walkAlive: this.walk !== undefined })
    }

    /**
     * Run the walk detached. It is handed to `waitUntil` so the DO stays alive
     * for the whole run rather than only for the RPC that started it.
     * `runInlineGraph` never throws (it records its own failure), so nothing
     * can escape into the DO's unhandled-rejection path and take the room down
     * mid-run — and however it ends, the in-flight record goes with it.
     */
    private launch(
      params: GraphWorkflowParams,
      resume?: { attempt: number; reason: string },
    ): void {
      const walk = runInlineGraph(config, {
        env: this.env,
        room: this,
        params,
        resume,
      })
        .catch((err: unknown) => {
          // Belt and braces — runInlineGraph swallows its own failures, so
          // reaching here means the failure recorder itself threw.
          console.error(
            '[wf] inline run escaped its handler:',
            errorMessage(err),
          )
        })
        .finally(async () => {
          this.walk = undefined
          await this.keeper.finished()
        })
      this.walk = walk
      this.ctx.waitUntil(walk)
    }
  }
}
