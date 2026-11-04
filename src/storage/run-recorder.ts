import { agentUsage, stepCost, type ModelPriceMap } from '../engine/cost'
import type { RecordStepArgs, RunRecorder } from '../engine/run-recorder'

import type { WfDb } from './client'
import { wfRunStep } from './schema'

// Durable recorder for the Cloudflare backend. Writes one `wf_run_step` row per
// node via an idempotent upsert keyed on `(run_id, node_id, item_index)`.
// Because each node fires at most once per run (or once per item inside an
// iteration) and `sequence` is supplied by the deterministic walk order (not an
// in-memory counter), a retried `step.do` updates the same row instead of
// inserting a duplicate. `item_index` defaults to the `-1` top-level sentinel;
// iteration sub-steps pass their 0-based index + the container's `parentNodeId`.

function isTerminal(status: RecordStepArgs['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'skipped'
}

/**
 * The `wf_run_step` columns promoted out of a step's `meta`. This is the one
 * place the two agent shapes' key names become a single set of fields; `agentUsage`
 * decides what counts as a model call, so tokens stay NULL for any other step.
 */
export function stepColumnsFromMeta(args: { meta: unknown }) {
  const { meta } = args
  const ids = (meta && typeof meta === 'object' ? meta : {}) as {
    agentId?: unknown
    toolId?: unknown
  }
  const usage = agentUsage(meta)
  return {
    agentId: typeof ids.agentId === 'string' ? ids.agentId : null,
    toolId: typeof ids.toolId === 'string' ? ids.toolId : null,
    // A step with no model reaches here as `undefined` or `''`, per its shape.
    modelId: usage?.model ? usage.model : null,
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
  }
}

export function createDurableRunRecorder(deps: {
  db: WfDb
  runId: string
  /** The run's frozen price table; stamps each step's `cost_usd_at_run`. */
  prices?: ModelPriceMap
}): RunRecorder {
  return {
    async record(args) {
      const finishedAt =
        args.finishedAt ?? (isTerminal(args.status) ? new Date() : null)
      const costUsdAtRun = deps.prices
        ? (stepCost(args.meta, deps.prices)?.cost ?? null)
        : null
      const promoted = stepColumnsFromMeta({ meta: args.meta })
      // Only overwrite `started_at` when the caller supplies a measured
      // execution start (the terminal record does; the enter record does too).
      // Absent — e.g. an iteration container whose start was stamped at enter
      // time — leave the existing value untouched instead of nulling it.
      const startedAtSet =
        args.startedAt != null ? { startedAt: args.startedAt } : {}
      await deps.db
        .insert(wfRunStep)
        .values({
          id: crypto.randomUUID(),
          runId: deps.runId,
          nodeId: args.nodeId,
          nodeKind: args.nodeKind,
          parentNodeId: args.parentNodeId ?? null,
          itemIndex: args.itemIndex ?? -1,
          sequence: args.sequence,
          status: args.status,
          input: args.input ?? {},
          output: args.output ?? {},
          branchResult: args.branchResult ?? null,
          meta: args.meta ?? {},
          costUsdAtRun,
          ...promoted,
          startedAt: args.startedAt ?? null,
          finishedAt,
          error: args.error ?? null,
        })
        .onConflictDoUpdate({
          target: [wfRunStep.runId, wfRunStep.nodeId, wfRunStep.itemIndex],
          set: {
            sequence: args.sequence,
            nodeKind: args.nodeKind,
            status: args.status,
            output: args.output ?? {},
            branchResult: args.branchResult ?? null,
            meta: args.meta ?? {},
            costUsdAtRun,
            ...promoted,
            ...startedAtSet,
            finishedAt,
            error: args.error ?? null,
          },
        })
    },
  }
}
