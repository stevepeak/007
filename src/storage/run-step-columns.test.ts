import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'

import { applyMigrations } from './db-test-helpers'
import { stepColumnsFromMeta } from './run-recorder'

// `wf_run_step`'s promoted columns have two writers: the recorder, for every step
// from now on, and the migration's backfill, for every step before it. The second
// is SQL over raw JSON and the first is JS over `agentUsage`, so this runs both
// over the same rows and requires the same answer.

/** The last migration whose `wf_run_step` holds these fields only inside `meta`. */
const BEFORE_PROMOTION = '0042'

const META_SHAPES: Array<{ name: string; meta: unknown }> = [
  {
    name: 'a real agent generation',
    meta: {
      model: 'google/gemini-2.5-flash',
      steps: [{ text: 'hi' }],
      totalUsage: { inputTokens: 100, outputTokens: 20 },
      agentId: 'a1',
    },
  },
  {
    name: 'an agent that reported no usage numbers',
    meta: { model: 'm', steps: [], totalUsage: {} },
  },
  {
    name: 'an agent whose usage is explicitly null',
    // The key exists, so it IS a model call: tokens are 0, not NULL.
    meta: { model: 'm', steps: [], totalUsage: null },
  },
  {
    name: 'an agent with no model recorded',
    meta: { steps: [], totalUsage: { inputTokens: 5, outputTokens: 5 } },
  },
  {
    name: 'an agent with an empty model',
    meta: { model: '', steps: [], totalUsage: { inputTokens: 5 } },
  },
  {
    name: 'a generation that also carries the decision keys',
    // The generation shape wins, and reads only its own key names.
    meta: {
      modelId: 'decision-model',
      steps: [],
      totalUsage: { inputTokens: 1, outputTokens: 2 },
      questionIds: ['q'],
      usage: { inputTokens: 8, outputTokens: 9 },
    },
  },
  {
    name: 'a decision agent call',
    meta: {
      modelId: 'venice:jev-latest',
      questionIds: ['needs_human', 'topic'],
      usage: { inputTokens: 528, outputTokens: 80 },
      agentId: 'a1',
      agentVersion: 1,
    },
  },
  {
    name: 'a decision agent whose usage is explicitly null',
    meta: { modelId: 'm', questionIds: ['q'], usage: null },
  },
  {
    name: 'a decision agent with no model recorded',
    meta: { questionIds: ['q'], usage: { inputTokens: 5, outputTokens: 5 } },
  },
  {
    name: 'a meta whose questionIds is not an array',
    meta: { modelId: 'm', questionIds: 3, usage: { inputTokens: 1 } },
  },
  {
    name: 'a decision-shaped meta with no usage key at all',
    meta: { modelId: 'm', questionIds: ['q'], agentId: 'a1' },
  },
  {
    name: 'a tool call',
    meta: { toolId: 'find_photos', args: { q: 'x' } },
  },
  {
    name: 'an agent that failed before reporting usage',
    // Attribution survives without a model call.
    meta: { agentId: 'a1', agentVersion: 3 },
  },
  {
    name: 'ids that are not strings',
    meta: { agentId: 7, toolId: { id: 'x' } },
  },
  {
    name: 'an iteration container',
    meta: { total: 12, concurrency: 4, stopOnError: false, items: [] },
  },
  { name: 'an empty meta', meta: {} },
  {
    name: 'a meta whose steps is not an array',
    meta: { model: 'm', steps: 3, totalUsage: { inputTokens: 1 } },
  },
  {
    name: 'a meta with usage but no steps key at all',
    meta: { model: 'm', totalUsage: { inputTokens: 9, outputTokens: 9 } },
  },
]

function backfilled(args: { meta: unknown }) {
  const sqlite = new Database(':memory:')
  applyMigrations({ sqlite, through: BEFORE_PROMOTION })
  sqlite
    .prepare(
      `INSERT INTO wf_run_step (id, run_id, node_id, node_kind, sequence, status, meta)
       VALUES ('s', 'r', 'n', 'agent', 1, 'completed', ?)`,
    )
    .run(JSON.stringify(args.meta))
  applyMigrations({ sqlite, after: BEFORE_PROMOTION })
  return sqlite
}

describe('the backfill and the recorder promote identically', () => {
  test.each(META_SHAPES)('$name', ({ meta }) => {
    const row = backfilled({ meta })
      .prepare(
        `SELECT agent_id AS agentId, tool_id AS toolId, model_id AS modelId,
                input_tokens AS inputTokens, output_tokens AS outputTokens
         FROM wf_run_step`,
      )
      .get()
    expect(row).toEqual(stepColumnsFromMeta({ meta }))
  })
})

test('the JSON expression indexes are gone', () => {
  const rows = backfilled({ meta: {} })
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'index' AND tbl_name = 'wf_run_step'`,
    )
    .all() as Array<{ name: string }>
  const names = rows.map((r) => r.name)
  expect(names).toContain('wf_run_step_agent_id_idx')
  expect(names).toContain('wf_run_step_tool_id_idx')
  expect(names).not.toContain('wf_run_step_agent_idx')
  expect(names).not.toContain('wf_run_step_tool_idx')
})
