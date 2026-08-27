import { and, asc, desc, eq, getTableColumns, isNull, sql } from 'drizzle-orm'

import type { WfDb } from '../client'
import { stepCost } from '../cost'
import {
  wfRun,
  wfRunLog,
  wfRunStep,
  wfWorkflow,
  wfWorkflowVersion,
} from '../schema'

import { parseStoredGraph } from './authoring'
import { countChildRuns } from './runs-children'
import { loadModelPriceMap } from './runs-cost'
import { getRunLogs } from './runs-logs'
import { rollUpRunCost } from './runs-rollup'

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

/**
 * When this run last showed a sign of life: the newest `wf_run_log.ts`, or null
 * for a run that has not written a single feed entry.
 *
 * The companion to {@link getRunStatus} for a waiter that has to decide whether
 * a run still sitting at `running` is working or dead. `wf_run` cannot answer
 * that — it has `createdAt` / `startedAt` / `finishedAt` and no `updatedAt`, so
 * the only clock on it runs from the moment the run began, which says nothing
 * about whether anything has happened since.
 *
 * `wf_run_log` can, because it is written THROUGHOUT a node rather than at its
 * end: `appendRunLog` persists every entry as the node emits it (each model
 * round-trip, each tool call), and `recordRunStateChange` drops a marker at
 * every lifecycle transition. Its `(run_id, ts)` index makes this a reverse
 * index scan stopping at the first row — `ORDER BY ts DESC LIMIT 1` rather than
 * `MAX(ts)` to keep it that way.
 *
 * Beware the granularity: entries land per model round-trip, not continuously.
 * A caller's idle threshold must therefore exceed the longest legitimate
 * silence between two entries, which is a whole model round-trip
 * (`MAX_ROUND_TRIP_MS`) and not a small number.
 */
export async function getRunLastActivityAt(
  db: WfDb,
  runId: string,
): Promise<number | null> {
  const row = (
    await db
      .select({ ts: wfRunLog.ts })
      .from(wfRunLog)
      .where(eq(wfRunLog.runId, runId))
      .orderBy(desc(wfRunLog.ts))
      .limit(1)
  )[0]
  return row?.ts ?? null
}

export type GetRunOptions = {
  /**
   * A `workflowVersionId` the caller already holds the version block for
   * (graph, version number, workflow identity). When it matches this run's
   * version, that lookup is skipped entirely and the block comes back null with
   * `versionOmitted: true` — the caller is expected to splice in what it has.
   *
   * The block is immutable for a given version id, so re-reading it on a 1.5s
   * poll is pure waste: it is both a query and, because the whole serialized
   * graph rides along, by far the largest thing in the response. Omit this
   * option (every non-polling caller does) to always get the full load.
   */
  knownVersionId?: string
  /**
   * Settled-step watermark for pollers: the highest step `cursor` below which
   * the caller already holds every step AND every one of them is terminal.
   * Steps at or below it are not returned, and the result carries
   * `stepsPartial: true` so the caller knows to merge rather than replace.
   *
   * Why a *settled* watermark and not simply "steps I've seen": `wf_run_step`
   * is upserted on `(run_id, node_id, item_index)`, so a row mutates in place
   * from `running` to its terminal status. Cursoring on "seen" would freeze
   * every in-flight step at its first-seen state — the canvas glow, per-node
   * status and per-step cost would all stop updating. Only `completed` and
   * `skipped` rows are immutable; `failed` is not (a resume can re-run it).
   *
   * See {@link WfRunStepDTO.cursor} for why the key is insert order rather than
   * `sequence`, which is NOT unique within a run.
   */
  settledStepCursor?: number
}

