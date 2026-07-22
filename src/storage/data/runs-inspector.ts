import { asc, eq } from 'drizzle-orm'

import type { WfDb } from '../client'
import { stepCost } from '../cost'
import { wfRun, wfRunStep, wfWorkflow, wfWorkflowVersion } from '../schema'

import { parseStoredGraph } from './authoring'
import { loadModelPriceMap } from './runs-cost'
import { getRunLogs } from './runs-logs'

// ---------------------------------------------------------------------------
// Run inspector — the single-run load shape (run, steps, logs, graph, cost)
// ---------------------------------------------------------------------------

/** The run-inspector load shape: run, ordered steps, the version's graph. */
export async function getRun(db: WfDb, runId: string) {
  const run = (
    await db.select().from(wfRun).where(eq(wfRun.id, runId)).limit(1)
  )[0]
  if (!run) {
    return null
  }
  const rawSteps = await db
    .select()
    .from(wfRunStep)
    .where(eq(wfRunStep.runId, runId))
    .orderBy(asc(wfRunStep.sequence))
  // Derive each step's dollar cost from its token usage × the model's catalog
  // price, and roll the run's totals up for the header.
  const priceMap = await loadModelPriceMap(db)
  let costUsd: number | null = null
  let totalTokens: number | null = null
  const steps = rawSteps.map((s) => {
    const c = stepCost(s.meta, priceMap)
    if (c) {
      totalTokens = (totalTokens ?? 0) + c.tokens
      if (c.cost != null) costUsd = (costUsd ?? 0) + c.cost
    }
    // `-1` is the top-level sentinel (see wfRunStep) — surface it as null so the
    // client's `itemIndex: number | null` reads naturally.
    return {
      ...s,
      itemIndex: s.itemIndex === -1 ? null : s.itemIndex,
      costUsd: c?.cost ?? null,
    }
  })
  const logs = await getRunLogs(db, runId)
  const version = (
    await db
      .select()
      .from(wfWorkflowVersion)
      .where(eq(wfWorkflowVersion.id, run.workflowVersionId))
      .limit(1)
  )[0]
  const workflow = version
    ? (
        await db
          .select({ id: wfWorkflow.id, name: wfWorkflow.name })
          .from(wfWorkflow)
          .where(eq(wfWorkflow.id, version.workflowId))
          .limit(1)
      )[0]
    : undefined
  return {
    run,
    steps,
    logs,
    graph: version?.graph != null ? parseStoredGraph(version.graph) : null,
    versionNumber: version?.versionNumber ?? null,
    workflowId: workflow?.id ?? null,
    workflowName: workflow?.name ?? null,
    costUsd,
    totalTokens,
  }
}
