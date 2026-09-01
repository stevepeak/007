import { z } from 'zod'

import { clip } from '../server/clip'
import type {
  ModelOption,
  WfChangeDTO,
  WfDashboardResult,
  WfDashboardSeries,
} from '../server/protocol'

import { boundedLimit, optString, type WfMcpTool } from './tools'

// Tools pulled off the "extend the surface" queue, each because something that
// already shipped was unusable without it. `WfDataClient` has ~70 methods
// and exposing them all would be worse than exposing fifteen good ones — tool
// descriptions are prompt, and a bloated registry degrades selection. So the
// bar is a written reason, not coverage.
//
//   • `list_models` — `run_eval` takes a `models` array of catalog ids and
//     NOTHING told the model which ids exist. Asked to sweep two models it had
//     to recall one from training or scrape one out of a run trace, and a wrong
//     id fails at the provider after the sweep has already been launched.
//   • `list_changes` — `get_eval_run`'s drift block reports "the target agent
//     was republished since the last run". The immediate next question is who
//     changed what, and `wf_change` is the only record of it: 007 keeps no
//     per-table `updated_by`.
//
//   • `get_dashboard` — every other read here answers a question you already
//     knew to ask. Nothing answered "what is wrong right now", so a session
//     opened by guessing: list some runs, hope a failure is recent enough to be
//     on the first page. The rollup is the one call that ranks the work.
//
// Deliberately NOT here: `run_tool_preview` (executes the real tool against
// live services — see `tools-agents.ts`), `list_tool_invocations` (nothing has
// wanted it), and `get_model_catalog` / `list_providers` as tools of their own —
// `list_models` already returns the ENABLED set, which is the set every id
// argument accepts, and offering the full catalog would only invite naming a
// model that is off on purpose.

/** A change's `before`/`after` can be a whole agent config or workflow graph. */
const CHANGE_PAYLOAD_CHARS = 1200

/** Widest dashboard window a caller may ask for, in hours. */
const MAX_DASHBOARD_HOURS = 24 * 90

/** Series kept per panel. The tail is the long thin part nobody acts on. */
const MAX_DASHBOARD_SERIES = 8

/** Failures listed with their error text — enough to spot a shared cause. */
const MAX_RECENT_FAILURES = 10

/** A run's `error` is a provider message and can carry a whole stack. */
const FAILURE_ERROR_CHARS = 400

/**
 * A series without its per-bucket points.
 *
 * The dashboard payload is mostly `points` — one number per bucket per series,
 * on four panels — because it draws charts. A reader here draws nothing, and a
 * 90-day window at daily buckets would spend thousands of tokens on arrays that
 * can only be summed back into the `total` that is already right there.
 */
function rank(series: WfDashboardSeries[]): { label: string; total: number }[] {
  return [...series]
    .sort((a, b) => b.total - a.total)
    .slice(0, MAX_DASHBOARD_SERIES)
    .map((s) => ({ label: s.label, total: s.total }))
}

