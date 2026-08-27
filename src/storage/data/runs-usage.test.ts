import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/bun-sqlite'

import type { WfDb } from '../client'
import type { ModelPriceMap } from '../cost'
import { wfRunStep, wfSchema } from '../schema'

import { foldUsage, selectRunUsage, usageRowFromMeta } from './runs-usage'

// Agent usage is now summed in SQLite instead of by folding every step's `meta`
// in JS (see the module header for the measurement that forced it). That trade
// buys a large payload win and takes on ONE risk: the SQL deciding a different
// set of rows are agent calls than `asAgentMeta` does. A step wrongly excluded
// silently under-reports cost; a step wrongly included reads garbage as tokens.
//
// So the first describe below is a parity harness, not a set of examples: every
// meta shape goes through BOTH implementations and the answers must match. Add
// a shape here whenever the recorder learns to write a new one.

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

beforeEach(() => {
  db = freshDb()
})

let seq = 0
async function addStep(
  runId: string,
  meta: unknown,
  window?: { startedAt: Date; finishedAt: Date | null },
) {
  seq += 1
  await db.insert(wfRunStep).values({
    id: `step-${seq}`,
    runId,
    nodeId: `n-${seq}`,
    nodeKind: 'agent',
    sequence: seq,
    status: 'completed',
    meta,
    startedAt: window?.startedAt,
    finishedAt: window?.finishedAt ?? undefined,
  })
}

/** The shapes a `meta` column is known to hold, with what each one means. */
const META_SHAPES: Array<{ name: string; meta: unknown }> = [
  {
    name: 'a real agent generation',
    meta: {
      model: 'google/gemini-2.5-flash',
      steps: [{ text: 'hi' }],
      totalUsage: { inputTokens: 100, outputTokens: 20 },
    },
  },
  {
    name: 'an agent that reported no usage numbers',
    // `totalUsage` present but empty — JS defaults both fields to 0 and still
    // counts the call, so SQL must `coalesce` rather than drop the row.
    meta: { model: 'm', steps: [], totalUsage: {} },
  },
  {
    name: 'an agent whose usage is explicitly null',
    // The key exists with a JSON null. `'totalUsage' in meta` is TRUE in JS, so
    // this IS an agent step — the case `json_type(...) is not null` exists for,
    // since `json_extract` alone would report nothing here.
    meta: { model: 'm', steps: [], totalUsage: null },
  },
  {
    name: 'an agent with no model recorded',
    meta: { steps: [], totalUsage: { inputTokens: 5, outputTokens: 5 } },
  },
  {
    name: 'a tool call',
    meta: { toolId: 'find_photos', args: { q: 'x' } },
  },
  {
    name: 'an iteration container',
    meta: { total: 12, concurrency: 4, stopOnError: false, items: [] },
  },
  { name: 'an empty meta', meta: {} },
  {
    name: 'a meta whose steps is not an array',
    // Structurally close to an agent step but not one. `asAgentMeta` requires
    // `Array.isArray(steps)`; `json_type(...) = 'array'` is its translation.
    meta: { model: 'm', steps: 3, totalUsage: { inputTokens: 1, outputTokens: 1 } },
  },
  {
    name: 'a meta with usage but no steps key at all',
    meta: { model: 'm', totalUsage: { inputTokens: 9, outputTokens: 9 } },
  },
]

describe('the SQL read and asAgentMeta classify identically', () => {
  test.each(META_SHAPES)('$name', async ({ meta }) => {
    await addStep('run-1', meta)

    const sqlRows = await selectRunUsage(db, ['run-1'])
    const jsRow = usageRowFromMeta('run-1', meta)

    // Same verdict on whether this is an agent call at all…
    expect(sqlRows.length).toBe(jsRow ? 1 : 0)
    if (!jsRow) return
    // …and the same numbers when it is.
    expect(sqlRows[0]?.model).toBe(jsRow.model)
    expect(sqlRows[0]?.inputTokens).toBe(jsRow.inputTokens)
    expect(sqlRows[0]?.outputTokens).toBe(jsRow.outputTokens)
  })

  test('a run of mixed steps counts only the agent ones', async () => {
    for (const { meta } of META_SHAPES) await addStep('run-1', meta)

    const rows = await selectRunUsage(db, ['run-1'])
    const expected = META_SHAPES.filter(
      (s) => usageRowFromMeta('run-1', s.meta) !== null,
    ).length

    // Grouped by model, so the count is distinct models, not steps — three of
    // the agent shapes share `model: 'm'` and one has none.
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.length).toBeLessThanOrEqual(expected)
    const total = rows.reduce(
      (n, r) => n + Number(r.inputTokens) + Number(r.outputTokens),
      0,
    )
    // 100+20 from the real generation, 5+5 from the unnamed model. Everything
    // else contributes zero, and the two non-agent lookalikes contribute nothing.
    expect(total).toBe(130)
  })
})

