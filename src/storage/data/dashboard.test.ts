import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/bun-sqlite'

import type { AnalyticsRow } from '../../analytics/query'
import type { WfDb } from '../client'
import type { ModelPriceMap } from '../cost'
import {
  wfFeedback,
  wfModel,
  wfRun,
  wfRunStep,
  wfSchema,
  wfWorkflow,
  wfWorkflowVersion,
} from '../schema'

import type { DashboardAnalytics } from './dashboard'
import {
  collapseSeries,
  foldCostRows,
  loadDashboard,
  resolveWindow,
  type DashboardSeries,
} from './dashboard'

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

const DAY = 86_400_000
// A fixed "now" on a UTC day boundary keeps bucket indexes obvious in assertions.
const NOW = Date.UTC(2026, 7, 6, 12, 0, 0)
const PRICED = 'gpt-priced'
const UNPRICED = 'gpt-unpriced'

function agentMeta (model: string, inputTokens: number, outputTokens: number) {
  return {
  model,
  steps: [{ stepNumber: 1, toolCalls: [] }],
  totalUsage: { inputTokens, outputTokens },
}
}

async function seed(db: WfDb) {
  await db.insert(wfWorkflow).values([
    { id: 'wf-1', name: 'Intake' },
    { id: 'wf-2', name: 'Costing' },
  ])
  await db.insert(wfWorkflowVersion).values([
    { id: 'v-1', workflowId: 'wf-1', versionNumber: 1, graph: {} },
    { id: 'v-2', workflowId: 'wf-2', versionNumber: 1, graph: {} },
  ])
  // $1/Mtok prompt, $2/Mtok completion. The second model is deliberately absent
  // from the catalog so its tokens land in `unpricedTokens`.
  await db.insert(wfModel).values({
    id: `test:${PRICED}`,
    providerId: 'test',
    modelId: PRICED,
    label: 'Priced',
    promptPricePerMTok: 1,
    completionPricePerMTok: 2,
  })
}

async function addRun(
  db: WfDb,
  id: string,
  opts: {
    versionId?: string
    status?: 'queued' | 'running' | 'completed' | 'failed'
    isEval?: boolean
    createdAt: Date
    error?: string
  },
) {
  await db.insert(wfRun).values({
    id,
    workflowVersionId: opts.versionId ?? 'v-1',
    triggerKind: 'chat',
    status: opts.status ?? 'completed',
    isEval: opts.isEval ?? false,
    createdAt: opts.createdAt,
    error: opts.error ?? null,
  })
}

async function addAgentStep(
  db: WfDb,
  runId: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
) {
  await db.insert(wfRunStep).values({
    runId,
    nodeId: `node-${runId}-${model}`,
    nodeKind: 'agent',
    sequence: 1,
    status: 'completed',
    meta: agentMeta(model, inputTokens, outputTokens),
  })
}

describe('resolveWindow', () => {
  test('defaults to the last 7 days with daily buckets, inclusive of both ends', () => {
    const w = resolveWindow({}, NOW)
    expect(w.bucket).toBe('day')
    expect(w.until).toBe(NOW)
    expect(w.since).toBe(NOW - 7 * DAY)
    // 7 days back plus today's partial bucket.
    expect(w.buckets.length).toBe(8)
    expect(w.buckets[0]).toBe(Date.UTC(2026, 6, 30))
    expect(w.buckets.at(-1)).toBe(Date.UTC(2026, 7, 6))
  })

  test('clamps the window to 90 days and never lets `until` run past now', () => {
    const w = resolveWindow({ since: NOW - 400 * DAY, until: NOW + 10 * DAY }, NOW)
    expect(w.until).toBe(NOW)
    expect(w.since).toBe(NOW - 90 * DAY)
  })

  test('degrades an hourly bucket to daily once it would emit too many points', () => {
    expect(resolveWindow({ since: NOW - DAY, bucket: 'hour' }, NOW).bucket).toBe(
      'hour',
    )
    expect(
      resolveWindow({ since: NOW - 90 * DAY, bucket: 'hour' }, NOW).bucket,
    ).toBe('day')
  })

  test('an inverted range collapses to a single bucket rather than throwing', () => {
    const w = resolveWindow({ since: NOW, until: NOW - 5 * DAY }, NOW)
    expect(w.since).toBe(w.until)
    expect(w.buckets.length).toBe(1)
  })
})

