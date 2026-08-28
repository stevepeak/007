import { encodeRunPoint } from '../analytics/points'
import { safeWrite } from '../analytics/sink'
import type { RunContext, WfSdkConfig } from '../engine/config'
import { errorFeedLine } from '../engine/error-detail'
import { executeWorkflow } from '../engine/executor'
import type { WfRunManifestEntry } from '../engine/graph'
import { modelBudgetFor } from '../engine/model-budget'
import { resolveNodeTimeoutMs } from '../engine/node-timeout'
import type { ChildWorkflowRunner } from '../engine/nodes/workflow'
import { errorMessage } from '../engine/run-node'
import type { RunLogEntry, StreamSink } from '../engine/stream-sink'
import { createWfDb, type WfDb } from '../storage/client'
import {
  appendRunLog,
  completeRun,
  failRun,
  getVersionGraph,
  loadModelPriceMap,
  markRunDone,
  markRunRunning,
  resolveRunManifest,
  setRunManifest,
} from '../storage/data'

import {
  calleeEventType,
  type CalleeDoneEvent,
  type CalleeDoneWire,
} from './callee-protocol'
import {
  reportCalleeResult,
  spawnCalleeRun,
  type SpawnedChildRun,
} from './child-run'
import type { GraphWorkflowEnv, GraphWorkflowParams } from './graph-workflow'
import {
  createTelemeteredRecorder,
  resolveTelemetrySink,
  runDims,
  withRunCounts,
} from './graph-workflow-telemetry'
import { createRunCounters } from './step-counter'

// The INLINE backend — the peer of `graph-workflow.ts`.
//
// Same Scheduler, same `runNode`, same recorder, same output contract; the whole
// difference is who owns the process. The durable backend hands each node to
// Cloudflare Workflows as three journaled `step.do` calls and gets durability,
// step retry, and resume in return. This one runs the walk as plain awaits
// inside the run's own RunRoom Durable Object, and gets latency back:
//
//   • no journal writes, no `enter:`/`run:`/`record:` step trio per node
//   • no multi-step cold start before the first node fires
//   • the sink is a LOCAL call — `log()` broadcasts straight down the room's
//     already-open WebSocket instead of an RPC hop per entry. This is what makes
//     token streaming possible later; it is structurally impossible across a
//     `step.do` boundary, whose body is journaled as JSON.
//
// What it gives up, and why that is the right trade for interactive runs:
//
//   • No step-level retry. A transient provider blip fails the node rather than
//     replaying it. Acceptable where a human is watching and can just ask again;
//     not acceptable for a 20-minute ingestion pipeline.
//   • No resume. `resumeFromRunId` is rejected outright rather than silently
//     ignored — a caller asking to resume must not quietly get a fresh run.
//   • No durability across eviction. The DO holds the run; if it dies the run
//     is failed, not resumable.

/**
 * The slice of `RunRoom` the inline backend drives — now just the answer buffer.
 *
 * It was once the run's whole live surface (status, output, error, log and
 * progress fan-out). All of that was removed with the unread WebSocket channel:
 * D1 already carried the same facts for the consumers that actually read them,
 * so the room's copy was written and never looked at. The answer buffer stays
 * because it has a real reader — `getAnswerSince`, polled by the chat bridge.
 */
export interface InlineRunRoom {
  appendAnswer(text: string): void
  /**
   * Park until a called workflow reports its result — this engine's
   * `step.waitForEvent`. Lives on the room rather than in this module because
   * the room is the only thing both halves can address: the walk runs inside
   * it, and the child reaches it by id. See `RunRoomBase.waitForCallee`.
   */
  waitForCallee(eventType: string, timeoutMs: number): Promise<CalleeDoneWire>
  /** Hand a result to whoever is waiting on `eventType`. Used here only to
   *  cancel a wait whose spawn never happened. */
  deliverCallee(eventType: string, wire: CalleeDoneWire): void
}

