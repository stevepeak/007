import { eq } from 'drizzle-orm'

import type { WfRunManifestEntry } from '../../engine/graph'
import type { WfDb } from '../client'
import { wfRun } from '../schema'
import { recordRunStateChange } from './runs-logs'

// Run creation + status transitions: the queued row a trigger writes, the
// frozen reference manifest, and the running/completed/failed lifecycle marks.
// Pure functions over a `WfDb` handle.
//
// Every transition also drops a marker into the run's log feed
// (`recordRunStateChange`), written HERE rather than at the call sites so the
// marker cannot drift from the status it describes — and so both engines get it
// without either backend knowing about it. The marker write never throws.
// ---------------------------------------------------------------------------
// Runs + steps
// ---------------------------------------------------------------------------

export async function createRun(
  db: WfDb,
  input: {
    workflowVersionId: string
    triggerKind: string
    subjectId?: string
    correlationId?: string
    /** The host principal this run acts for; opaque, see `RunContext.actorId`. */
    actorId?: string
    /** Marks this as an eval-produced run so the Runs explorer excludes it. */
    isEval?: boolean
    /** Stable 32-hex trace id for the run's Sentry spans + deep-link. */
    sentryTraceId?: string
  },
): Promise<string> {
  const id = crypto.randomUUID()
  await db.insert(wfRun).values({
    id,
    workflowVersionId: input.workflowVersionId,
    triggerKind: input.triggerKind,
    subjectId: input.subjectId ?? null,
    correlationId: input.correlationId ?? null,
    actorId: input.actorId ?? null,
    isEval: input.isEval ?? false,
    sentryTraceId: input.sentryTraceId ?? null,
    status: 'queued',
  })
  await recordRunStateChange(db, { runId: id, status: 'queued' })
  return id
}

/** Freeze the resolved reference manifest onto the run (once, at run start). */
export async function setRunManifest(
  db: WfDb,
  input: { runId: string; manifest: WfRunManifestEntry[] },
) {
  await db
    .update(wfRun)
    .set({ manifest: input.manifest })
    .where(eq(wfRun.id, input.runId))
}

export async function markRunRunning(
  db: WfDb,
  input: { runId: string; cloudflareRunId?: string },
) {
  await db
    .update(wfRun)
    .set({
      status: 'running',
      startedAt: new Date(),
      cloudflareRunId: input.cloudflareRunId ?? null,
    })
    .where(eq(wfRun.id, input.runId))
  await recordRunStateChange(db, { runId: input.runId, status: 'running' })
}

/**
 * The Output was reached: persist the answer and mark the run `done`.
 *
 * `finishedAt` is stamped HERE, not when the last background arm settles — it
 * is the number every latency question is really asking about ("how long until
 * there was an answer"), and a fire-and-forget arm that runs for another minute
 * shouldn't inflate it.
 *
 * Callers that know nothing is left to run pass `settled: true` and go straight
 * to `completed`, so an ordinary run still settles in one write.
 */
export async function markRunDone(
  db: WfDb,
  input: {
    runId: string
    output: unknown
    settled?: boolean
    /** Nodes still running behind the answer, for the `done` marker. */
    pendingNodes?: number
  },
) {
  await db
    .update(wfRun)
    .set({
      status: input.settled ? 'completed' : 'done',
      output: input.output ?? {},
      finishedAt: new Date(),
    })
    .where(eq(wfRun.id, input.runId))
  await recordRunStateChange(db, {
    runId: input.runId,
    status: input.settled ? 'completed' : 'done',
    pendingNodes: input.settled ? undefined : (input.pendingNodes ?? 0),
  })
}

/**
 * Every arm has run itself out — the run is `completed`.
 *
 * `error` records an arm that broke AFTER the answer was delivered. The run is
 * still completed, not failed: the caller received a correct answer and cannot
 * un-receive it. The failing node's own step row carries the detail; this just
 * keeps the run row honest about the background work having broken.
 */
export async function completeRun(
  db: WfDb,
  input: { runId: string; error?: string },
) {
  await db
    .update(wfRun)
    .set({ status: 'completed', ...(input.error ? { error: input.error } : {}) })
    .where(eq(wfRun.id, input.runId))
  await recordRunStateChange(db, {
    runId: input.runId,
    status: 'completed',
    detail: input.error ? `a background arm failed: ${input.error}` : undefined,
  })
}

export async function failRun(
  db: WfDb,
  input: { runId: string; error: string },
) {
  await db
    .update(wfRun)
    .set({ status: 'failed', error: input.error, finishedAt: new Date() })
    .where(eq(wfRun.id, input.runId))
  await recordRunStateChange(db, {
    runId: input.runId,
    status: 'failed',
    detail: input.error,
  })
}
