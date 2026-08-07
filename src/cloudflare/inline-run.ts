import type { RunContext, WfSdkConfig } from '../engine/config'
import { executeWorkflow } from '../engine/executor'
import type { WfRunManifestEntry } from '../engine/graph'
import { modelBudgetFor } from '../engine/model-budget'
import { resolveNodeTimeoutMs } from '../engine/node-timeout'
import { errorMessage } from '../engine/run-node'
import type { RunLogEntry, StreamSink } from '../engine/stream-sink'
import { createWfDb, type WfDb } from '../storage/client'
import {
  appendRunLog,
  completeRun,
  failRun,
  getVersionGraph,
  markRunDone,
  markRunRunning,
  resolveRunManifest,
  setRunManifest,
} from '../storage/data'
import { createDurableRunRecorder } from '../storage/run-recorder'

import type { GraphWorkflowParams } from './graph-workflow'
import type { WfRunRoomStatus } from './run-room'

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

/** The slice of `RunRoom` the inline backend drives. */
export interface InlineRunRoom {
  setStatus(status: WfRunRoomStatus): Promise<void>
  append(channel: string, text: string): Promise<void>
  appendLog(entry: RunLogEntry): Promise<void>
  appendAnswer(text: string): void
  setOutput(output: unknown, settled?: boolean): Promise<void>
  setError(error: string): Promise<void>
}

/**
 * Build the run's sink: every entry the engine emits is persisted to
 * `wf_run_log` AND broadcast to the room.
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
    append: async (channel, text) => {
      try {
        await room.append(channel, text)
      } catch (err) {
        console.warn('[wf] inline sink append failed:', errorMessage(err))
      }
    },
    log: async (entry) => {
      const stamped: RunLogEntry = { ...entry, ts: entry.ts ?? Date.now() }
      // Entries with no node id (run-level lines) are broadcast but not
      // persisted — `appendRunLog` keys its deterministic id on the node.
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
      try {
        await room.appendLog(stamped)
      } catch (err) {
        console.warn('[wf] inline sink broadcast failed:', errorMessage(err))
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
export async function runInlineGraph<TDeps, E extends { DB: D1Database }>(
  config: WfSdkConfig<TDeps>,
  deps: RunInlineGraphDeps<E>,
): Promise<void> {
  const { env, room, params: p } = deps
  const db = createWfDb(env.DB)
  const sink = createInlineSink(db, room, p.workflowRunId)
  let runContext: RunContext = { ...p.runContext, env }

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

    const version = await getVersionGraph(db, p.workflowVersionId)
    if (!version) {
      throw new Error(`Workflow version ${p.workflowVersionId} not found.`)
    }

    // Resolve every floating reference to its published version once and freeze
    // it onto the run, so a mid-run publish can't split a run across two prompt
    // versions. Identical to the durable backend's `resolve-manifest` step.
    const manifest: WfRunManifestEntry[] = await resolveRunManifest(
      db,
      version.graph,
    )
    await setRunManifest(db, { runId: p.workflowRunId, manifest })

    // No `cloudflareRunId`: there is no Workflows instance behind this run. The
    // run viewer keys off `wf_run.id` either way; the column stays null, which
    // is itself the marker that a run executed inline.
    await markRunRunning(db, { runId: p.workflowRunId })
    await room.setStatus('running')

    runContext = { ...p.runContext, manifest, env }

    const result = await executeWorkflow({
      graph: version.graph,
      triggerInput: p.triggerInput,
      config: execConfig,
      runContext,
      recorder: createDurableRunRecorder({ db, runId: p.workflowRunId }),
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
      onOutput: async ({ output, outputNodeId, pendingWork }) => {
        await markRunDone(db, {
          runId: p.workflowRunId,
          output,
          settled: !pendingWork,
        })
        await room.setOutput(output, !pendingWork)
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
    await room.setStatus('completed')
    if (result.drainError) {
      console.warn(
        `[wf] inline run ${p.workflowRunId} delivered its output, but a background branch failed:`,
        result.drainError,
      )
    }
  } catch (err) {
    const message = errorMessage(err)
    try {
      await failRun(db, { runId: p.workflowRunId, error: message })
      await room.setError(message)
      if (config.onRunFailed) {
        await notifyHost('on-failed', () =>
          config.onRunFailed!(runContext, { error: message }),
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