/**
 * Build the run's sink: every entry the engine emits is persisted to
 * `wf_run_log`.
 *
 * Persisting live (rather than rewriting a node's feed once it settles, as the
 * durable backend's `record:` step does) is what makes a run observable while it
 * runs — every consumer polls the persisted feed, so without it a long agent
 * node is invisible until it finishes.
 *
 * The ordinal bookkeeping the durable path needs — counting a node's existing
 * rows so a replayed attempt lands in a fresh id range — has no analogue here:
 * nothing replays, so a plain per-node counter is enough, and a node's feed is
 * append-only and never rewritten.
 *
 * Both writes are best-effort by contract: a dropped progress line must never
 * fail the node that was merely describing itself.
 */
function createInlineSink(
  db: WfDb,
  room: InlineRunRoom,
  runId: string,
): StreamSink {
  const ordinals = new Map<string, number>()
  return {
    log: async (entry) => {
      const stamped: RunLogEntry = { ...entry, ts: entry.ts ?? Date.now() }
      // Entries with no node id (run-level lines) are dropped — `appendRunLog`
      // keys its deterministic id on the node, so there is nowhere to put them.
      const nodeId = stamped.nodeId
      if (nodeId) {
        const ordinal = ordinals.get(nodeId) ?? 0
        ordinals.set(nodeId, ordinal + 1)
        try {
          await appendRunLog(db, {
            runId,
            nodeId,
            ordinal,
            entry: {
              nodeId,
              nodeKind: stamped.nodeKind ?? null,
              sequence: stamped.sequence ?? null,
              level: stamped.level,
              message: stamped.message,
              meta: stamped.meta ?? null,
              ts: stamped.ts ?? Date.now(),
            },
          })
        } catch (err) {
          console.warn('[wf] inline sink persist failed:', errorMessage(err))
        }
      }
    },
    // Defining this at all is what enables streaming for this run — see
    // `StreamSink.delta`. The inline engine can carry a token stream because
    // the walk runs in one process with no `step.do` boundary between the model
    // and the room; the durable backend's sink deliberately omits it.
    //
    // Synchronous and unpersisted by design: `room` here is the Durable Object
    // instance itself, so this is a local string append, not an RPC or a write.
    // That is the only reason it is affordable per token.
    delta: (text) => {
      try {
        room.appendAnswer(text)
      } catch (err) {
        console.warn('[wf] inline sink delta failed:', errorMessage(err))
      }
    },
  }
}

// Best-effort host lifecycle notification. Mirrors the durable backend's
// `notifyHost`: a callback that throws is logged, never allowed to change a run
// outcome that is already settled.
async function notifyHost(
  name: string,
  fn: () => void | Promise<void>,
): Promise<void> {
  try {
    await fn()
  } catch (err) {
    console.error(`[wf] lifecycle callback '${name}' failed:`, errorMessage(err))
  }
}

/**
 * The inline engine's half of a workflow-call node: give the callee a run of its
 * own, then park until it reports back.
 *
 * The shape is the durable backend's `dispatchCallee`, minus the journal —
 * register the wait, spawn, await, unwrap — and that symmetry is the point. A
 * callee behaves the same whichever engine its CALLER happens to be on, and the
 * engine the callee itself runs on is read from its own trigger inside
 * `spawnCalleeRun`, so an inline run can call a durable workflow and vice versa.
 *
 * The wait is registered BEFORE the spawn, so a callee that finishes almost
 * instantly cannot report into an empty room.
 */
