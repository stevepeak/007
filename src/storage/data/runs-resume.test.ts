import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { eq } from 'drizzle-orm'

import type { WfRunManifestEntry } from '../../engine/graph'
import type { WfDb } from '../client'
import {
  wfRun,
  wfRunLog,
  wfRunStep,
  wfSchema,
  wfWorkflow,
  wfWorkflowVersion,
} from '../schema'

import { getRunManifest, loadResumeSteps, markRunResumed } from './runs-resume'

// The storage half of an in-place resume: what a run interrupted mid-walk looks
// like before and after the room picks it back up.

const MIGRATIONS_DIR = fileURLToPath(
  new URL('../../../migrations', import.meta.url),
)

function freshDb(): WfDb {
  const sqlite = new Database(':memory:')
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
  for (const f of files) {
    const sql = readFileSync(`${MIGRATIONS_DIR}/${f}`, 'utf8')
    for (const stmt of sql.split('--> statement-breakpoint')) {
      const trimmed = stmt.trim()
      if (trimmed) sqlite.run(trimmed)
    }
  }
  return drizzle(sqlite, { schema: wfSchema }) as unknown as WfDb
}

let db: WfDb

const MANIFEST = [
  { kind: 'agent', id: 'a1', versionId: 'av-3', versionNumber: 3, config: {} },
] as unknown as WfRunManifestEntry[]

beforeEach(async () => {
  db = freshDb()
  await db.insert(wfWorkflow).values({ id: 'wf-1', name: 'Chat' })
  await db
    .insert(wfWorkflowVersion)
    .values({ id: 'v-1', workflowId: 'wf-1', versionNumber: 1, graph: {} })
  await db.insert(wfRun).values({
    id: 'run-1',
    workflowVersionId: 'v-1',
    triggerKind: 'chat',
    status: 'running',
    manifest: MANIFEST,
  })
  // What the dead attempt left behind: two finished nodes, one mid-flight.
  await db.insert(wfRunStep).values([
    {
      runId: 'run-1',
      nodeId: 't',
      nodeKind: 'trigger',
      sequence: 0,
      status: 'completed',
      output: { n: 1 },
    },
    {
      runId: 'run-1',
      nodeId: 'b',
      nodeKind: 'branch',
      sequence: 1,
      status: 'completed',
      input: { n: 1 },
      output: { result: 'yes', reasoning: 'n is 1' },
      branchResult: { result: 'yes', reasoning: 'n is 1' },
    },
    {
      runId: 'run-1',
      nodeId: 'research',
      nodeKind: 'agent',
      sequence: 2,
      status: 'running',
    },
  ])
})

describe('markRunResumed', () => {
  test('closes the orphaned running step, keeps the run running, marks the feed', async () => {
    await markRunResumed(db, {
      runId: 'run-1',
      attempt: 1,
      reason: 'interrupted by a worker restart',
    })

    const steps = await db
      .select()
      .from(wfRunStep)
      .where(eq(wfRunStep.runId, 'run-1'))
    const orphan = steps.find((s) => s.nodeId === 'research')
    expect(orphan?.status).toBe('failed')
    expect(orphan?.error).toBe('interrupted by a worker restart')
    expect(orphan?.finishedAt).not.toBeNull()
    // The finished ones are untouched.
    expect(steps.find((s) => s.nodeId === 'b')?.status).toBe('completed')

    const [run] = await db.select().from(wfRun).where(eq(wfRun.id, 'run-1'))
    expect(run.status).toBe('running')

    const [marker] = await db
      .select()
      .from(wfRunLog)
      .where(eq(wfRunLog.id, 'run-1:run:resumed:1'))
    expect(marker.level).toBe('state')
    expect(marker.message).toContain('resumed')
    expect(marker.meta).toEqual({
      status: 'running',
      resumed: 1,
      reason: 'interrupted by a worker restart',
    })
  })

  test('is idempotent per attempt', async () => {
    const args = { runId: 'run-1', attempt: 1, reason: 'restart' }
    await markRunResumed(db, args)
    await markRunResumed(db, args)
    const markers = await db
      .select()
      .from(wfRunLog)
      .where(eq(wfRunLog.runId, 'run-1'))
    expect(markers).toHaveLength(1)
  })
})

describe('what the resumed walk is seeded with', () => {
  test('loadResumeSteps returns only the completed non-trigger steps, in order', async () => {
    await markRunResumed(db, { runId: 'run-1', attempt: 1, reason: 'restart' })
    const steps = await loadResumeSteps(db, 'run-1')
    expect(steps.map((s) => s.nodeId)).toEqual(['b'])
    expect(steps[0].branchResult).toEqual({
      result: 'yes',
      reasoning: 'n is 1',
    })
  })

  test('getRunManifest reads back the frozen manifest', async () => {
    expect(await getRunManifest(db, 'run-1')).toEqual(MANIFEST)
    expect(await getRunManifest(db, 'nope')).toBeNull()
  })
})
