import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'

import type { WfDb } from '../client'
import { wfSchema } from '../schema'
import {
  appendRunLog,
  countNodeBodyLogs,
  getRunLogs,
  getRunProgressFeed,
  replaceNodeLogs,
  type WfRunLogRow,
} from './runs-logs'

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

const RUN = 'run-1'
const NODE = 'node-a'

function entry(
  level: string,
  message: string,
  ts: number,
): WfRunLogRow {
  return {
    nodeId: NODE,
    nodeKind: 'agent',
    sequence: 1,
    level,
    message,
    meta: null,
    ts,
  }
}

// Emit a node's feed the way the per-node sink does: one `run:` ATTEMPT, whose
// ordinals start at however many body rows the node has already written (0 on a
// first attempt, N on a retry — so the attempts don't overwrite each other).
async function attempt(db: WfDb, entries: WfRunLogRow[]): Promise<void> {
  let ordinal = await countNodeBodyLogs(db, { runId: RUN, nodeId: NODE })
  for (const e of entries) {
    await appendRunLog(db, {
      runId: RUN,
      nodeId: NODE,
      ordinal: ordinal++,
      entry: e,
    })
  }
}

describe('live run-log appends', () => {
  let db: WfDb

  beforeEach(() => {
    db = freshDb()
  })

  test('an appended entry is readable before the node finishes', async () => {
    await attempt(db, [entry('info', '→ model', 10)])

    const logs = await getRunLogs(db, RUN)
    expect(logs.map((l) => l.message)).toEqual(['→ model'])
  })

  test('a retry keeps the abandoned attempt instead of overwriting it', async () => {
    // Attempt 1 gets killed (e.g. the step timeout) partway through…
    await attempt(db, [
      entry('info', '→ model', 10),
      entry('tool', 'Called search', 20),
    ])
    // …and the whole closure runs again. Its rows must land alongside, not on
    // top of, attempt 1's — that record is the only evidence of what the node
    // was doing when it died.
    await attempt(db, [
      entry('warn', '⟲ Restarting Chat Bot', 30),
      entry('info', '→ model', 40),
    ])

    const logs = await getRunLogs(db, RUN)
    expect(logs.map((l) => l.message)).toEqual([
      '→ model',
      'Called search',
      '⟲ Restarting Chat Bot',
      '→ model',
    ])
  })

  test('countNodeBodyLogs ignores the node-start bookend', async () => {
    // The `enter:` step writes node-start before the body ever runs; a first
    // attempt must still see a base of 0 (and so report itself as no retry).
    await replaceNodeLogs(db, {
      runId: RUN,
      nodeId: NODE,
      entries: [entry('node-start', '▶ Chat Bot', 5)],
    })
    expect(await countNodeBodyLogs(db, { runId: RUN, nodeId: NODE })).toBe(0)

    await attempt(db, [entry('info', '→ model', 10)])
    expect(await countNodeBodyLogs(db, { runId: RUN, nodeId: NODE })).toBe(1)
  })

  test('the terminal rewrite supersedes whatever the live path wrote', async () => {
    await attempt(db, [
      entry('info', '→ model', 10),
      entry('tool', 'Called search', 20),
    ])
    // `record:` — the authoritative feed for the settled node.
    await replaceNodeLogs(db, {
      runId: RUN,
      nodeId: NODE,
      entries: [
        entry('node-start', '▶ Chat Bot', 5),
        entry('info', '→ model', 10),
        entry('tool', 'Called search', 20),
        entry('node-end', '✓ Chat Bot', 30),
      ],
    })

    const logs = await getRunLogs(db, RUN)
    expect(logs.map((l) => l.message)).toEqual([
      '▶ Chat Bot',
      '→ model',
      'Called search',
      '✓ Chat Bot',
    ])
  })

  test('live progress lines reach the user-facing feed mid-run', async () => {
    await db.insert(wfSchema.wfRun).values({
      id: RUN,
      workflowVersionId: 'v1',
      triggerKind: 'chat_message',
      status: 'running',
      correlationId: 'org-1',
    })
    await attempt(db, [
      entry('info', '→ model', 10),
      entry('progress', 'Searching knowledge base', 20),
    ])

    const feed = await getRunProgressFeed(db, RUN)
    // Only the curated `progress` level surfaces — and it does so while the
    // run is still running, which is the whole point.
    expect(feed?.status).toBe('running')
    expect(feed?.lines).toEqual(['Searching knowledge base'])
  })
})