export function buildChildWorkflowRunner<E extends GraphWorkflowEnv>(args: {
  env: E
  db: WfDb
  room: InlineRunRoom
  p: GraphWorkflowParams
  manifest: WfRunManifestEntry[]
}): ChildWorkflowRunner {
  const { env, db, room, p, manifest } = args
  return async ({ node, entry, triggerInput }) => {
    const eventType = calleeEventType(node.id)
    // The calling node's own declared timeout, exactly as it bounds a durable
    // parent's `waitForEvent` — so the author's one knob bounds the wait on
    // both engines.
    const settled = room.waitForCallee(
      eventType,
      resolveNodeTimeoutMs(node, p.runContext.executionOverride),
    )
    let spawned: SpawnedChildRun
    try {
      spawned = await spawnCalleeRun(env, db, {
        entry,
        triggerInput,
        parentRunId: p.workflowRunId,
        nodeId: node.id,
        runContext: p.runContext,
        manifest,
        traceId: p.runContext.traceId,
        // This run lives in a room, not an instance: the child reports by RPC.
        parent: { kind: 'room', roomId: p.runId },
        eventType,
      })
    } catch (err) {
      // Nothing will ever report under this event type now. Settle the wait
      // rather than leave the room holding a timer for a child that was never
      // created.
      room.deliverCallee(eventType, { ok: false, error: errorMessage(err) })
      await settled.catch(() => undefined)
      throw err
    }
    const wire = await settled
    if (!wire.ok) {
      // The callee recorded its own failure against its own run; this is the
      // caller's copy of why its node failed.
      throw new Error(`Called workflow "${entry.name}" failed: ${wire.error}`)
    }
    return {
      output: JSON.parse(wire.outputJson) as unknown,
      childRunId: spawned.childRunId,
      engine: spawned.engine,
    }
  }
}

export type RunInlineGraphDeps<E> = {
  /** Host Env (live bindings) — carries `DB` and is passed back to the host. */
  env: E
  /** The run's own RunRoom. Inside the DO this is `this`. */
  room: InlineRunRoom
  params: GraphWorkflowParams
}

/**
 * Execute one graph run to completion, inline. Owns the same run lifecycle the
 * durable backend's orchestrator owns — manifest freeze, run status, room status
 * — so both backends leave an identical `wf_run` / `wf_run_step` / `wf_run_log`
 * trace and the run viewer cannot tell them apart.
 *
 * Never throws: a failed run is recorded as failed (D1 + room) and swallowed,
 * because the caller is a fire-and-forget DO task with nowhere to report to.
 */
