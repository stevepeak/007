import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
  type WorkflowStepConfig,
} from 'cloudflare:workers'

import type { WfSdkConfig } from '../engine/config'
import {
  isDecisionKind,
  workflowGraphSchema,
  type NodeExecution,
  type WfNodeKind,
  type WfRunManifestEntry,
} from '../engine/graph'
import { executeSubgraph, runIteration } from '../engine/nodes/iteration'
import { errorMessage, runNode, type NodeRunResult } from '../engine/run-node'
import type { RecordStepArgs } from '../engine/run-recorder'
import {
  Scheduler,
  WorkflowStalledError,
  type ExecutableNode,
  type ReportResult,
} from '../engine/scheduler'
import type { StreamSink } from '../engine/stream-sink'
import { resolveTriggerInput } from '../engine/trigger-registry'
import { createWfDb } from '../storage/client'
import {
  failRun,
  finalizeRun,
  getVersionGraph,
  loadResumeSteps,
  markRunRunning,
  resolveRunManifest,
  setRunManifest,
} from '../storage/data'
import { createDurableRunRecorder } from '../storage/run-recorder'

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
  outputNodeId: string
}

// Per-kind step.do retry/timeout policy defaults. LLM nodes get longer, retried
// steps. A node's optional `execution` policy overrides these field-by-field.
const AI_STEP_OPTS = {
  retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
  timeout: '3 minutes',
} as const
const DEFAULT_STEP_OPTS = {
  retries: { limit: 2, delay: '3 seconds', backoff: 'exponential' },
  timeout: '1 minute',
} as const

// Return type is intentionally inferred (not widened to `WorkflowStepConfig`)
// so the const defaults keep their guaranteed `retries`, which `stepOptsFor`
// reads when layering a partial override.
function kindDefaultOpts(kind: string) {
  // `judge` is the LLM decision node; the deterministic `branch` needs no
  // retries/long timeout and falls through to the default policy. A `workflow`
  // node runs a whole callee subgraph inline (often several LLM nodes) in one
  // step, so it gets the longer, retried AI policy — authors can raise the
  // timeout further per-node via `execution` for long callees.
  return kind === 'agent' || kind === 'judge' || kind === 'workflow'
    ? AI_STEP_OPTS
    : DEFAULT_STEP_OPTS
}

// Map a node's provider-agnostic `execution` policy onto Cloudflare's
// `WorkflowStepConfig`, layered over the per-kind default so an author can
// override just a timeout or just the retry limit and inherit the rest. The
// engine schema speaks milliseconds; `step.do` accepts a number-of-ms for both
// `timeout` and retry `delay`, so we pass them straight through.
function stepOptsFor(node: {
  kind: string
  execution?: NodeExecution
}): WorkflowStepConfig {
  const base = kindDefaultOpts(node.kind)
  const ex = node.execution
  if (!ex || (ex.timeoutMs == null && ex.retries == null)) {
    return base
  }
  return {
    timeout: ex.timeoutMs ?? base.timeout,
    retries: ex.retries
      ? {
          limit: ex.retries.limit,
          delay: ex.retries.delayMs ?? base.retries.delay,
          backoff: ex.retries.backoff ?? base.retries.backoff,
        }
      : base.retries,
  }
}

// Best-effort host lifecycle notification. Runs in its own durable step (so it
// retries), but a callback that ultimately throws is swallowed (logged) rather
// than changing the run outcome — the run's success/failure is already settled
// by the time we notify. Keeps a broken host callback from turning a completed
// run into a failed one, or masking the real error on the failure path.
async function notifyHost(
  step: WorkflowStep,
  name: string,
  fn: () => void | Promise<void>,
): Promise<void> {
  try {
    await stepDo(step, name, async () => {
      await fn()
      return null
    })
  } catch (err) {
    console.error(`[wf] lifecycle callback '${name}' failed:`, errorMessage(err))
  }
}

