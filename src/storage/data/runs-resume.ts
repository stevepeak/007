import { and, asc, eq } from 'drizzle-orm'

import type { WfRunManifestEntry } from '../../engine/graph'
import { RUN_STATE_LEVEL } from '../../engine/stream-sink'
import type { WfDb } from '../client'
import { wfRun, wfRunLog, wfRunStep } from '../schema'

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

// ---------------------------------------------------------------------------
// In-place resume — the inline engine picking a run back up after its Durable
// Object was restarted mid-walk (a deploy, an eviction). Same `wf_run`, same
// completed steps; only the interrupted node and what follows it re-execute.
// ---------------------------------------------------------------------------

/** The manifest frozen onto the run at its first start, or null if the first
 *  attempt died before `setRunManifest`. */
export async function getRunManifest(
  db: WfDb,
  runId: string,
): Promise<WfRunManifestEntry[] | null> {
  const [row] = await db
    .select({ manifest: wfRun.manifest })
    .from(wfRun)
    .where(eq(wfRun.id, runId))
    .limit(1)
  return (row?.manifest as WfRunManifestEntry[] | null | undefined) ?? null
}

/**
 * Record that an interrupted run is being resumed in place.
 *
 * Three writes, each idempotent:
 *   • the steps the dead attempt left at `running` become `failed` with the
 *     reason — a viewer then sees what happened instead of a node that is
 *     "still running" forever. A resumed node overwrites its row when it
 *     re-executes (the recorder upserts on run/node/item), so this only
 *     matters for a node the resume never reaches.
 *   • the run row is `running` again (it may have died at `queued`).
 *   • a node-less feed marker, one per attempt, so the activity feed says
 *     "resumed after a restart" at the moment it happened.
 */
export async function markRunResumed(
  db: WfDb,
  input: { runId: string; attempt: number; reason: string },
): Promise<void> {
  const { runId, attempt, reason } = input
  const now = new Date()
  await db
    .update(wfRunStep)
    .set({ status: 'failed', error: reason, finishedAt: now })
    .where(and(eq(wfRunStep.runId, runId), eq(wfRunStep.status, 'running')))
  await db
    .update(wfRun)
    .set({ status: 'running', error: null })
    .where(eq(wfRun.id, runId))
  const row = {
    id: `${runId}:run:resumed:${attempt}`,
    runId,
    nodeId: null,
    nodeKind: null,
    sequence: null,
    level: RUN_STATE_LEVEL,
    message: `Workflow resumed — ${reason} (attempt ${attempt})`,
    meta: { status: 'running' as const, resumed: attempt, reason },
    ts: now.getTime(),
  }
  try {
    await db
      .insert(wfRunLog)
      .values(row)
      .onConflictDoUpdate({
        target: wfRunLog.id,
        set: { message: row.message, meta: row.meta, ts: row.ts },
      })
  } catch (err) {
    console.warn('[wf] run resume marker not recorded:', err)
  }
}