export async function runInlineGraph<TDeps, E extends GraphWorkflowEnv>(
  config: WfSdkConfig<TDeps>,
  deps: RunInlineGraphDeps<E>,
): Promise<void> {
  const { env, room, params: p } = deps
  const db = createWfDb(env.WF_DB)
  const sink = createInlineSink(db, room, p.workflowRunId)
  let runContext: RunContext = { ...p.runContext, env }

  // Telemetry, on equal footing with the durable backend — this is a real
  // production path (a graph's trigger picks its engine), so leaving it out
  // would silently under-report every number the dashboard shows.
  const telemetry = resolveTelemetrySink(config, env)
  const counters = createRunCounters()
  const startedAtMs = Date.now()
  // `workflowId` is filled in below once the version row is read; a run that
  // dies before that still emits a point, indexed on the version id.
  let dims = runDims({
    workflowId: '',
    workflowVersionId: p.workflowVersionId,
    runId: p.workflowRunId,
    runContext: p.runContext,
  })
  let deliveredOutputNodeId: string | null = null
  const emit = (status: 'completed' | 'failed', args: { error?: string }) =>
    safeWrite(
      telemetry,
      encodeRunPoint(dims, {
        status,
        outputNodeId: deliveredOutputNodeId,
        // Inline runs bill no Workflows steps — that zero, next to a durable
        // run's count, is the whole point of recording the engine.
        engine: 'inline',
        error: args.error,
        startedAtMs,
        finishedAtMs: Date.now(),
        nodeCount: counters.nodes,
        iterationItems: counters.iterationItems,
        workflowSteps: 0,
        failedNodeCount: counters.failedNodes,
        droppedPoints: telemetry.dropped(),
      }),
    )

  // The lifecycle callbacks are driven from HERE, not from inside
  // `executeWorkflow`, so they fire in the same order the durable backend's
  // `deliverOutput` fires them: persist the outcome first, notify the host
  // second (see `onOutput` below).
  // Left to the executor, `onRunComplete` would run while `wf_run` still said
  // `running` — a host callback that reads the run back would see a stale row.
  const execConfig: WfSdkConfig<TDeps> = {
    ...config,
    onRunComplete: undefined,
    onRunFailed: undefined,
  }

  // This run may itself BE a callee. Reporting is best-effort from here: unlike
  // the durable backend, which has a retried step to lean on, a failed report
  // has nowhere to be retried — so it is logged and the caller's own wait times
  // out, which is the same outcome as a child that died silently.
  //
  // Size: the answer travels whole, since this engine has no step boundary to
  // spill it at (a durable callee's Output is usually already a blob pointer by
  // the time it reports). A durable CALLER is woken by `sendEvent`, whose
  // payload caps at 1 MiB — fine for the interactive, text-shaped work this
  // engine exists for, and the reason a callee that returns bulk should be on
  // the durable engine, which is its own trigger's call to make.
  const sub = p.subRun
  const report = async (payload: CalleeDoneEvent): Promise<void> => {
    if (!sub) return
    try {
      await reportCalleeResult(env, sub, payload)
    } catch (err) {
      console.error(
        `[wf] inline run ${p.workflowRunId} could not report to its caller:`,
        errorMessage(err),
      )
    }
  }

  try {
    if (p.resumeFromRunId) {
      // Loud rather than silent: resume replays a prior run's completed steps,
      // which only means anything when a journal recorded them. Quietly starting
      // a fresh run would re-execute side-effecting nodes the caller believed
      // were already done.
      throw new Error(
        'Resume is not supported on the inline engine — it has no step journal to replay. Switch the workflow to the durable engine to resume a failed run.',
      )
    }

    // A durable iteration item is spawned against its PARENT's version and digs
    // the container's subgraph out of it — a narrowing only the durable backend
    // performs, and only for items it spawned itself. Nothing routes one here;
    // say so rather than silently running the parent's whole graph.
    if (p.subRun?.iterationNodeId) {
      throw new Error(
        'An iteration item cannot run on the inline engine — items are spawned as durable child instances.',
      )
    }

    const version = await getVersionGraph(db, p.workflowVersionId)
    if (!version) {
      throw new Error(`Workflow version ${p.workflowVersionId} not found.`)
    }
    dims = { ...dims, workflowId: version.workflowId }
    // Prices frozen at run start, exactly as the durable backend freezes them in
    // `load-graph` — so a catalog edit mid-run can't change what this run cost,
    // and the two engines report dollars the same way.
    const prices = await loadModelPriceMap(db)

    // Resolve every floating reference to its published version once and freeze
    // it onto the run, so a mid-run publish can't split a run across two prompt
    // versions. Identical to the durable backend's `resolve-manifest` step —
    // including the part where a SPAWNED run inherits its caller's manifest
    // instead of resolving its own: re-resolving would float every reference to
    // whatever is published at that instant, splitting one logical run across
    // two prompt versions. The inherited copy is still written onto this run, so
    // its trace records exactly which versions it executed.
    const manifest: WfRunManifestEntry[] =
      p.inheritedManifest ?? (await resolveRunManifest(db, version.graph))
    await setRunManifest(db, { runId: p.workflowRunId, manifest })

    // No `cloudflareRunId`: there is no Workflows instance behind this run. The
    // run viewer keys off `wf_run.id` either way; the column stays null, which
    // is itself the marker that a run executed inline.
    await markRunRunning(db, { runId: p.workflowRunId })

    runContext = { ...p.runContext, manifest, env }

    const result = await executeWorkflow({
      graph: version.graph,
      triggerInput: p.triggerInput,
      config: execConfig,
      runContext,
      // Seeded raw, and answering to its caller rather than to its trigger's
      // contract — see `ExecuteWorkflowDeps.spawned`. The durable backend does
      // exactly the same for a run it was handed rather than started.
      spawned: !!sub,
      // Calling another workflow gives it a run of its own, here as much as on
      // the durable engine. This engine has no `waitForEvent`, so the wait is a
      // promise held by the room (see `waitForCallee`) — but everything either
      // side of it is identical, right down to the event type.
      runChildWorkflow: buildChildWorkflowRunner({
        env,
        db,
        room,
        p,
        manifest,
      }),
      // Telemetered, and counted: with no orchestrator and no step journal, the
      // recorder is the only place this backend can learn its own shape.
      recorder: withRunCounts(
        createTelemeteredRecorder({
          db,
          runId: p.workflowRunId,
          telemetry,
          dims,
          prices,
        }),
        counters,
      ),
      sink,
      // The only bound this backend has. There is no `step.do` timeout behind
      // it, so a wedged provider call would otherwise hang the run forever with
      // nothing written anywhere. Derived from the SAME declared node timeout
      // the durable backend hands Cloudflare, so an author who tightens
      // `execution.timeoutMs` tightens both engines identically.
      // The run-scoped override applies here too: the two backends must never
      // disagree about how long a node may run, or a workflow behaves one way
      // under an eval and another in production.
      resolveModelBudget: (node) =>
        modelBudgetFor(
          resolveNodeTimeoutMs(node, p.runContext.executionOverride),
        ),
      // The answer landed. Publish it and release the reader NOW — the walk
      // may still have arms to drain (a `branch → tool` side effect that the
      // Output never depended on), and making a chat turn wait on those is
      // exactly the coupling the `done` state exists to break.
      //
      // Nothing extra is needed to get that work "off thread": this whole
      // function already runs detached inside the RunRoom DO under
      // `ctx.waitUntil` (see `RunRoom.startInline`), so the drain outlives the
      // HTTP request that started the run without any fire-and-forget promise
      // of its own — and, unlike one, it still keeps the DO alive and still
      // records every step it takes.
      onOutput: async ({ output, outputNodeId, pendingWork, pendingNodes }) => {
        deliveredOutputNodeId = outputNodeId
        await markRunDone(db, {
          runId: p.workflowRunId,
          output,
          settled: !pendingWork,
          pendingNodes,
        })
        // Release the caller HERE, on the answer, not on completion — the same
        // rule the durable backend applies, and for the same reason: arms that
        // don't feed the Output are still draining, and nobody waiting on an
        // answer should wait behind work they never depended on.
        await report({ ok: true, output })
        if (config.onRunComplete) {
          await notifyHost('on-complete', () =>
            config.onRunComplete!(runContext, { output, outputNodeId }),
          )
        }
      },
    })

    // Every arm has exhausted itself. `markRunDone` already settled the run
    // when there was nothing to drain, so this is a no-op write only in the
    // background-arm case — and it carries a drain failure through, which
    // records a broken background arm WITHOUT retracting an answer the host
    // has already been handed.
    await completeRun(db, {
      runId: p.workflowRunId,
      error: result.drainError,
    })
    emit('completed', { error: result.drainError })
    if (result.drainError) {
      console.warn(
        `[wf] inline run ${p.workflowRunId} delivered its output, but a background branch failed:`,
        result.drainError,
      )
    }
  } catch (err) {
    // `errorFeedLine`, not `err.message`: a failed model call is an AI SDK
    // `APICallError` whose message is a bare "Bad Request", and the run-level
    // error is the one string the chat surface and the run header both read.
    const message = errorFeedLine(err)
    emit('failed', { error: message })
    try {
      await failRun(db, { runId: p.workflowRunId, error: message })
      // Wake the caller BEFORE the host callback: a callee that dies silently
      // leaves its caller parked until the calling node's timeout, turning a
      // legible failure into a long stall.
      await report({ ok: false, error: message })
      if (config.onRunFailed) {
        await notifyHost('on-failed', () =>
          config.onRunFailed!(runContext, {
            error: message,
            workflowRunId: p.workflowRunId,
          }),
        )
      }
    } catch (recordErr) {
      // Nothing left to report to — log and let the run sit in whatever state
      // it reached. The host's poller treats a stalled run as failed.
      console.error(
        '[wf] inline run failed AND could not record the failure:',
        errorMessage(recordErr),
      )
    }
    console.error(`[wf] inline run ${p.workflowRunId} failed:`, message)
  }
}