describe('collapseSeries', () => {
  const series = (key: string, points: number[]): DashboardSeries => ({
    key,
    label: key,
    total: points.reduce((a, b) => a + b, 0),
    points,
  })

  test('ranks by total and leaves a short list alone', () => {
    const out = collapseSeries([series('a', [1]), series('b', [5])], 8)
    expect(out.map((s) => s.key)).toEqual(['b', 'a'])
  })

  test('folds the tail into one "Other" line that preserves the grand total', () => {
    const input = [
      series('a', [10, 10]),
      series('b', [5, 5]),
      series('c', [3, 0]),
      series('d', [0, 2]),
    ]
    const out = collapseSeries(input, 2)
    expect(out.map((s) => s.label)).toEqual(['a', 'b', 'Other'])
    expect(out[2]?.points).toEqual([3, 2])
    expect(out.reduce((sum, s) => sum + s.total, 0)).toBe(35)
  })
})

describe('foldCostRows', () => {
  const window = resolveWindow({ since: NOW - 2 * DAY }, NOW)
  const priceMap: ModelPriceMap = new Map([
    [PRICED, { promptPerMTok: 1, completionPerMTok: 2 }],
  ])

  test('keeps unpriced tokens out of the dollar total instead of counting them as $0', () => {
    const cost = foldCostRows(
      [
        {
          ordinal: window.firstOrdinal,
          model: PRICED,
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
        },
        {
          ordinal: window.firstOrdinal,
          model: UNPRICED,
          inputTokens: 500_000,
          outputTokens: 0,
        },
      ],
      priceMap,
      window,
    )
    expect(cost.totalUsd).toBeCloseTo(3, 6)
    expect(cost.totalTokens).toBe(2_500_000)
    expect(cost.unpricedTokens).toBe(500_000)
    // The unpriced model must not appear as a $0 line in the chart.
    expect(cost.series.map((s) => s.key)).toEqual([PRICED])
  })

  test('reports null — not zero — when nothing in the window could be priced', () => {
    const cost = foldCostRows(
      [
        {
          ordinal: window.firstOrdinal,
          model: UNPRICED,
          inputTokens: 100,
          outputTokens: 100,
        },
      ],
      priceMap,
      window,
    )
    expect(cost.totalUsd).toBeNull()
    expect(cost.unpricedTokens).toBe(200)
  })
})

