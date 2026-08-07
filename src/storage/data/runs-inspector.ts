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

/**
 * Settle-check shape for poll loops: the three fields a waiter acts on, read
 * off one indexed row. {@link getRun} is the *inspector* load — every step,
 * every log, the version's whole graph blob, and the model price map — and is
 * far too heavy to call on a timer. Anything that only needs to notice a run
 * finished belongs here. Returns null when the run row is absent.
 */
export async function getRunStatus(db: WfDb, runId: string) {
  const row = (
    await db
      .select({
        status: wfRun.status,
        output: wfRun.output,
        error: wfRun.error,
      })
      .from(wfRun)
      .where(eq(wfRun.id, runId))
      .limit(1)
  )[0]
  return row ?? null
}

/** The run-inspector load shape: run, ordered steps, the version's graph. */
export async function getRun(db: WfDb, runId: string) {
  const run = (
    await db.select().from(wfRun).where(eq(wfRun.id, runId)).limit(1)
  )[0]
  if (!run) {
    return null
  }
  // Everything below depends only on the run row, so it goes out in one wave
  // rather than four sequential round trips. Only the workflow-name lookup has
  // to wait, since it keys off the version row.
  const [rawSteps, priceMap, logs, version] = await Promise.all([
    db
      .select()
      .from(wfRunStep)
      .where(eq(wfRunStep.runId, runId))
      .orderBy(asc(wfRunStep.sequence)),
    // Derive each step's dollar cost from its token usage × the model's catalog
    // price, and roll the run's totals up for the header.
    loadModelPriceMap(db),
    getRunLogs(db, runId),
    db
      .select()
      .from(wfWorkflowVersion)
      .where(eq(wfWorkflowVersion.id, run.workflowVersionId))
      .limit(1)
      .then((rows) => rows[0]),
  ])
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