describe('selectRunUsage', () => {
  test('sums per model, not per run', async () => {
    await addStep('run-1', {
      model: 'cheap',
      steps: [],
      totalUsage: { inputTokens: 1000, outputTokens: 10 },
    })
    await addStep('run-1', {
      model: 'cheap',
      steps: [],
      totalUsage: { inputTokens: 500, outputTokens: 5 },
    })
    await addStep('run-1', {
      model: 'dear',
      steps: [],
      totalUsage: { inputTokens: 10, outputTokens: 1 },
    })

    const rows = await selectRunUsage(db, ['run-1'])

    // Two rows, not three and not one: a run that called a cheap model twice
    // and an expensive one once cannot be priced from a single token total.
    const byModel = new Map(rows.map((r) => [r.model, r]))
    expect(byModel.size).toBe(2)
    expect(Number(byModel.get('cheap')?.inputTokens)).toBe(1500)
    expect(Number(byModel.get('cheap')?.outputTokens)).toBe(15)
    expect(Number(byModel.get('dear')?.inputTokens)).toBe(10)
  })

  test('keeps runs apart', async () => {
    const usage = (n: number) => ({
      model: 'm',
      steps: [],
      totalUsage: { inputTokens: n, outputTokens: 0 },
    })
    await addStep('run-1', usage(10))
    await addStep('run-2', usage(70))

    const rows = await selectRunUsage(db, ['run-1', 'run-2'])

    const byRun = new Map(rows.map((r) => [r.runId, Number(r.inputTokens)]))
    expect(byRun.get('run-1')).toBe(10)
    expect(byRun.get('run-2')).toBe(70)
  })

  test('an empty id list reads nothing', async () => {
    await addStep('run-1', {
      model: 'm',
      steps: [],
      totalUsage: { inputTokens: 1, outputTokens: 1 },
    })
    expect(await selectRunUsage(db, [])).toEqual([])
  })

  test('agentMs counts only closed windows', async () => {
    const meta = {
      model: 'm',
      steps: [],
      totalUsage: { inputTokens: 1, outputTokens: 1 },
    }
    await addStep('run-1', meta, {
      startedAt: new Date(1_000),
      finishedAt: new Date(4_000),
    })
    // Started and never finished: contributes nothing rather than being paired
    // with `now`, which would make an in-flight agent look instantaneous.
    await addStep('run-1', meta, { startedAt: new Date(9_000), finishedAt: null })

    const rows = await selectRunUsage(db, ['run-1'])

    // Milliseconds. The stored columns are SECONDS, so a missing conversion
    // would pass this as `3` — which reads as a fast agent, not as a bug.
    expect(Number(rows[0]?.agentMs)).toBe(3_000)
  })

  test('agentMs is null when nothing closed a window', async () => {
    await addStep('run-1', {
      model: 'm',
      steps: [],
      totalUsage: { inputTokens: 1, outputTokens: 1 },
    })
    // Null, not 0 — the caller falls back to the run's own wall clock, and it
    // can only tell the two apart if "no timing at all" stays distinguishable.
    expect((await selectRunUsage(db, ['run-1']))[0]?.agentMs).toBeNull()
  })

  test('carries the frozen agent version', async () => {
    await addStep('run-1', {
      model: 'm',
      steps: [],
      totalUsage: { inputTokens: 1, outputTokens: 1 },
      agentVersion: 7,
    })
    expect((await selectRunUsage(db, ['run-1']))[0]?.agentVersion).toBe(7)
  })
})

describe('foldUsage', () => {
  const priceMap: ModelPriceMap = new Map([
    ['cheap', { promptPerMTok: 1, completionPerMTok: 2 }],
    ['dear', { promptPerMTok: 1000, completionPerMTok: 2000 }],
  ])
  const row = (over: Partial<Parameters<typeof foldUsage>[0] extends Iterable<infer T> ? T : never>) => ({
    runId: 'r',
    model: 'cheap',
    inputTokens: 0,
    outputTokens: 0,
    agentMs: null,
    agentVersion: null,
    ...over,
  })

  test('prices each model at its own rate', async () => {
    const out = foldUsage(
      [
        row({ model: 'cheap', inputTokens: 1_000_000, outputTokens: 0 }),
        row({ model: 'dear', inputTokens: 1_000_000, outputTokens: 0 }),
      ],
      priceMap,
    )
    expect(out.costUsd).toBe(1001)
    expect(out.totalTokens).toBe(2_000_000)
    expect(out.models.sort()).toEqual(['cheap', 'dear'])
  })

  test('an unpriced model still contributes tokens', async () => {
    const out = foldUsage(
      [
        row({ model: 'unknown-model', inputTokens: 500, outputTokens: 500 }),
        row({ model: 'cheap', inputTokens: 1_000_000, outputTokens: 0 }),
      ],
      priceMap,
    )
    // Best-effort: a priced model beside an unpriced one still yields a figure,
    // and the unpriced tokens are counted even though they cost "nothing".
    expect(out.totalTokens).toBe(1_001_000)
    expect(out.costUsd).toBe(1)
  })

  test('nothing priced at all reports null cost, not zero', async () => {
    const out = foldUsage(
      [row({ model: 'unknown-model', inputTokens: 10, outputTokens: 10 })],
      priceMap,
    )
    // $0.00 would read as "this was free"; null reads as "we can't say".
    expect(out.costUsd).toBeNull()
    expect(out.totalTokens).toBe(20)
  })

  test('an empty fold reports null, not zero', async () => {
    const out = foldUsage([], priceMap)
    expect(out.totalTokens).toBeNull()
    expect(out.costUsd).toBeNull()
    expect(out.models).toEqual([])
    expect(out.agentMs).toBeNull()
  })

  test('a model with no name is counted but not listed', async () => {
    const out = foldUsage(
      [row({ model: null, inputTokens: 3, outputTokens: 4 })],
      priceMap,
    )
    expect(out.totalTokens).toBe(7)
    expect(out.models).toEqual([])
  })
})
