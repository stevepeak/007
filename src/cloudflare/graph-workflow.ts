import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from 'cloudflare:workers'

import type { WfSdkConfig } from '../engine/config'
import {
  isDecisionKind,
  workflowGraphSchema,
  type AgentOverride,
  type NodeExecution,
  type WfNodeKind,
  type WfRunManifestEntry,
} from '../engine/graph'
import { settleOf, type NodeSettlement } from '../engine/node-settlement'
import { iterationSubgraphOf } from '../engine/nodes/iteration'
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
  loadRunPriceTable,
  markRunRunning,
  priceMapFromTable,
  resolveRunManifest,
  setRunManifest,
} from '../storage/data'

import type { CalleeParent } from './callee-protocol'
import {
  deliverOutput,
  dispatchNode,
  notifyHost,
  reportToParent,
  settleRun,
  stepDo,
  type RunCtx,
} from './graph-workflow-dispatch'
import {
  createTelemeteredRecorder,
  emitRunPoint,
  resolveTelemetrySink,
  runDims,
} from './graph-workflow-telemetry'
import type { RunRoom } from './run-room'
import { createCountingStep, createRunCounters } from './step-counter'
import { runContextFor } from './run-context'

// The minimal binding contract a host Env must satisfy for the durable backend.
// The host's full Env is a superset; this is what `GraphWorkflow` touches.
export interface GraphWorkflowEnv {
  /**
   * D1 holding the SDK's `wf_*` tables. This is the SDK's OWN database — give it
   * one, do not point it at a database that also holds host tables.
   *
   * The name is `WF_DB`, not `DB`, for two reasons. A host Worker generally needs
   * BOTH its own database and this one in the same request, so one binding name
   * cannot serve both. And a dedicated D1 keeps the SDK's Drizzle migrations on
   * their own `d1_migrations` ledger: sharing a database means sharing that
   * ledger with the host's migration set, where two generators numbering from
   * `0000_` can eventually emit the same filename and silently mark an unapplied
   * migration as applied.
   *
   * Required, deliberately. If you are migrating from the older shared-`DB`
   * contract, do NOT add a `?? env.DB` fallback: while the old database still
   * carries a copy of the `wf_*` schema, a fallback reads and writes a
   * plausible-looking database and splits your data with no error anywhere.
   * Let the missing property fail typecheck instead.
   */
  WF_DB: D1Database
  /**
   * This same Workflow, so a run can spawn a CHILD instance — one per durable
   * iteration item, or one for a called workflow whose own trigger declares the
   * durable engine — and so the child can reach back to send its completion
   * event. Self-referential by design: parent and child run the exact same
   * entrypoint, differing only in their params.
   */
  GRAPH_WORKFLOW: Workflow<GraphWorkflowParams>
  /**
   * The RunRoom namespace, for the other half of the same job: a called
   * workflow whose trigger declares the INLINE engine is started in a room of
   * its own, and a child of any engine reports back into a room when the run
   * that called it is itself inline.
   *
   * Required, even for a host that never authors an inline workflow: whether a
   * callee needs this binding is decided by the CALLEE's trigger, so a missing
   * binding would surface as a run-time failure inside somebody else's
   * workflow rather than as a typecheck failure here.
   */
  RUN_ROOM: DurableObjectNamespace<RunRoom>
}