// Cloudflare's `step.do` constrains return values to `Serializable<T>`, which
// rejects the `unknown`-typed JSON our engine produces (the values are JSON;
// the *type* is just wider than Serializable allows). This wrapper localizes
// the single cast at that boundary so call sites and the engine stay clean.
type StepBody<T> = () => Promise<T>
function stepDo<T>(
  step: WorkflowStep,
  name: string,
  optsOrBody: WorkflowStepConfig | StepBody<T>,
  maybeBody?: StepBody<T>,
): Promise<T> {
  if (typeof optsOrBody === 'function') {
    return step.do(name, optsOrBody as never) as Promise<T>
  }
  return step.do(name, optsOrBody, maybeBody as never) as Promise<T>
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
      const room = env.RUN_ROOM.get(env.RUN_ROOM.idFromName(p.runId))
      const sink: StreamSink = {
        append: (channel, text) => room.append(channel, text),
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

      const scheduler = new Scheduler(graphJson)
      const trigger = scheduler.trigger
      const validatedTriggerInput = resolveTriggerInput(
        config.triggers,
        trigger.config.triggerKind,
        p.triggerInput,
      )

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
          // A decision node (branch/judge/switch) RECORDS its {result, reasoning}
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

      // Execute one node in its own durable `run:`/`record:` steps and return
      // what the scheduler needs. Run and record are SEPARATE steps: fusing them
      // means a failed *record* write re-runs the entire body on retry — and
      // `step.do` retries replay the whole closure — so a transient DB hiccup
      // would re-invoke the model and any side-effecting tools. Split, the record
      // step retries on its own while the node's (already-successful) result
      // replays from the workflow journal. A failed node records its own failed
      // step (so it can't re-run the body) and rethrows.
      const dispatchNode = async (
        node: ExecutableNode,
        input: unknown,
        seq: number,
      ): Promise<{ nodeId: string; report: ReportResult }> => {
        let result: NodeRunResult
        try {
          if (node.kind === 'iteration') {
            // Iteration orchestrates its own per-item durable steps, so it is
            // NOT wrapped in a single `run:` step — `step.do` calls can't nest.
            // Each item's subgraph runs inside its own top-level `iter:` step
            // (deterministic name = node id + index → replay-safe); the outer
            // `runIteration` only awaits those steps under its concurrency pool
            // and collects the ordered results. The whole iteration is still
            // recorded as ONE run-step below (output = the collection).
            const iter = await runIteration({
              node,
              input,
              runItem: (item, index) =>
                stepDo(
                  step,
                  `iter:${node.id}:${index}`,
                  AI_STEP_OPTS,
                  async () => {
                    const rc = { ...p.runContext, env }
                    const toolDeps = await config.buildRunDeps(rc)
                    return await executeSubgraph(node.config.subgraph, item, {
                      getModel: (modelId) => config.getModel(modelId, rc),
                      toolRegistry: config.toolRegistry,
                      toolDeps,
                      // Overridden per item inside executeSubgraph.
                      nodeOutputs: new Map(),
                      promptVariables: p.runContext.promptVariables,
                      manifest,
                      sink,
                      resolveBlobRef: config.resolveBlobRef,
                      resolveImageRef: config.resolveImageRef,
                      simulate: p.runContext.simulate,
                      fixtures: p.runContext.fixtures,
                    })
                  },
                ),
            })
            result = {
              schedulerOutput: iter.results,
              recordedOutput: iter.results,
              meta: iter.meta,
            }
          } else {
            result = await stepDo(
              step,
              `run:${node.id}`,
              stepOptsFor(node),
              async () => {
                const rc = { ...p.runContext, env }
                const toolDeps = await config.buildRunDeps(rc)
                return await runNode(
                  { type: 'execute', node, input },
                  {
                    getModel: (modelId) => config.getModel(modelId, rc),
                    toolRegistry: config.toolRegistry,
                    toolDeps,
                    nodeOutputs: scheduler.getOutputs(),
                    promptVariables: p.runContext.promptVariables,
                    manifest,
                    sink,
                    resolveBlobRef: config.resolveBlobRef,
                    resolveImageRef: config.resolveImageRef,
                    simulate: p.runContext.simulate,
                    fixtures: p.runContext.fixtures,
                  },
                )
              },
            )
          }
        } catch (err) {
          const message = errorMessage(err)
          await stepDo(step, `record:${node.id}`, DEFAULT_STEP_OPTS, () =>
            recordOne({
              nodeId: node.id,
              nodeKind: node.kind,
              sequence: seq,
              input,
              status: 'failed',
              error: message,
            }),
          )
          // Best-effort node: swallow the failure and let the run continue with a
          // `null` output (downstream refs resolve to null). Never for decision
          // nodes — a routing decision has no safe default, so it must still
          // abort. The failed step above keeps the failure visible in the trace.
          if (node.execution?.continueOnError && !isDecisionKind(node.kind)) {
            return { nodeId: node.id, report: { output: null } }
          }
          throw err
        }

        await stepDo(step, `record:${node.id}`, DEFAULT_STEP_OPTS, () =>
          recordOne({
            nodeId: node.id,
            nodeKind: node.kind,
            sequence: seq,
            input,
            status: 'completed',
            output: result.recordedOutput,
            meta: result.meta,
            branchResult: result.branchResult
              ? {
                  result: result.branchResult,
                  reasoning: result.branchReasoning ?? '',
                }
              : null,
          }),
        )

        return {
          nodeId: node.id,
          report: {
            output: result.schedulerOutput,
            branchResult: result.branchResult,
          },
        }
      }

      try {
        while (true) {
          const instruction = scheduler.nextBatch()

          if (instruction.type === 'stall') {
            throw new WorkflowStalledError()
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
            await stepDo(step, 'finalize', () =>
              finalizeRun(createWfDb(env.DB), {
                runId: p.workflowRunId,
                output,
              }),
            )
            await stepDo(step, 'room-output', () => room.setOutput(output))
            if (config.onRunComplete) {
              await notifyHost(step, 'on-complete', () =>
                config.onRunComplete!(
                  { ...p.runContext, env },
                  { output, outputNodeId },
                ),
              )
            }
            return { output, outputNodeId }
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
            batch.map((b) => dispatchNode(b.node, b.input, b.seq)),
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
