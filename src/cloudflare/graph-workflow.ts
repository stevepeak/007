import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from 'cloudflare:workers'

import type { WfSdkConfig } from '../engine/config'
import {
  isDecisionKind,
  workflowGraphSchema,
  type WfNodeKind,
  type WfRunManifestEntry,
} from '../engine/graph'
import { errorMessage } from '../engine/run-node'
import type { RecordStepArgs } from '../engine/run-recorder'
import { Scheduler, WorkflowStalledError } from '../engine/scheduler'
import type { StreamSink } from '../engine/stream-sink'
import { resolveTriggerInput } from '../engine/trigger-registry'
import { createWfDb } from '../storage/client'
import {
  failRun,
  getVersionGraph,
  loadResumeSteps,
  markRunRunning,
  resolveRunManifest,
  setRunManifest,
} from '../storage/data'
import { createDurableRunRecorder } from '../storage/run-recorder'

import {
  dispatchNode,
  finishRun,
  notifyHost,
  stepDo,
  type RunCtx,
} from './graph-workflow-dispatch'
import type { RunRoom } from './run-room'

// The minimal binding contract a host Env must satisfy for the durable backend.
// The host's full Env is a superset; this is what `GraphWorkflow` touches.
export interface GraphWorkflowEnv {
  DB: D1Database
  RUN_ROOM: DurableObjectNamespace<RunRoom>
}

// Serializable run context carried in the workflow params (no live `env`).
export type GraphRunContextInput = {
  subjectId?: string
  correlationId?: string
  triggerKind: string
  promptVariables?: Record<string, string | undefined>
  /** Eval signal — under simulate, side-effecting tools are neutralized. */
  simulate?: boolean
  /** Canned tool outputs consumed under `simulate`, keyed by tool id. */
  fixtures?: Record<string, unknown>
  /** Eval matrix override — swaps an agent node's modelId/prompt. See RunContext. */
  agentOverride?: { modelId?: string; prompt?: string }
  /** Stable 32-hex trace id, minted by `startGraphRun`, used to group every
   * per-node Sentry span into one distributed trace. */
  traceId?: string
}

export type GraphWorkflowParams = {
  /** RunRoom address (host-minted). */
  runId: string
  /** `wf_run.id` (host-created via `createRun`). */
  workflowRunId: string
  workflowVersionId: string
  triggerInput: unknown
  runContext: GraphRunContextInput
  /**
   * Resume mode: the id of a prior (failed) run whose completed steps are
   * replayed into this fresh run so the walk skips them and picks up at the
   * node that failed. The prior run must have executed the SAME
   * `workflowVersionId` — the graph shape has to match for node ids to line up.
   */
  resumeFromRunId?: string
}

export type GraphWorkflowResult = {
  output: unknown
  /** The Output node that produced `output`, or `null` when the run ended on a
   * decision arm that fizzled out (no Output was reached). */
  outputNodeId: string | null
}

/**
 * Build the durable Cloudflare Workflows backend bound to a host {@link
 * WfSdkConfig}. The host re-exports the returned class under the name it
 * registers in `wrangler.jsonc`:
 *
 * ```ts
 * export const GraphWorkflow = makeGraphWorkflow(wfConfig)
 * ```
 *
 * `run()` drives the pure {@link Scheduler}, wrapping each node in `step.do` so
 * Cloudflare owns durability/retry while the engine owns node semantics. The
 * walk is deterministic (stable step names = node ids, replay-stable
 * `sequence`), so retries/hibernation don't corrupt the trace.
 */
export type GraphWorkflowClass<E extends GraphWorkflowEnv = GraphWorkflowEnv> =
  new (
    ctx: ExecutionContext,
    env: E,
  ) => WorkflowEntrypoint<E, GraphWorkflowParams>

// `E` lets the host specialize the env to its full Worker `Env` (a superset of
// GraphWorkflowEnv), so wrappers like `instrumentWorkflowWithSentry` whose
// options fn is typed `(env: Env) => …` line up.
export function makeGraphWorkflow<
  TDeps,
  E extends GraphWorkflowEnv = GraphWorkflowEnv,
