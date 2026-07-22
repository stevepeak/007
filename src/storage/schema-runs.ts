import { sql } from 'drizzle-orm'
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

import {
  createdAt,
  WF_RUN_STATUSES,
  WF_RUN_STEP_STATUSES,
} from './schema-common'

// One execution.
export const wfRun = sqliteTable(
  'wf_run',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    workflowVersionId: text('workflow_version_id').notNull(),
    // Opaque host references (no FK).
    subjectId: text('subject_id'),
    correlationId: text('correlation_id'),
    triggerKind: text('trigger_kind').notNull(),
    // Cloudflare Workflows run id — used by RunRoom and to scope writes from
    // concurrent attempts to the right row.
    cloudflareRunId: text('cloudflare_run_id'),
    // Stable 32-hex trace id minted at run start. Every per-node Sentry span is
    // seeded with it so the run groups into one distributed trace; the run
    // viewer builds a "View trace in Sentry" deep-link from it. Null for runs
    // started before tracing was wired.
    sentryTraceId: text('sentry_trace_id'),
    status: text('status', { enum: WF_RUN_STATUSES })
      .notNull()
      .default('queued'),
    startedAt: integer('started_at', { mode: 'timestamp' }),
    finishedAt: integer('finished_at', { mode: 'timestamp' }),
    error: text('error'),
    output: text('output', { mode: 'json' })
      .notNull()
      .default(sql`'{}'`),
    // Frozen-at-run-start resolution of every floating reference (agents) to
    // the exact published version used, so a run is fully reproducible even as
    // its leaf agents drift. See WfRunManifestEntry.
    manifest: text('manifest', { mode: 'json' })
      .notNull()
      .default(sql`'[]'`),
    // Marks a run produced by an eval (simulate=true). Since there is no tenant
    // partition, this flag is how the general Runs explorer keeps eval runs out
    // of a firm's view (default listings exclude it). See wf_eval_result.wfRunId.
    isEval: integer('is_eval', { mode: 'boolean' }).notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    index('wf_run_created_idx').on(t.createdAt),
    index('wf_run_version_created_idx').on(t.workflowVersionId, t.createdAt),
    index('wf_run_subject_idx').on(t.subjectId),
    index('wf_run_eval_created_idx').on(t.isEval, t.createdAt),
  ],
)

// Ordered execution trace — one row per node fired. `node_id` is the stable
// UUID from the graph (joined back to the version's graph JSON for display).
//
// A node inside an iteration's subgraph runs once per item, so a single
// `node_id` can produce many rows in one run. `item_index` disambiguates them:
// top-level steps use the sentinel `-1` (never NULL — SQLite treats NULLs as
// distinct in a unique index, which would break the idempotent upsert), and a
// sub-step of iteration container N carries its 0-based item index plus
// `parent_node_id = N`. The unique (run_id, node_id, item_index) constraint is
// what makes the durable recorder's upsert idempotent across `step.do` retries.
export const wfRunStep = sqliteTable(
  'wf_run_step',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    runId: text('run_id').notNull(),
    nodeId: text('node_id').notNull(),
    nodeKind: text('node_kind').notNull(),
    /** Iteration container this step ran inside, or NULL for a top-level step. */
    parentNodeId: text('parent_node_id'),
    /** 0-based item index within an iteration; `-1` for a top-level step. */
    itemIndex: integer('item_index').notNull().default(-1),
    sequence: integer('sequence').notNull(),
    status: text('status', { enum: WF_RUN_STEP_STATUSES }).notNull(),
    input: text('input', { mode: 'json' })
      .notNull()
      .default(sql`'{}'`),
    output: text('output', { mode: 'json' })
      .notNull()
      .default(sql`'{}'`),
    branchResult: text('branch_result', { mode: 'json' }),
    meta: text('meta', { mode: 'json' })
      .notNull()
      .default(sql`'{}'`),
    startedAt: integer('started_at', { mode: 'timestamp' }),
    finishedAt: integer('finished_at', { mode: 'timestamp' }),
    error: text('error'),
  },
  (t) => [
    index('wf_run_step_run_sequence_idx').on(t.runId, t.sequence),
    uniqueIndex('wf_run_step_run_node_idx').on(t.runId, t.nodeId, t.itemIndex),
  ],
)

// Structured progress feed — the human-readable, run-controlled log stream shown
// in the run viewer's Logs panel and streamed live over the RunRoom → SSE
// channel. One row per emitted entry (a node entered/finished, a line we chose
// to print, an agent's internal reasoning, a tool call). Distinct from
// `wf_run_step` (one row per node, the machine trace): this is the narrative.
// `ts` is the engine-stamped emit time (millis) and drives ordering, since many
// entries share a node and a monotonic wall-clock is a stabler sort than a
// row's write time. No unique key — entries are append-only, replaced wholesale
// per-node on the (idempotent) record step, so a retried step can't duplicate.
export const wfRunLog = sqliteTable(
  'wf_run_log',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    runId: text('run_id').notNull(),
    nodeId: text('node_id'),
    nodeKind: text('node_kind'),
    sequence: integer('sequence'),
    level: text('level').notNull(),
    message: text('message').notNull(),
    meta: text('meta', { mode: 'json' }),
    // Engine emit time (epoch millis). Primary sort for the feed.
    ts: integer('ts').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('wf_run_log_run_ts_idx').on(t.runId, t.ts),
    index('wf_run_log_run_node_idx').on(t.runId, t.nodeId),
  ],
)
