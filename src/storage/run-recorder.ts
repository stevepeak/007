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

export function createDurableRunRecorder(deps: {
  db: WfDb
  runId: string
}): RunRecorder {
  return {
    async record(args) {
      const finishedAt =
        args.finishedAt ?? (isTerminal(args.status) ? new Date() : null)
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
            finishedAt,
            error: args.error ?? null,
          },
        })
    },
  }
}
