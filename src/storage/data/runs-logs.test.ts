import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'

import type { WfDb } from '../client'
import { wfSchema } from '../schema'
import {
  appendRunLog,
  clearNodeBodyLogs,
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

// Emit a node's feed the way the per-node sink does: an ordinal per entry,
// counting from 0 at the top of each `run:` attempt.
async function emit(
  db: WfDb,
  entries: WfRunLogRow[],
  opts: { clearFirst?: boolean } = {},
): Promise<void> {
  if (opts.clearFirst) await clearNodeBodyLogs(db, { runId: RUN, nodeId: NODE })
  let ordinal = 0
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
    await emit(db, [entry('info', '→ model', 10)])

    const logs = await getRunLogs(db, RUN)
    expect(logs.map((l) => l.message)).toEqual(['→ model'])
  })

  test('a replayed attempt rewrites its rows instead of duplicating them', async () => {
    const attempt = [
      entry('info', '→ model', 10),
      entry('tool', 'Called search', 20),
    ]
    await emit(db, attempt, { clearFirst: true })
    // `step.do` retry: the whole closure runs again, emitting the same feed.
    await emit(db, attempt, { clearFirst: true })

    const logs = await getRunLogs(db, RUN)
    expect(logs.map((l) => l.message)).toEqual(['→ model', 'Called search'])
  })

  test('a shorter retry leaves no tail from the longer attempt', async () => {
    await emit(
      db,
      [
        entry('info', '→ model', 10),
        entry('tool', 'Called search', 20),
        entry('tool', 'Called fetch', 30),
      ],
      { clearFirst: true },
    )
    await emit(db, [entry('info', '→ model', 40)], { clearFirst: true })

    const logs = await getRunLogs(db, RUN)
    expect(logs.map((l) => l.message)).toEqual(['→ model'])
  })

  test('clearNodeBodyLogs keeps the node-start bookend', async () => {
    // The `enter:` step writes node-start before the body ever runs.
    await replaceNodeLogs(db, {
      runId: RUN,
      nodeId: NODE,
      entries: [entry('node-start', '▶ Chat Bot', 5)],
    })
    await emit(db, [entry('info', '→ model', 10)])
    await clearNodeBodyLogs(db, { runId: RUN, nodeId: NODE })

    const logs = await getRunLogs(db, RUN)
    expect(logs.map((l) => l.level)).toEqual(['node-start'])
  })

  test('the terminal rewrite supersedes whatever the live path wrote', async () => {
    await emit(db, [
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
    await emit(db, [
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