/**
 * Insert-order key for a step row, projected from SQLite's implicit `rowid`.
 *
 * `sequence` cannot serve as this key: it is a per-walk counter, and an
 * iteration's per-item subgraph and a sub-agent's child steps each restart it
 * at 0 (see `nodes/iteration.ts` and `nodes/sub-agent.ts`). A 500-item
 * iteration therefore has 500 rows at sequence 0 — precisely the run shape the
 * incremental read exists to serve.
 *
 * `rowid` has the property the cursor needs: SQLite assigns it as one greater
 * than the largest in the table, so a step inserted later can never sort below
 * one inserted earlier, and an upsert UPDATEs in place without changing it.
 * Rowid reuse after a delete can't reach a live watermark either — a watermark
 * is always a row the caller still holds, so that row's rowid still exists and
 * still bounds the next assignment. The only paths that delete steps
 * (`deleteAllRuns`, deleting a workflow's runs) remove whole runs, after which
 * the run reads as absent rather than as a partial set.
 */
const stepCursor = sql<number>`wf_run_step.rowid`

/** The run-inspector load shape: run, ordered steps, the version's graph. */
export async function getRun(
  db: WfDb,
  runId: string,
  opts: GetRunOptions = {},
) {
  const run = (
    await db.select().from(wfRun).where(eq(wfRun.id, runId)).limit(1)
  )[0]
  if (!run) {
    return null
  }
  const versionOmitted = opts.knownVersionId === run.workflowVersionId
  // Everything below depends only on the run row, so it goes out in ONE wave.
  // The version and the workflow it belongs to are a single join rather than a
  // second sequential round trip — the name lookup used to wait on the version
  // row purely to read its `workflowId`.
  const [rawSteps, priceMap, logRead, version, childCounts] = await Promise.all([
    db
      .select({ ...getTableColumns(wfRunStep), cursor: stepCursor })
      .from(wfRunStep)
      .where(eq(wfRunStep.runId, runId))
      .orderBy(asc(wfRunStep.sequence)),
    // Derive each step's dollar cost from its token usage × the model's catalog
    // price, and roll the run's totals up for the header.
    loadModelPriceMap(db),
    getRunLogs(db, runId),
    versionOmitted
      ? undefined
      : db
          .select({
            graph: wfWorkflowVersion.graph,
            versionNumber: wfWorkflowVersion.versionNumber,
            workflowId: wfWorkflow.id,
            workflowName: wfWorkflow.name,
          })
          .from(wfWorkflowVersion)
          .leftJoin(
            wfWorkflow,
            eq(wfWorkflow.id, wfWorkflowVersion.workflowId),
          )
          .where(eq(wfWorkflowVersion.id, run.workflowVersionId))
          .limit(1)
          .then((rows) => rows[0]),
    // Rides in the same wave: one grouped read over `wf_run_parent_idx` that
    // tells us whether this run spawned anything, so the roll-up below is only
    // paid for by the runs that have a tree to roll up.
    countChildRuns(db, [runId]),
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
  // The roll-up above has to visit EVERY step, so the watermark trims what goes
  // over the wire and what the client re-parses each tick, not what D1 reads.
  // A rows-read win would need the cost totals to be incremental too, and they
  // can't be: a step's cost changes when its `meta` lands, in place.
  // What the run cost INCLUDING its children. Null for a run that spawned
  // none, where it would be identical to the own totals just derived.
  const tree =
    (childCounts.get(runId)?.total ?? 0) > 0
      ? ((await rollUpRunCost(db, [runId])).get(runId) ?? null)
      : null
  const stepsPartial = opts.settledStepCursor != null
  const shippedSteps = stepsPartial
    ? steps.filter((s) => s.cursor > (opts.settledStepCursor as number))
    : steps
  return {
    run,
    steps: shippedSteps,
    /** True when `settledStepCursor` was supplied: `steps` is a delta to merge. */
    stepsPartial,
    logs: logRead.rows,
    /** True when the feed outgrew the read cap and its oldest entries are gone. */
    logsTruncated: logRead.truncated,
    graph: version?.graph != null ? parseStoredGraph(version.graph) : null,
    versionNumber: version?.versionNumber ?? null,
    workflowId: version?.workflowId ?? null,
    workflowName: version?.workflowName ?? null,
    /** The version this run is pinned to — the cache key for the block above. */
    workflowVersionId: run.workflowVersionId,
    /** True when the four version-derived fields were deliberately not read. */
    versionOmitted,
    costUsd,
    totalTokens,
    tree,
  }
}

// ---------------------------------------------------------------------------
// Narrow reads — the in-process callers that never wanted the inspector load
// ---------------------------------------------------------------------------
//
// Both of the functions below used to call `getRun` and throw away almost all
// of it. That is the same waste `getRunStatus` exists to prevent, one layer up:
// a server-side caller paying for every step, every log, the whole serialized
// graph and the model price map to read one field. Neither is on a poll loop,
// but `gradeEvalResult` fires once per eval cell — on top of that cell's poll.

/**
 * Everything `retryRun` needs to re-dispatch a run: the run row's own
 * identifiers, the workflow the run's version belongs to, and the trigger input
 * (which the run row doesn't persist — it is recovered from the recorded
 * trigger step, whose output is the validated trigger input; see executor.ts).
 *
 * The trigger step is matched on `parentNodeId IS NULL`, not on sequence order.
 * An iteration's per-item subgraph and a sub-agent's child runs record their own
 * `trigger`-kind steps, and every one of them carries `sequence: 0` — the same
 * sequence as the run's real trigger. Picking the first `nodeKind === 'trigger'`
 * out of a sequence-ordered list, as this path used to, could therefore retry a
 * run with one iteration item's input in place of the run's own.
 */
export async function getRunRetrySource(db: WfDb, runId: string) {
  const run = (
    await db
      .select({
        workflowVersionId: wfRun.workflowVersionId,
        triggerKind: wfRun.triggerKind,
        subjectId: wfRun.subjectId,
        correlationId: wfRun.correlationId,
      })
      .from(wfRun)
      .where(eq(wfRun.id, runId))
      .limit(1)
  )[0]
  if (!run) {
    return null
  }
  const [trigger, version] = await Promise.all([
    db
      .select({ input: wfRunStep.input, output: wfRunStep.output })
      .from(wfRunStep)
      .where(
        and(
          eq(wfRunStep.runId, runId),
          eq(wfRunStep.nodeKind, 'trigger'),
          isNull(wfRunStep.parentNodeId),
        ),
      )
      .limit(1)
      .then((rows) => rows[0]),
    db
      .select({ workflowId: wfWorkflowVersion.workflowId })
      .from(wfWorkflowVersion)
      .where(eq(wfWorkflowVersion.id, run.workflowVersionId))
      .limit(1)
      .then((rows) => rows[0]),
  ])
  return {
    ...run,
    workflowId: version?.workflowId ?? null,
    // Both backends record the trigger with its validated input as BOTH the
    // step's input and its output, so these agree whenever a trigger step
    // exists; `input` is kept only as a guard against a backend recording just
    // one of them. `{}` covers a run with no recorded trigger at all — a run
    // that died before its first write has nothing to replay.
    triggerInput: trigger?.output ?? trigger?.input ?? {},
  }
}

/**
 * What an eval judge grades: the run's final output plus its TOP-LEVEL steps.
 *
 * Iteration inner-subgraph steps are excluded in SQL rather than filtered after
 * the fact — checks address the workflow's own nodes, never an iteration's
 * per-item copies, and on a wide iteration those copies are the overwhelming
 * majority of the rows. No logs, no graph, no price map: a judge reads none of
 * them.
 */
export async function getRunForGrading(db: WfDb, runId: string) {
  const run = (
    await db
      .select({ output: wfRun.output })
      .from(wfRun)
      .where(eq(wfRun.id, runId))
      .limit(1)
  )[0]
  if (!run) {
    return null
  }
  const steps = await db
    .select({
      nodeId: wfRunStep.nodeId,
      nodeKind: wfRunStep.nodeKind,
      input: wfRunStep.input,
      output: wfRunStep.output,
      meta: wfRunStep.meta,
    })
    .from(wfRunStep)
    .where(and(eq(wfRunStep.runId, runId), isNull(wfRunStep.parentNodeId)))
    .orderBy(asc(wfRunStep.sequence))
  return { output: run.output, steps }
}
