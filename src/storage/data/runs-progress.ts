import { asc, eq } from 'drizzle-orm'

import {
  deriveRunProgress,
  type WfRunProgress,
} from '../../engine/run-progress'
import type { WfDb } from '../client'
import { wfRun, wfRunStep, wfWorkflowVersion } from '../schema'

import { parseStoredGraph } from './authoring'

// ---------------------------------------------------------------------------
// Run progress — the lightweight "where is this run" summary the host polls to
// drive a progress bar / activity label (e.g. a processing toast). Deliberately
// cheaper than `getRun`: it selects only the columns progress needs (no logs,
// no per-step cost/token rollup) and returns the derived shape directly.
// ---------------------------------------------------------------------------

/**
 * Load a run's coarse progress: overall status, the currently-active node's
 * label, and a completed/total node count. Returns `null` when the run id is
 * unknown. Safe to poll on a short interval.
 */
export async function getRunProgress(
  db: WfDb,
  runId: string,
): Promise<WfRunProgress | null> {
  const run = (
    await db
      .select({
        status: wfRun.status,
        workflowVersionId: wfRun.workflowVersionId,
      })
      .from(wfRun)
      .where(eq(wfRun.id, runId))
      .limit(1)
  )[0]
  if (!run) return null

  const steps = await db
    .select({
      nodeId: wfRunStep.nodeId,
      nodeKind: wfRunStep.nodeKind,
      parentNodeId: wfRunStep.parentNodeId,
      status: wfRunStep.status,
      sequence: wfRunStep.sequence,
    })
    .from(wfRunStep)
    .where(eq(wfRunStep.runId, runId))
    .orderBy(asc(wfRunStep.sequence))

  const version = (
    await db
      .select({ graph: wfWorkflowVersion.graph })
      .from(wfWorkflowVersion)
      .where(eq(wfWorkflowVersion.id, run.workflowVersionId))
      .limit(1)
  )[0]
  const graph = version?.graph != null ? parseStoredGraph(version.graph) : null

  return deriveRunProgress({ status: run.status, graph, steps })
}
