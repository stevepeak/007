import { and, asc, eq } from 'drizzle-orm'

import type { WfDb } from '../client'
import { wfRunStep } from '../schema'

import { latestVersion } from './authoring'

// ---------------------------------------------------------------------------
// Retry / resume support — latest version target + completed-step replay
// ---------------------------------------------------------------------------

/**
 * The workflow's latest (highest-numbered) version id — the target of a "retry
 * with the upgraded workflow" restart, which starts fresh on whatever is
 * current rather than the version the failed run froze. Null if the workflow
 * has no versions.
 */
export async function getLatestVersionId(
  db: WfDb,
  workflowId: string,
): Promise<string | null> {
  const v = await latestVersion(db, workflowId)
  return v?.id ?? null
}

/**
 * The completed steps of a prior run, in walk order — used to seed a resume.
 * The GraphWorkflow replays each into the scheduler (`report`) so those nodes
 * are treated as done and execution picks up at the first not-yet-completed
 * node (the one that failed). Excludes the trigger (seeded separately from the
 * trigger input) and any terminal Output.
 */
export async function loadResumeSteps(db: WfDb, runId: string) {
  const rows = await db
    .select({
      nodeId: wfRunStep.nodeId,
      nodeKind: wfRunStep.nodeKind,
      sequence: wfRunStep.sequence,
      input: wfRunStep.input,
      output: wfRunStep.output,
      meta: wfRunStep.meta,
      branchResult: wfRunStep.branchResult,
    })
    .from(wfRunStep)
    .where(
      and(
        eq(wfRunStep.runId, runId),
        eq(wfRunStep.status, 'completed'),
        // Top-level steps only (sentinel -1): resume seeds the top-level
        // scheduler, never an iteration's inner subgraph nodes.
        eq(wfRunStep.itemIndex, -1),
      ),
    )
    .orderBy(asc(wfRunStep.sequence))
  return rows.filter((r) => r.nodeKind !== 'trigger' && r.nodeKind !== 'output')
}