// Serializable run context carried in the workflow params (no live `env`).
export type GraphRunContextInput = {
  subjectId?: string
  correlationId?: string
  /** The host principal this run acts for; opaque, see `RunContext.actorId`. */
  actorId?: string
  triggerKind: string
  promptVariables?: Record<string, string | undefined>
  /** Eval signal — under simulate, side-effecting tools are neutralized. */
  simulate?: boolean
  /**
   * Mirrors `wf_run.is_eval`, carried into the run so telemetry can partition on
   * it. Every dashboard query filters `is_eval = false`; without this the
   * analytics numbers would count eval traffic the charts exclude and the two
   * sources could never be reconciled. Nothing about EXECUTION reads it —
   * `simulate` / `freezeTools` are the signals that change behavior.
   */
  isEval?: boolean
  /** Canned tool outputs consumed under `simulate`, keyed by tool id. */
  fixtures?: Record<string, unknown>
  /**
   * Eval integration signal — read tools execute for real instead of returning
   * a fixture; write tools stay neutralized. See RunContext.
   */
  liveReads?: boolean
  /** Eval synthesis signal — run every agent node with an empty tool set. See RunContext. */
  freezeTools?: boolean
  /** Eval matrix override — swaps an agent node's modelId/prompt. See RunContext. */
  agentOverride?: AgentOverride
  /**
   * Run-scoped step policy, tightening only. Caps what this run may spend
   * without editing anybody's published graph. See `RunContext`.
   */
  executionOverride?: NodeExecution
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
  /**
   * Set when this run was SPAWNED BY another run — the callee of a
   * workflow-call node, or one item of a durable iteration. It is a first-class
   * run of its own (its own `wf_run`, its own per-node steps) and reports its
   * result back to whoever is waiting.
   *
   * Three things change under it, all so a spawned run behaves exactly like the
   * inlined subgraph it stands in for — being spawned must change *where* the
   * work runs, never *what it means*:
   *   • the trigger input is seeded raw (the inline `executeSubgraph` path does
   *     no trigger-registry validation, and a callee triggered by an event kind
   *     would otherwise start failing the moment it was called rather than
   *     started),
   *   • the Output value skips the trigger's output contract for the same reason,
   *   • completion/failure is reported to the parent before the run settles.
   */
  subRun?: {
    /** Where to report the result — the parent's instance, or its RunRoom when
     * the calling run is itself on the inline engine. See `CalleeParent`. */
    parent: CalleeParent
    /** Event type the parent is parked on — unique per calling node, and per
     * ITEM when this is one item of a durable iteration. */
    eventType: string
    /**
     * Set when this child is ONE ITEM of a durable iteration rather than a whole
     * called workflow. It names the iteration node in the parent's graph whose
     * `config.subgraph` this instance should run.
     *
     * The child is spawned against the PARENT's `workflowVersionId` and digs the
     * subgraph out of it, rather than the subgraph being passed down in params.
     * An iteration's subgraph is not a published entity — it has no version row
     * of its own — and shipping graph JSON through params would put a second,
     * unversioned copy of it on the wire, which could then disagree with the
     * version the parent froze. Reading it back out of the same version is what
     * makes "the item ran the graph the parent was running" true by
     * construction.
     */
    iterationNodeId?: string
  }
  /**
   * The parent's frozen run manifest, passed down instead of re-resolved.
   *
   * Load-bearing: re-resolving in the child would float every reference to
   * whatever is published at *that* moment, so a publish landing mid-run would
   * split one logical run across two prompt versions — the exact failure the
   * manifest exists to prevent.
   */
  inheritedManifest?: WfRunManifestEntry[]
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
 * Cloudflare owns durability/retry while the engine owns node semantics. Step
 * names are derived from node ids and so are stable across replay, which is
 * what keeps retries and hibernation from corrupting the trace. (`sequence` is
 * NOT replay-stable under the rolling walk — see the note where it is assigned.
 * It is a plain ordering index, and a node whose `record:` step already ran
 * replays that step rather than rewriting it.)
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
      rawStep: WorkflowStep,
    ): Promise<GraphWorkflowResult> {
      const p = event.payload
      const env = this.env
      // Wrapped ONCE, here, so every `stepDo(ctx.step, …)` — plus the direct
      // `waitForEvent` a workflow-call node parks on — is tallied without any call
      // site knowing. See `step-counter.ts` for why this is a proxy and why it
      // survives replay.
      const counters = createRunCounters()
      const step = createCountingStep(rawStep, counters)
      const traceId = p.runContext.traceId
      // The durable backend has no RUN-LEVEL live channel. Every line a
      // consumer reads is written by a PER-NODE sink in `dispatchNode`, which
      // persists to `wf_run_log` directly; this run-level sink is the terminus
      // those forward to, and it has nowhere further to go.
      //
      // Left deliberately empty rather than deleted, because it is still what
      // `executeSubgraph` receives — the nodes INSIDE an iteration. Those have
      // no per-node writer, and until there is a surface that can show a step
      // running thirty times they are not meant to have one: the loop narrates
      // for its whole body (see `withoutUserProgress`), and its own note and
      // per-item ticks now do persist, through the sink `dispatchNode` builds
      // for it.
      const sink: StreamSink = {}

      // Resolved once per wake, which is exactly the scope of the sink's
      // per-invocation point cap.
      const telemetry = resolveTelemetrySink(config, env)

      // `getVersionGraph` already reads the workflow id — it was simply being
      // discarded. Telemetry indexes on it (a version id fragments a workflow's
      // history across every publish), so it now comes back with the graph.
      //
      // The catalog's prices ride along in this SAME step rather than a new one:
      // freezing them costs no extra durable step, and pricing tokens when they
      // are spent is what stops a later catalog edit from rewriting what this
      // run cost.
      const loaded = await stepDo(step, 'load-graph', async () => {
        const db = createWfDb(env.WF_DB)
        const v = await getVersionGraph(db, p.workflowVersionId)
        if (!v) {
          throw new Error(`Workflow version ${p.workflowVersionId} not found.`)
        }
        return {
          // One item of a durable iteration runs the container's subgraph, not
          // the whole version. Narrowed HERE, inside the load step, so every
          // line below this point — scheduler, manifest, walk, Output — sees a
          // single graph and needs to know nothing about which kind of run it
          // is in.
          graph: p.subRun?.iterationNodeId
            ? iterationSubgraphOf(v.graph, p.subRun.iterationNodeId)
            : v.graph,
          workflowId: v.workflowId,
          prices: await loadRunPriceTable(db),
        }
      })
      // An instance that started on the previous deploy resumes with the OLD
      // journal entry — a bare graph. Narrow rather than assume, or every
      // in-flight run breaks the moment this ships.
      const isWidened =
        !!loaded && typeof loaded === 'object' && 'workflowId' in loaded
      const graphJson = isWidened ? loaded.graph : loaded
      const workflowId = isWidened ? (loaded.workflowId ?? '') : ''
      const prices = priceMapFromTable(isWidened ? (loaded.prices ?? []) : [])

      const dims = runDims({
        workflowId,
        workflowVersionId: p.workflowVersionId,
        runId: p.workflowRunId,
        runContext: p.runContext,
      })

      // Each recorder is built inside a step.do closure — `createWfDb` wraps a
      // live binding that cannot cross a step boundary.
      const recordOne = (args: RecordStepArgs) =>
        createTelemeteredRecorder({
          db: createWfDb(env.WF_DB),
          runId: p.workflowRunId,
          telemetry,
          dims,
          prices,
        }).record(args)

      // Resolve every floating reference (prompts) to its latest published
      // version once, freeze it onto the run, and reuse it for the whole walk —
      // so a mid-run publish can't split a run across two prompt versions.
      // A child instance INHERITS the parent's frozen manifest — it must not
      // re-resolve (see `GraphWorkflowParams.subRun`). It still writes the
      // inherited copy onto its own run, so the child's trace records exactly
      // which versions it executed, same as any other run.
      const inherited = p.inheritedManifest
      const manifest: WfRunManifestEntry[] = inherited
        ? await stepDo(step, 'inherit-manifest', async () => {
            await setRunManifest(createWfDb(env.WF_DB), {
              runId: p.workflowRunId,
              manifest: inherited,
            })
            return inherited
          })
        : await stepDo(step, 'resolve-manifest', async () => {
            const db = createWfDb(env.WF_DB)
            const graph = workflowGraphSchema.parse(graphJson)
            const m = await resolveRunManifest(db, graph)
            await setRunManifest(db, { runId: p.workflowRunId, manifest: m })
            return m
          })

      // Returns the run's start instant so the run telemetry point can bucket on
      // when the run BEGAN — the point is emitted at finish, and bucketing a
      // long run by its end would file it under the wrong hour and stop the
      // volume chart reconciling with `wf_run.created_at`. Journaled, so a
      // replay reuses the original instant. Null on an in-flight instance
      // resuming across this deploy (old journal entry returned void).
      const runStartedAtMs = await stepDo(step, 'begin-run', async () => {
        await markRunRunning(createWfDb(env.WF_DB), {
          runId: p.workflowRunId,
          cloudflareRunId: p.runId,
        })
        return Date.now()
      })

      const scheduler = new Scheduler(graphJson, config.limits?.nodeBudget)
      const trigger = scheduler.trigger
      // A spawned callee is seeded raw: the inline path it replaces validates
      // nothing (the caller's `buildTriggerInput` output is handed straight to
      // the subgraph's identity trigger), so validating here would make flipping
      // being called change whether a workflow runs at all.
      const validatedTriggerInput = p.subRun
        ? p.triggerInput
        : resolveTriggerInput(
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
        scheduler,
        traceId,
        instanceId: event.instanceId,
        counters,
        telemetry,
        dims,
        prices,
        runStartedAtMs,
      }

      // Trace ordering index. Lives in the orchestrator, never across an opaque
      // step boundary. Assigned in dispatch order, so the trace reads in
      // execution order; see the note in the walk about what that means for
      // replay.
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
          loadResumeSteps(createWfDb(env.WF_DB), resumeFromRunId),
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

      // The delivered answer, once an Output (or a fizzled arm) settles it.
      // Non-null flips the loop from "producing the answer" to "draining the
      // arms that never fed it" — the run is `done` but not yet `completed`.
      let delivered: GraphWorkflowResult | null = null

      // Nodes started but not yet settled, keyed by node id. Each entry is
      // written never to reject (see `settleOf`) so the race below always
      // identifies WHICH node ended, and no sibling is left unhandled.
      const inflight = new Map<string, Promise<NodeSettlement>>()
      // A node broke: stop starting NEW work, but keep awaiting what is already
      // running — a `step.do` in flight cannot be cancelled.
      let stopDispatch = false
      // First failure from the drain phase, if any.
      let drainError: string | undefined

      const drainInflight = async (): Promise<void> => {
        await Promise.allSettled(inflight.values())
        inflight.clear()
      }

      try {
        while (true) {
          // 1. The answer, the instant it becomes reachable — polled per settle
          //    rather than once per fully-settled ready-set. Under the batched
          //    walk a slow background node dispatched beside the answer arm
          //    delayed `done` by its own duration, which is precisely what the
          //    `done` state exists to prevent.
          const out = scheduler.pollOutput()
          if (out) {
            const outSeq = sequence++
            const outputNodeId = out.nodeId
            const output = out.output
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
            // Settle it so the walk moves on to whatever else is ready instead
            // of being handed the same Output forever. A second Output on
            // another arm is recorded for the trace but never re-delivers: the
            // caller already has its answer.
            scheduler.completeOutput(outputNodeId, output)
            if (!delivered) {
              delivered = await deliverOutput(
                ctx,
                output,
                outputNodeId,
                // `hasPendingWork`, not `hasReadyWork`: the background arms are
                // RUNNING here, not merely ready, and reporting nothing pending
                // would settle the run `completed` while they were still going.
                scheduler.hasPendingWork(),
              )
            }
            continue
          }

          // 2. Start everything newly ready, answer-critical nodes first. Every
          //    node in a ready-set is independent, so they run concurrently and
          //    each drives its own durable steps.
          //
          //    Sequence numbers are assigned at dispatch, so the trace reads in
          //    execution order. A replay may assign different numbers to work it
          //    has not yet recorded — harmless: `sequence` is a plain ordering
          //    index, not unique, and any node whose `record:` step already ran
          //    replays that step from the journal rather than rewriting it.
          if (!stopDispatch) {
            const ready = scheduler.takeReady()
            counters.nodes += ready.length
            for (const item of ready) {
              const seq = sequence++
              inflight.set(
                item.node.id,
                settleOf(
                  item.node.id,
                  dispatchNode(ctx, item.node, item.input, seq),
                ),
              )
            }
          }

          // 3. Nothing ready and nothing running.
          if (inflight.size === 0) {
            // Past the answer, this is the ordinary end of the walk.
            if (delivered) {
              return await settleRun(ctx, delivered, drainError)
            }
            // A decision node whose taken arm has no outgoing edge ends that
            // path quietly — an intentional "fizzle out", not a malformed graph.
            // Finalize the run with no output. A stall with no decision ever
            // fired is a genuinely unreachable Output, which stays an error.
            if (!scheduler.hasRoutedDecision()) {
              throw new WorkflowStalledError()
            }
            return await settleRun(
              ctx,
              await deliverOutput(ctx, undefined, null, false),
            )
          }

          // 4. Wait for the FIRST node to settle, then loop — so the Output
          //    check above runs again as soon as anything has changed.
          const settled = await Promise.race(inflight.values())
          inflight.delete(settled.nodeId)

          if (!settled.ok) {
            // Out of flight but never completed, so this arm stays dead and the
            // node is never re-selected.
            scheduler.abandon(settled.nodeId)
            // Before the answer, a failed node fails the run — but only once the
            // work already running has landed, since a `step.do` cannot be
            // cancelled. After the answer, what the host received cannot be
            // retracted, so the broken arm is recorded beside the delivered
            // result and the drain stops starting new work while its siblings
            // finish. Each failed node already recorded its own failed step
            // inside `dispatchNode`.
            if (!delivered) {
              await drainInflight()
              throw settled.error
            }
            drainError ??= errorMessage(settled.error)
            stopDispatch = true
            continue
          }

          scheduler.report(settled.nodeId, settled.report)
        }
      } catch (err) {
        const message = errorMessage(err)
        // Whatever the outcome, nothing may still be running when we settle or
        // fail the run — an in-flight `step.do` cannot be cancelled, so the only
        // option is to let it land.
        await drainInflight()
        // Same rule as a rejected drain node, for everything else the drain can
        // throw (the node budget, a recorder step, a second Output's record):
        // once the answer is out the run is not a failure. Settle it with the
        // answer already given and record the broken arm.
        if (delivered) {
          return await settleRun(ctx, delivered, drainError ?? message)
        }
        await stepDo(step, 'record-failure', async () => {
          await failRun(createWfDb(env.WF_DB), {
            runId: p.workflowRunId,
            error: message,
          })
          // The last step this run is guaranteed to reach. Two more MAY follow,
          // and whether they do is already decided — so count them here rather
          // than under-report the billing line on every failure.
          emitRunPoint(ctx, {
            status: 'failed',
            error: message,
            extraSteps: (p.subRun ? 1 : 0) + (config.onRunFailed ? 1 : 0),
          })
        })
        // Wake the parent BEFORE the host callback and before rethrowing: a
        // spawned callee that dies silently leaves its parent parked until the
        // node's timeout, turning a legible failure into a long stall.
        await reportToParent(ctx, { ok: false, error: message })
        if (config.onRunFailed) {
          await notifyHost(step, 'on-failed', () =>
            config.onRunFailed!(runContextFor(p, env), {
              error: message,
              workflowRunId: p.workflowRunId,
            }),
          )
        }
        throw err
      }
    }
  }
}