export function platformReadTools(): WfMcpTool[] {
  return [
    {
      name: 'list_models',
      title: 'List models',
      description:
        "The models enabled for use here, with cost per 1M tokens, throughput and context window. Pass an `id` from this list VERBATIM wherever a model is named (run_eval's `models`, an agent's modelId) — ids are composite `provider:model` and the provider-native half alone will 404. Use it before any matrix sweep that names models.",
      inputSchema: {},
      readOnly: true,
      run: async (client) => {
        const [models, providers] = await Promise.all([
          client.listModels(),
          // Named so a reader can tell WHY two ids differ only by prefix, and
          // so "no models" is distinguishable from "no provider wired up".
          client.listProviders().catch(() => []),
        ])
        return {
          providers,
          models: models.map((m: ModelOption) => ({
            id: m.id,
            label: m.label,
            providerId: m.providerId,
            costPerMTok: m.costPerMTok,
            tokensPerSec: m.tokensPerSec,
            contextLength: m.contextLength,
            capabilities: m.capabilities,
          })),
          note: 'These are the ENABLED models only — the full catalog is larger and the rest are off on purpose.',
        }
      },
    },

    {
      name: 'get_dashboard',
      title: 'Get dashboard',
      description:
        'The health rollup over a recent window: run volume and failure count, what is in flight right now, spend per model, the outstanding feedback queue, and the newest failed runs with their errors. Start here when the question is open-ended ("what is broken", "what did we spend") — it ranks where to look, and every id it returns can be handed to get_run, get_workflow or list_feedback.',
      inputSchema: {
        hours: z
          .number()
          .nullish()
          .describe(
            `How far back to look (default 24, max ${MAX_DASHBOARD_HOURS} — 90 days).`,
          ),
      },
      readOnly: true,
      run: async (client, args) => {
        const hours = boundedLimit(args.hours, 24, MAX_DASHBOARD_HOURS)
        const until = Date.now()
        const since = until - hours * 3_600_000
        // Derived, not asked for: the bucket only decides chart resolution and
        // this tool returns no chart. Hourly over a long window would just be
        // more arrays to throw away.
        const d: WfDashboardResult = await client.getDashboard({
          since,
          until,
          bucket: hours <= 48 ? 'hour' : 'day',
        })
        return {
          // The window the SERVER charted — it clamps what it is asked for, and
          // a reader comparing two calls needs to know which one it got.
          window: {
            since: new Date(d.since).toISOString(),
            until: new Date(d.until).toISOString(),
            hours: Math.round((d.until - d.since) / 3_600_000),
          },
          runs: {
            total: d.runs.total,
            failed: d.runs.failed,
            // Stated rather than left to be divided: a failure COUNT reads very
            // differently against 20 runs than against 2000.
            failureRate:
              d.runs.total > 0
                ? Number((d.runs.failed / d.runs.total).toFixed(3))
                : null,
            // Not window-scoped — this is right now. A high number with no
            // recent failures is a stall, not throughput.
            inFlight: d.runs.inFlight,
            byWorkflow: rank(d.runs.series),
            source: d.runs.source,
          },
          cost: {
            totalUsd: d.cost.totalUsd,
            totalTokens: d.cost.totalTokens,
            unpricedTokens: d.cost.unpricedTokens,
            byModel: rank(d.cost.series),
            source: d.cost.source,
            note: d.cost.pricedAtRunTime
              ? undefined
              : 'Dollars are token usage × TODAY’s catalog price, so historical spend moves when the catalog does.',
          },
          feedback: {
            unacknowledged: d.feedback.unacknowledged,
            unacknowledgedDown: d.feedback.unacknowledgedDown,
            up: d.feedback.up,
            down: d.feedback.down,
          },
          // Null, never zero, when analytics is unconfigured — nothing in SQL
          // counts `step.do` calls, and a fabricated 0 reads as "these were free".
          steps: d.steps
            ? {
                total: d.steps.total,
                runs: d.steps.runs,
                nodes: d.steps.nodes,
                iterationItems: d.steps.iterationItems,
                byWorkflow: rank(d.steps.series),
              }
            : null,
          recentFailures: d.recentFailures
            .slice(0, MAX_RECENT_FAILURES)
            .map((r) => ({
              runId: r.id,
              workflow: r.workflowName,
              triggerKind: r.triggerKind,
              finishedAt: r.finishedAt,
              error: clip(r.error, FAILURE_ERROR_CHARS),
            })),
          note: 'Per-bucket chart series are omitted; each panel’s figures are window totals. Pass a runId from recentFailures to get_run for the trace.',
        }
      },
    },

    {
      name: 'list_changes',
      title: 'List changes',
      description:
        "The audit feed — who changed which workflow, agent, Goal or Sample, when, and which fields. This is the ONLY who-touched-this record: there is no per-row `updated_by` anywhere else. Use it to answer 'what changed since…', and to explain a drifted eval (get_eval_run's `agentRepublishedSinceLastRun`) by naming the publish that caused it.",
      inputSchema: {
        entityKind: z
          .string()
          .nullish()
          .describe(
            'One of: workflow, agent, eval_set, eval_row, model, assignment. Omit for all.',
          ),
        entityId: z
          .string()
          .nullish()
          .describe('Only changes to this one entity.'),
        parentId: z
          .string()
          .nullish()
          .describe(
            "Changes to an entity's children — a Goal's id returns its Samples' edits.",
          ),
        actorId: z
          .string()
          .nullish()
          .describe(
            'Only this actor. A service caller writes its own id (e.g. svc:mcp), never the person who minted its token.',
          ),
        limit: z
          .number()
          .nullish()
          .describe('How many rows (default 30, max 100).'),
      },
      readOnly: true,
      run: async (client, args) => {
        const rows = await client.listChanges({
          entityKind: optString(args.entityKind) as
            | WfChangeDTO['entityKind']
            | undefined,
          entityId: optString(args.entityId),
          parentId: optString(args.parentId),
          actorId: optString(args.actorId),
          limit: boundedLimit(args.limit, 30, 100),
        })
        return rows.map((r: WfChangeDTO) => ({
          ...r,
          // A published agent config or workflow graph rides along whole.
          before: clip(r.before, CHANGE_PAYLOAD_CHARS),
          after: clip(r.after, CHANGE_PAYLOAD_CHARS),
        }))
      },
    },
  ]
}
