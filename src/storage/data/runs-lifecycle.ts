import { eq } from 'drizzle-orm'

import type { WfRunManifestEntry } from '../../engine/graph'
import type { WfDb } from '../client'
import { wfRun } from '../schema'

// Run creation + status transitions: the queued row a trigger writes, the
// frozen reference manifest, and the running/completed/failed lifecycle marks.
// Pure functions over a `WfDb` handle.
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
    isEval: input.isEval ?? false,
    sentryTraceId: input.sentryTraceId ?? null,
    status: 'queued',
  })
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
}

export async function finalizeRun(
  db: WfDb,
  input: { runId: string; output: unknown },
) {
  await db
    .update(wfRun)
    .set({
      status: 'completed',
      output: input.output ?? {},
      finishedAt: new Date(),
    })
    .where(eq(wfRun.id, input.runId))
}

export async function failRun(
  db: WfDb,
  input: { runId: string; error: string },
) {
  await db
    .update(wfRun)
    .set({ status: 'failed', error: input.error, finishedAt: new Date() })
    .where(eq(wfRun.id, input.runId))
}