>(config: WfSdkConfig<TDeps>): GraphWorkflowClass<E> {
  return class GraphWorkflow extends WorkflowEntrypoint<
    E,
    GraphWorkflowParams
  > {
    override async run(
      event: WorkflowEvent<GraphWorkflowParams>,
      step: WorkflowStep,
    ): Promise<GraphWorkflowResult> {
      const p = event.payload
      const env = this.env
      const traceId = p.runContext.traceId
      const room = env.RUN_ROOM.get(env.RUN_ROOM.idFromName(p.runId))
      const sink: StreamSink = {
        append: (channel, text) => room.append(channel, text),
        log: (entry) => room.appendLog(entry),
      }

      // Each recorder is built inside a step.do closure — `createWfDb` wraps a
      // live binding that cannot cross a step boundary.
      const recordOne = (args: RecordStepArgs) =>
        createDurableRunRecorder({
          db: createWfDb(env.DB),
          runId: p.workflowRunId,
        }).record(args)

      const graphJson = await stepDo(step, 'load-graph', async () => {
        const v = await getVersionGraph(createWfDb(env.DB), p.workflowVersionId)
        if (!v) {
          throw new Error(`Workflow version ${p.workflowVersionId} not found.`)
        }
        return v.graph
      })

      // Resolve every floating reference (prompts) to its latest published
      // version once, freeze it onto the run, and reuse it for the whole walk —
      // so a mid-run publish can't split a run across two prompt versions.
      const manifest: WfRunManifestEntry[] = await stepDo(
        step,
        'resolve-manifest',
        async () => {
          const db = createWfDb(env.DB)
          const graph = workflowGraphSchema.parse(graphJson)
          const m = await resolveRunManifest(db, graph)
          await setRunManifest(db, { runId: p.workflowRunId, manifest: m })
          return m
        },
      )

      await stepDo(step, 'begin-run', () =>
        markRunRunning(createWfDb(env.DB), {
          runId: p.workflowRunId,
          cloudflareRunId: p.runId,
        }),
      )
      await stepDo(step, 'room-running', () => room.setStatus('running'))

      const scheduler = new Scheduler(graphJson, config.limits?.nodeBudget)
      const trigger = scheduler.trigger
      const validatedTriggerInput = resolveTriggerInput(
        config.triggers,
        trigger.config.triggerKind,
        p.triggerInput,
      )

      // Shared run-level locals threaded into the hoisted dispatch/log/finish
      // helpers (defined in ./graph-workflow-dispatch) so they can live at
      // module scope instead of nested inside this method.
      const ctx: RunCtx<TDeps, E> = {
        step,
        env,
        config,
        p,
        manifest,
        sink,
        recordOne,
        room,
        scheduler,
        traceId,
      }

      // Deterministic sequence counter — lives in the orchestrator (replayed in
      // order every time), never across an opaque step boundary.
      let sequence = 0
      const triggerSeq = sequence++
      await stepDo(step, `step:${trigger.id}`, () =>
        recordOne({
          nodeId: trigger.id,
          nodeKind: 'trigger',
          sequence: triggerSeq,
          input: validatedTriggerInput,
          status: 'completed',
          output: validatedTriggerInput,
        }),
      )
      scheduler.seedTrigger(validatedTriggerInput)

      // Resume: replay a prior failed run's completed steps into this fresh run
      // so the walk skips them and picks up at the node that failed. Each reused
      // step is copied into THIS run's trace (re-sequenced contiguously after the
      // trigger, preserving order) and reported to the scheduler; the failed node
      // and everything downstream were never completed, so `scheduler.next()`
      // returns them and they re-execute normally below.
      const resumeFromRunId = p.resumeFromRunId
      if (resumeFromRunId) {
        const prior = await stepDo(step, 'load-resume', () =>
          loadResumeSteps(createWfDb(env.DB), resumeFromRunId),
        )
        for (const s of prior) {
          const seedSeq = sequence++
          const branchResult = s.branchResult as {
            result: string
            reasoning: string
          } | null
          // A decision node (branch/switch) RECORDS its {result, reasoning}
          // but passes its INPUT through to downstream nodes. Re-record the
          // decision for the trace, but seed the scheduler with the passthrough
          // input so downstream `ref`s resolve exactly as they did originally.
          const isDecision = isDecisionKind(s.nodeKind)
          await stepDo(step, `seed:${s.nodeId}`, () =>
            recordOne({
              nodeId: s.nodeId,
              nodeKind: s.nodeKind as WfNodeKind,
              sequence: seedSeq,
              input: s.input,
              status: 'completed',
              output: s.output,
              meta: s.meta,
              branchResult,
            }),
          )
          scheduler.report(s.nodeId, {
            output: isDecision ? s.input : s.output,
            branchResult: branchResult?.result,
          })
        }
      }

      try {
        while (true) {
          const instruction = scheduler.nextBatch()

          if (instruction.type === 'stall') {
            // A decision node whose taken arm has no outgoing edge ends that
            // path quietly — an intentional "fizzle out", not a malformed graph.
            // Finalize the run with no output. A stall with no decision ever
            // fired is a genuinely unreachable Output, which stays an error.
            if (!scheduler.hasRoutedDecision()) {
              throw new WorkflowStalledError()
            }
            return await finishRun(ctx, undefined, null)
          }

          if (instruction.type === 'output') {
            const outSeq = sequence++
            const outputNodeId = instruction.nodeId
            const output = instruction.output
            await stepDo(step, `step:${outputNodeId}`, () =>
              recordOne({
                nodeId: outputNodeId,
                nodeKind: 'output',
                sequence: outSeq,
                input: output,
                status: 'completed',
                output,
              }),
            )
            return await finishRun(ctx, output, outputNodeId)
          }

          // Assign sequence numbers up front, in the batch's stable order, so
          // the trace is deterministic no matter which step.do settles first.
          // Every node in a batch is independent (the ready-set is an antichain),
          // so they run concurrently and each drives its own durable steps.
          const batch = instruction.nodes.map((n) => ({
            node: n.node,
            input: n.input,
            seq: sequence++,
          }))

          // `allSettled` (not `all`): a running `step.do` can't be cancelled, so
          // let every in-flight sibling finish before we surface a failure. Each
          // failed node already recorded its own failed step inside dispatchNode.
          const settled = await Promise.allSettled(
            batch.map((b) => dispatchNode(ctx, b.node, b.input, b.seq)),
          )

          const rejected = settled.find((s) => s.status === 'rejected')
          if (rejected && rejected.status === 'rejected') {
            throw rejected.reason
          }

          for (const s of settled) {
            if (s.status === 'fulfilled') {
              scheduler.report(s.value.nodeId, s.value.report)
            }
          }
        }
      } catch (err) {
        const message = errorMessage(err)
        await stepDo(step, 'record-failure', async () => {
          await failRun(createWfDb(env.DB), {
            runId: p.workflowRunId,
            error: message,
          })
          await room.setError(message)
        })
        if (config.onRunFailed) {
          await notifyHost(step, 'on-failed', () =>
            config.onRunFailed!({ ...p.runContext, env }, { error: message }),
          )
        }
        throw err
      }
    }
  }
}