describe('loadDashboard', () => {
  let db: WfDb

  beforeEach(async () => {
    db = freshDb()
    await seed(db)
  })

  test('renders gap-free zero points for buckets with no runs', async () => {
    // Two runs today, none on the three days before it.
    await addRun(db, 'run-a', { createdAt: new Date(NOW - 60_000) })
    await addRun(db, 'run-b', { createdAt: new Date(NOW - 120_000) })

    const d = await loadDashboard(db, { since: NOW - 3 * DAY }, NOW)
    expect(d.buckets.length).toBe(4)
    expect(d.runs.total).toBe(2)
    const intake = d.runs.series.find((s) => s.label === 'Intake')
    // The quiet days must be explicit zeros, or the chart interpolates across them.
    expect(intake?.points).toEqual([0, 0, 0, 2])
  })

  test('buckets runs per workflow and counts failures', async () => {
    await addRun(db, 'run-a', { createdAt: new Date(NOW - 2 * DAY) })
    await addRun(db, 'run-b', {
      createdAt: new Date(NOW),
      status: 'failed',
      error: 'boom',
    })
    await addRun(db, 'run-c', {
      versionId: 'v-2',
      createdAt: new Date(NOW),
    })

    const d = await loadDashboard(db, { since: NOW - 3 * DAY }, NOW)
    expect(d.runs.total).toBe(3)
    expect(d.runs.failed).toBe(1)
    expect(d.runs.failedPoints).toEqual([0, 0, 0, 1])
    expect(d.runs.series.map((s) => s.label).sort()).toEqual([
      'Costing',
      'Intake',
    ])
    expect(d.recentFailures.map((r) => r.id)).toEqual(['run-b'])
    expect(d.recentFailures[0]?.error).toBe('boom')
  })

  test('excludes eval runs from volume, failures and spend', async () => {
    await addRun(db, 'run-eval', {
      createdAt: new Date(NOW),
      status: 'failed',
      isEval: true,
    })
    await addAgentStep(db, 'run-eval', PRICED, 1_000_000, 1_000_000)

    const d = await loadDashboard(db, { since: NOW - 3 * DAY }, NOW)
    expect(d.runs.total).toBe(0)
    expect(d.runs.failed).toBe(0)
    expect(d.cost.totalUsd).toBeNull()
    expect(d.cost.totalTokens).toBe(0)
    expect(d.recentFailures).toEqual([])
  })

  test('derives spend per model from step meta and the catalog price', async () => {
    await addRun(db, 'run-a', { createdAt: new Date(NOW) })
    await addAgentStep(db, 'run-a', PRICED, 1_000_000, 1_000_000)
    await addAgentStep(db, 'run-a', UNPRICED, 400_000, 0)

    const d = await loadDashboard(db, { since: NOW - 3 * DAY }, NOW)
    // 1M prompt @ $1 + 1M completion @ $2.
    expect(d.cost.totalUsd).toBeCloseTo(3, 6)
    expect(d.cost.totalTokens).toBe(2_400_000)
    expect(d.cost.unpricedTokens).toBe(400_000)
    expect(d.cost.series.map((s) => s.key)).toEqual([PRICED])
    expect(d.cost.series[0]?.points.at(-1)).toBeCloseTo(3, 6)
  })

  test('ignores non-agent steps, which carry no usage', async () => {
    await addRun(db, 'run-a', { createdAt: new Date(NOW) })
    await db.insert(wfRunStep).values({
      runId: 'run-a',
      nodeId: 'node-tool',
      nodeKind: 'tool',
      sequence: 1,
      status: 'completed',
      meta: agentMeta(PRICED, 1_000_000, 1_000_000),
    })

    const d = await loadDashboard(db, { since: NOW - 3 * DAY }, NOW)
    expect(d.cost.totalTokens).toBe(0)
    expect(d.cost.totalUsd).toBeNull()
  })

  test('counts in-flight runs regardless of the window', async () => {
    await addRun(db, 'run-old', {
      createdAt: new Date(NOW - 60 * DAY),
      status: 'running',
    })
    await addRun(db, 'run-q', { createdAt: new Date(NOW), status: 'queued' })
    await addRun(db, 'run-done', { createdAt: new Date(NOW) })

    const d = await loadDashboard(db, { since: NOW - DAY }, NOW)
    expect(d.runs.inFlight).toBe(2)
    // …while the windowed volume only sees what happened inside it.
    expect(d.runs.total).toBe(2)
  })

  test('reports the outstanding feedback queue and the windowed trend', async () => {
    await db.insert(wfFeedback).values([
      { subjectId: 's1', rating: 'down', createdAt: new Date(NOW) },
      { subjectId: 's2', rating: 'down', createdAt: new Date(NOW - DAY) },
      { subjectId: 's3', rating: 'up', createdAt: new Date(NOW) },
      // Acknowledged — out of the queue, still in the trend.
      {
        subjectId: 's4',
        rating: 'down',
        createdAt: new Date(NOW),
        ackAt: new Date(NOW),
      },
      // Older than the window: still queued, but off the chart.
      { subjectId: 's5', rating: 'down', createdAt: new Date(NOW - 30 * DAY) },
    ])

    const d = await loadDashboard(db, { since: NOW - DAY }, NOW)
    expect(d.feedback.unacknowledged).toBe(4)
    expect(d.feedback.unacknowledgedDown).toBe(3)
    expect(d.feedback.down).toBe(3)
    expect(d.feedback.up).toBe(1)
    expect(d.feedback.downPoints).toEqual([1, 2])
    expect(d.feedback.upPoints).toEqual([0, 1])
  })

  test('an empty database yields zeroed series, not missing ones', async () => {
    const d = await loadDashboard(db, { since: NOW - 2 * DAY }, NOW)
    expect(d.runs.total).toBe(0)
    expect(d.runs.series).toEqual([])
    expect(d.runs.failedPoints).toEqual([0, 0, 0])
    expect(d.cost.totalUsd).toBeNull()
    expect(d.feedback.unacknowledged).toBe(0)
    expect(d.recentFailures).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Analytics Engine path — degradation, and equivalence with the D1 answer
// ---------------------------------------------------------------------------

/** A fake SQL API that answers by matching on the query's discriminators. */
function fakeAnalytics(
  answers: {
    volume?: AnalyticsRow[]
    spend?: AnalyticsRow[]
    steps?: AnalyticsRow[]
  },
  onQuery?: (sql: string) => void,
): DashboardAnalytics {
  return {
    dataset: 'wf_telemetry',
    query: {
      run: async (sql: string) => {
        onQuery?.(sql)
        if (sql.includes('workflow_steps')) return answers.steps ?? []
        if (sql.includes("blob1 = 'step'")) return answers.spend ?? []
        return answers.volume ?? []
      },
    },
  }
}

describe('loadDashboard with analytics', () => {
  let db: WfDb

  beforeEach(async () => {
    db = freshDb()
    await seed(db)
  })

  test('with no analytics wired, the result is the untouched D1 path', async () => {
    await addRun(db, 'r-1', { createdAt: new Date(NOW - DAY) })
    await addAgentStep(db, 'r-1', PRICED, 1_000_000, 1_000_000)

    const stats = await loadDashboard(db, {}, NOW)
    expect(stats.runs.source).toBe('db')
    expect(stats.cost.source).toBe('db')
    expect(stats.cost.pricedAtRunTime).toBe(false)
    expect(stats.cost.totalUsd).toBe(3)
    // No SQL counts step.do calls, so there is nothing to fall back TO.
    expect(stats.steps).toBeNull()
  })

  test('analytics answers volume, spend and steps, and says so', async () => {
    const dayOrdinal = Math.floor(NOW / 1000 / 86_400)
    const stats = await loadDashboard(db, {}, NOW, fakeAnalytics({
      volume: [
        { workflow_id: 'wf-1', ordinal: dayOrdinal, runs: 12, failed: 3 },
      ],
      spend: [
        {
          ordinal: dayOrdinal,
          model: PRICED,
          input_tokens: 1_000_000,
          output_tokens: 500_000,
          cost_usd: 2.25,
          priced_tokens: 1_500_000,
        },
      ],
      steps: [
        {
          workflow_id: 'wf-1',
          ordinal: dayOrdinal,
          runs: 12,
          workflow_steps: 480,
          nodes: 120,
          iteration_items: 60,
        },
      ],
    }))

    expect(stats.runs.source).toBe('analytics')
    expect(stats.runs.total).toBe(12)
    expect(stats.runs.failed).toBe(3)
    // AE holds the id; the CURRENT name is resolved from D1 so a rename shows.
    expect(stats.runs.series[0]?.label).toBe('Intake')

    expect(stats.cost.source).toBe('analytics')
    expect(stats.cost.pricedAtRunTime).toBe(true)
    expect(stats.cost.totalUsd).toBe(2.25)
    expect(stats.cost.totalTokens).toBe(1_500_000)
    expect(stats.cost.unpricedTokens).toBe(0)

    expect(stats.steps?.total).toBe(480)
    expect(stats.steps?.runs).toBe(12)
    expect(stats.steps?.iterationItems).toBe(60)
    expect(stats.steps?.series[0]?.label).toBe('Intake')
  })

  test('a failing analytics query degrades that panel to D1, not the page', async () => {
    await addRun(db, 'r-1', { createdAt: new Date(NOW - DAY) })
    await addAgentStep(db, 'r-1', PRICED, 1_000_000, 1_000_000)

    const stats = await loadDashboard(db, {}, NOW, {
      dataset: 'wf_telemetry',
      query: {
        run: () => Promise.reject(new Error('AE is down')),
      },
    })

    expect(stats.runs.source).toBe('db')
    expect(stats.runs.total).toBe(1)
    expect(stats.cost.source).toBe('db')
    expect(stats.cost.totalUsd).toBe(3)
    // The steps panel has no D1 answer, so it degrades to absent.
    expect(stats.steps).toBeNull()
    // Everything that never moved to AE is unaffected.
    expect(stats.feedback.unacknowledged).toBe(0)
    expect(stats.recentFailures).toEqual([])
  })

  test('unpriced tokens survive the analytics fold', async () => {
    const dayOrdinal = Math.floor(NOW / 1000 / 86_400)
    const stats = await loadDashboard(db, {}, NOW, fakeAnalytics({
      spend: [
        {
          ordinal: dayOrdinal,
          model: UNPRICED,
          input_tokens: 400,
          output_tokens: 100,
          cost_usd: 0,
          priced_tokens: 0,
        },
      ],
    }))
    expect(stats.cost.totalTokens).toBe(500)
    expect(stats.cost.unpricedTokens).toBe(500)
    // Nothing could be priced, so the figure is null rather than a false $0.
    expect(stats.cost.totalUsd).toBeNull()
  })

  test('a window beyond AE retention falls back to D1 without querying it', async () => {
    await addRun(db, 'r-old', { createdAt: new Date(NOW - DAY) })
    const seen: string[] = []
    const stats = await loadDashboard(
      db,
      { since: NOW - 89 * DAY, until: NOW },
      NOW,
      fakeAnalytics({}, (sql) => {
        seen.push(sql)
      }),
    )
    expect(seen).toEqual([])
    expect(stats.runs.source).toBe('db')
    expect(stats.steps).toBeNull()
  })

  test('in-flight, feedback and failures always come from D1', async () => {
    await addRun(db, 'r-live', { status: 'running', createdAt: new Date(NOW) })
    await addRun(db, 'r-bad', {
      status: 'failed',
      error: 'boom',
      createdAt: new Date(NOW - DAY),
    })
    const stats = await loadDashboard(db, {}, NOW, fakeAnalytics({}))
    expect(stats.runs.inFlight).toBe(1)
    expect(stats.recentFailures).toHaveLength(1)
  })
})
