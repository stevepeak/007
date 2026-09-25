import { z } from 'zod'

import { agentModelRequirements } from '../engine/agent-config-schema'
import {
  mergeModelRequirements,
  unmetRequirementsReason,
} from '../engine/model-capabilities'
import type { CheckResult, EvalCheck } from '../eval/checks'
import { agentCallTotals, buildMatrixSummary, isMatrixRun } from '../eval/report'
import {
  createEvalSweep,
  DEFAULT_EVAL_CONCURRENCY,
  driveEvalRun,
  type RunEvalInput,
} from '../eval/run-eval'
import { clip } from '../server/clip'
import type {
  AgentConfig,
  ModelCapabilities,
  ModelOption,
  WfDataClient,
  WfEvalResultDTO,
  WfEvalRunDetail,
  WfEvalSetDetail,
} from '../server/protocol'

import { optString, reqString, type WfMcpTool } from './tools'
import { draftOrPublished } from './tools-agents'

// Running a Goal and reading its report — the half of the loop that makes the
// authoring half self-checking. Without these, a model can write a Sample and
// has no way to find out whether it was a good one.
//
// ── Why launching does not block ─────────────────────────────────────────────
//
// A sweep is every (sample × model × prompt × attempt) cell run for real, which
// takes minutes to tens of minutes. A tool call that awaited all of that would
// time out long before the report existed. So `run_eval` creates the run with
// its frozen plan, drives one tick to get the first cells moving, and returns;
// the model polls `get_eval_run`. That is also how the launch dialog behaves —
// the report page it navigates to is a poller.
//
// What it must NOT do is keep orchestrating after it answers. This endpoint is
// a single Worker request and its context dies with the response, so work left
// running there is simply cancelled. The rest of the sweep belongs to the
// host's resume backstop, which reads the plan off the run row.
//
// That last part is why the sweep survives the session. The paragraph that used
// to sit here said the opposite — "the orchestration runs in THIS process… the
// run sits at `running` forever" — which was true before plans were persisted
// and false afterwards, and the tool's own `next` field had already been updated
// to contradict it. Stale prose in a tool description is not a comment nobody
// reads: it is prompt, and it was telling models to hold a session open for a
// sweep that no longer needed one.
//
// What DOES strand a sweep is a host with no resume backstop wired. Then the one
// tick `run_eval` drives is all the progress that will ever be made, and
// `resume_eval_run` is the manual equivalent.
//
// ── Deliberately NOT here (evals) ────────────────────────────────────────────
//
// Kept per category so a decision and an oversight stay distinguishable. Each of
// these is missing from the console too, so none is an MCP parity gap; they are
// scope calls, and these are the calls.
//
//   • `regrade_eval_run` — re-ask a rubric of a trace already on disk, without
//     paying for the agent call again. Genuinely wanted (tuning a judge rubric
//     currently means re-executing the target) but it is not a tool-shaped
//     decision: `gradeEvalResult` INSERTS a result, so re-grading either
//     duplicates cells or mutates a finished report, and `loadDrift` derives
//     "the previous comparable run" from those rows. Whichever it does changes
//     what a past report means, which needs designing before it needs exposing.
//   • `delete_eval_run` — a junk run (wrong model, wrong draft) pollutes the
//     drift baseline permanently. Same objection as `deleteAllRuns`: an
//     irreversible purge of history, which the console gates behind a
//     press-and-hold precisely because it cannot be taken back. A tool call has
//     no such moment. `cancel_eval_run` covers the live case, which is the one
//     that costs money.
//   • Hard-delete a Goal (`deleteEvalSet({ purge: true })`) — same reason, and
//     `update_eval_set({ archived: true })` is the reversible answer.
//   • Run ONE Sample — the console's "Run Sample" button actually runs the whole
//     Goal, so there is nothing to mirror. A single-sample sweep is a Goal with
//     one sample in it.
//   • A JUDGE axis on the drift report. `run_eval` can now pin `judgeModelId`,
//     which is the half that prevents the problem. Detecting it after the fact
//     would mean recording the judge on `EvalRowSnapshot` and adding a third
//     drift axis — and the snapshot's hash is a frozen wire format whose digest
//     is locked by a test, so that is a migration-shaped change, not a field.
//
// ── The distinction the whole report hangs on ────────────────────────────────
//
// `error` is not `fail`. A `fail` is the target answering wrongly — the finding
// an eval exists to produce. An `error` is the run never producing an answer to
// grade: the provider refused, the wrapper timed out, the sweep's circuit
// breaker skipped the rest. Rolled together, a provider outage reads as a total
// regression of the agent. So the summary counts them separately, `passRate` is
// computed over GRADED cells only, and the errors are listed with their
// messages.

/** Per-check config in a result, clipped: a judge rubric is prose. */
const CHECK_FIELD_CHARS = 800

/**
 * Per-result rows returned in full. A matrix run is samples × models × prompts ×
 * attempts, so a modest sweep produces hundreds of results; the roll-up above
 * them is always complete, and this bounds only the detail.
 */
const MAX_RESULTS = 60

/**
 * Cells one MCP-launched sweep may request.
 *
 * Every cell is a real model call, so this is the difference between a workload
 * and a bill. The launch dialog bounds this socially — a person picking models
 * sees the count before pressing Run — and a tool call has no such moment.
 */
const MAX_CELLS = 100

/** The always-present prompt column: whatever prompt the target itself saves. */
const BASELINE_PROMPT_LABEL = 'Agent’s saved prompt'

/**
 * Order a report puts itself in: what went wrong first.
 *
 * Not chronological. The reader of an eval report is looking for the failures —
 * a truncated list that dropped them to show sixty passes answers no question
 * anyone had.
 */
const STATUS_RANK: Record<string, number> = { error: 0, fail: 1, pass: 2 }

function checksOf(result: WfEvalResultDTO): EvalCheck[] {
  return result.snapshot?.row.checks.checks ?? []
}

/**
 * Zip a result's verdicts back onto the checks that produced them.
 *
 * A stored `CheckResult` is `{ pass, confidence?, reason? }` and carries no hint
 * of WHICH assertion it answers — the correspondence is positional, against the
 * snapshot's check list (see `gradeRow`, which maps over `checks` in order). A
 * binary check has no `reason`, so without its config a failing one says only
 * `false`, which is not a finding anybody can act on.
 */
function describeChecks(result: WfEvalResultDTO): unknown[] {
  const checks = checksOf(result)
  return result.checkResults.map((r: CheckResult, i: number) => {
    const check = checks[i]
    return {
      type: check?.type ?? 'unknown',
      pass: r.pass,
      confidence: r.confidence,
      // The raw pre-threshold probability a `decision_judge` returned, which is
      // the thing that makes a calibrated judge worth having: 0.52 and 0.99 are
      // both a pass and only one of them is worth looking at. It was dropped
      // here, recoverable only by string-parsing the `p=0.52 ≥ 0.50` that
      // `gradeDecisionJudge` folds into `reason` — which is prose, not a
      // contract.
      probability: r.probability,
      reason: r.reason,
      // The assertion itself, so a binary verdict is readable. Judge rubrics can
      // run long, hence the clip.
      check: check ? clip(check, CHECK_FIELD_CHARS) : undefined,
    }
  })
}

/** The matrix cell a result belongs to, omitted entirely on a plain run. */
function cellOf(result: WfEvalResultDTO): unknown {
  if (result.modelId == null && result.promptLabel == null) return undefined
  return {
    modelId: result.modelId,
    promptLabel: result.promptLabel,
    attempt: result.attempt,
  }
}

function summarizeResult(result: WfEvalResultDTO, name: string): unknown {
  return {
    rowId: result.rowId,
    sample: name,
    // Which Goal this verdict belongs to. `run_eval` takes `setIds` PLURAL and
    // the catalog's "Run tests" button runs every goal, so without this a
    // multi-goal report is a bag of sample names with no way to say which goal
    // regressed. Both live on the frozen snapshot already.
    goalId: result.snapshot?.target.setId,
    goal: result.snapshot?.target.setName,
    status: result.status,
    score: result.score,
    // Present only on `error`, and the only place a zero pass rate can explain
    // itself as infrastructure rather than as the agent being wrong.
    error: result.error,
    wfRunId: result.wfRunId,
    cell: cellOf(result),
    checks: describeChecks(result),
    runStats: result.runStats,
    // See `previousSnapshotHash`: the sample's own definition changed since it
    // last ran, so a moved verdict may be the TEST moving, not the target.
    sampleEditedSinceLastRun:
      result.previousSnapshotHash != null &&
      result.snapshotHash != null &&
      result.previousSnapshotHash !== result.snapshotHash,
  }
}

/** Sample names live on the frozen snapshot; fall back to the id. */
function nameFor(result: WfEvalResultDTO): string {
  return result.snapshot?.row.name ?? result.rowId
}

/**
 * The two axes a moved pass rate can move along, stated separately.
 *
 * `previousSnapshotHash` compares the SAMPLE's definition, so it sees an edited
 * check and is structurally blind to the target agent being republished under a
 * floating `targetVersion` — which changes everything under test and leaves the
 * hash identical. Reported together, a model attributes the wrong cause about
 * half the time; reported apart, it can say which.
 */
function driftReport(detail: WfEvalRunDetail): unknown {
  const drift = detail.drift
  const versions = [
    ...new Set(
      detail.results
        .map((r) => r.runStats?.agentVersion)
        .filter((v): v is number => typeof v === 'number'),
    ),
  ]
  if (!drift) {
    return {
      previousRun: null,
      agentVersionsThisRun: versions,
      note: 'No earlier run covered any of these samples, so there is nothing to compare against.',
    }
  }
  const edited = detail.results.some((r) => {
    return (
      r.previousSnapshotHash != null &&
      r.snapshotHash != null &&
      r.previousSnapshotHash !== r.snapshotHash
    )
  })
  return {
    previousRunId: drift.previousRunId,
    previousRunAt: drift.previousRunAt,
    // Axis 1: did the TEST change?
    samplesEdited: edited,
    goalChanges: drift.goalChanges,
    // Axis 2: did the THING UNDER TEST change? A Goal that floats to latest
    // silently swaps agents between runs.
    previousAgentVersion: drift.previousAgentVersion,
    agentVersionsThisRun: versions,
    agentRepublishedSinceLastRun:
      drift.previousAgentVersion != null &&
      versions.length > 0 &&
      !versions.includes(drift.previousAgentVersion),
    targetChanges: drift.targetChanges,
  }
}

/**
 * What a model must be able to do to run these Goals' targets.
 *
 * The union across every agent target, because one model runs every cell of a
 * column — a sweep spanning a tool-using agent and a structured-output one needs
 * a model that can do both. A draft override replaces the whole config, so its
 * own requirements are the only ones that matter.
 *
 * Returns undefined when nothing can be said: no agent target (workflow goals
 * hold their agents inside the graph, which the list endpoints don't carry —
 * TODO(ART-201), same gap the launch dialog has), or the agent rows are
 * unreadable. Undefined means "don't gate", never "gate everything".
 */
async function targetRequirements(
  client: WfDataClient,
  sets: (WfEvalSetDetail | null)[],
  configOverride: AgentConfig | undefined,
): Promise<ModelCapabilities | undefined> {
  if (configOverride) return agentModelRequirements(configOverride)
  const agentIds = sets
    .filter((s) => s?.set.targetKind === 'agent')
    .map((s) => s!.set.targetId)
  if (agentIds.length === 0) return undefined
  const agents = await client.listAgents().catch(() => [])
  const perAgent = agents
    .filter((a) => agentIds.includes(a.id))
    .map((a) => a.modelRequirements)
    .filter((r): r is ModelCapabilities => r != null)
  return perAgent.length > 0 ? mergeModelRequirements(perAgent) : undefined
}

export function evalRunReadTools(): WfMcpTool[] {
  return [
    {
      name: 'list_eval_runs',
      title: 'List eval runs',
      description:
        'Past eval runs, newest first — which goals each covered, its status, and its totals. `notPassed` lumps failed and errored cells together; get_eval_run separates them, and only it can tell a regression from an outage. Use to find a run to read, or to see whether a goal has ever been run.',
      inputSchema: {
        limit: z
          .number()
          .nullish()
          .describe('How many runs (default 20, max 100).'),
      },
      readOnly: true,
      run: async (client, args) => {
        const limit =
          typeof args.limit === 'number' && Number.isFinite(args.limit)
            ? Math.min(Math.max(Math.floor(args.limit), 1), 100)
            : 20
        const runs = await client.listEvalRuns({ limit })
        // A run stores only `setIds`; naming the goals is the difference between
        // a readable history and a list of uuids.
        const names = new Map<string, string>()
        try {
          for (const s of await client.listEvalSets({
            includeArchived: true,
          })) {
            names.set(s.id, s.name)
          }
        } catch {
          // History is still worth returning without the names.
        }
        return runs.map((r) => {
          // `failed` is stored as `total - passed`, which folds errored cells
          // (a run that never produced an answer) in with the target actually
          // answering wrongly. Renamed here rather than passed through under a
          // name that isn't true; `get_eval_run` separates the two properly.
          const { failed, score, ...rest } = r
          return {
            ...rest,
            notPassed: failed,
            meanJudgeScore: score,
            goals: r.setIds.map((id) => names.get(id) ?? id),
          }
        })
      },
    },

    {
      name: 'get_eval_run',
      title: 'Get eval run report',
      description: [
        "One eval run's report: per-sample verdict, the reason each check gave, cost/tokens/model of the graded call, and what changed since the last comparable run.",
        '',
        'READ THE COUNTS BEFORE THE PASS RATE — `errored` cells never produced an answer to grade (provider refused, run timed out) and are not the target being wrong. Poll this after run_eval until `status` is `completed`.',
        '',
        'When the run swept models or prompts, `matrix` answers "which one won?": one row per model × prompt cell with its pass rate, mean score, average cost and measured throughput, plus the `bestAccuracy` / `cheapest` / `fastest` cell keys. `cost` carries what the sweep actually spent. Both are computed over EVERY result, not just the ones listed — so they stay true when the detail list is truncated.',
        '',
        `The \`results\` list is bounded at ${MAX_RESULTS} rows, worst first. Narrow it with \`status\` / \`modelId\` / \`promptLabel\`, page it with \`offset\`, or pass \`rowId\` to read one sample's cells unclipped.`,
      ].join('\n'),
      inputSchema: {
        evalRunId: z
          .string()
          .describe('Eval run id, from run_eval or list_eval_runs.'),
        rowId: z
          .string()
          .nullish()
          .describe(
            'Drill in: return only this sample’s results (every matrix cell of it), unclipped.',
          ),
        status: z
          .string()
          .nullish()
          .describe(
            'Keep only results with this verdict: "pass", "fail" or "error".',
          ),
        modelId: z
          .string()
          .nullish()
          .describe('Keep only the matrix column for this model id.'),
        promptLabel: z
          .string()
          .nullish()
          .describe('Keep only the matrix row for this prompt label.'),
        offset: z
          .number()
          .nullish()
          .describe(
            `Skip this many results before listing — how to read past the ${MAX_RESULTS}-row page. The order is worst-first and stable.`,
          ),
      },
      readOnly: true,
      run: async (client, args) => {
        const evalRunId = reqString(args.evalRunId, 'evalRunId')
        const detail = await client.getEvalRun(evalRunId)
        if (!detail) return { error: `No eval run found for id ${evalRunId}.` }

        const rowId = typeof args.rowId === 'string' ? args.rowId : undefined
        const all = detail.results
        const counts = {
          passed: all.filter((r) => r.status === 'pass').length,
          failed: all.filter((r) => r.status === 'fail').length,
          errored: all.filter((r) => r.status === 'error').length,
        }
        const graded = counts.passed + counts.failed

        // Every filter narrows only the DETAIL list. The roll-up above it is
        // always computed over `all`, because a matrix summary of the rows that
        // survived a status filter would crown the best of the failures.
        const status = optString(args.status)
        const modelId = optString(args.modelId)
        const promptLabel = optString(args.promptLabel)
        const scope = all.filter((r) => {
          if (rowId && r.rowId !== rowId) return false
          if (status && r.status !== status) return false
          if (modelId && r.modelId !== modelId) return false
          if (promptLabel && r.promptLabel !== promptLabel) return false
          return true
        })
        if (rowId && !all.some((r) => r.rowId === rowId)) {
          return {
            error: `Eval run ${evalRunId} has no results for sample ${rowId}.`,
            sampleIds: [...new Set(all.map((r) => r.rowId))],
          }
        }
        if (scope.length === 0 && all.length > 0) {
          return {
            error: 'No results in this run match those filters.',
            available: {
              statuses: [...new Set(all.map((r) => r.status))],
              modelIds: [
                ...new Set(
                  all.map((r) => r.modelId).filter((v): v is string => v != null),
                ),
              ],
              promptLabels: [
                ...new Set(
                  all
                    .map((r) => r.promptLabel)
                    .filter((v): v is string => v != null),
                ),
              ],
            },
          }
        }
        const ordered = [...scope].sort(
          (a, b) => (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9),
        )
        // `rowId` is the drill-in — one sample's cells, all of them, no page.
        const offset = rowId
          ? 0
          : Math.max(0, Math.floor(Number(args.offset) || 0))
        const shown = rowId
          ? ordered
          : ordered.slice(offset, offset + MAX_RESULTS)
        const matrix = isMatrixRun(all) ? buildMatrixSummary(all) : null
        const totals = agentCallTotals(all)

        return {
          // Deliberately NOT `detail.run` verbatim. The stored summary's
          // `failed` is `total - passed` and its `score` divides by `total`, so
          // an errored cell is counted there as the target failing — the exact
          // misreading this tool exists to prevent. The identity and timing
          // fields are true; the counting belongs to `summary` below.
          run: {
            id: detail.run.id,
            status: detail.run.status,
            goalIds: detail.run.setIds,
            total: detail.run.total,
            createdAt: detail.run.createdAt,
            startedAt: detail.run.startedAt,
            finishedAt: detail.run.finishedAt,
          },
          summary: {
            ...counts,
            // Requested but not yet recorded — a run still fanning out.
            pending: Math.max(0, detail.run.total - all.length),
            graded,
            // Over GRADED cells only. Dividing by `total` would let an outage
            // read as a regression, which is the one misreading this report
            // must not allow.
            passRate: graded > 0 ? counts.passed / graded : null,
            meanJudgeScore: detail.run.score,
          },
          // What the sweep spent, and how fast. Scoped to the AGENT calls
          // upstream in `loadRunStats`, so this is the cost of the thing under
          // test rather than the cost of measuring it. Judge calls are not in it.
          cost: {
            totalUsd: totals.totalCostUsd,
            avgUsdPerCell: totals.avgCostUsd,
            totalTokens: totals.totalTokens,
            avgDurationMs: totals.avgDurationMs,
            measuredCells: totals.count,
          },
          // One row per model × prompt cell, with the per-column winners — the
          // question a sweep was launched to answer. Absent on a plain run,
          // where there is only one cell and nothing to compare it against.
          matrix: matrix
            ? {
                modelAxis: matrix.modelAxis,
                promptAxis: matrix.promptAxis,
                cells: matrix.cells,
                // Keys into `cells` (`"<modelId> <promptLabel>"`), null when
                // nothing in that column was comparable. Cost and speed count
                // PASSING runs only: the fastest route to a wrong answer is not
                // a winner.
                bestAccuracy: matrix.bestAcc,
                cheapest: matrix.cheapest,
                fastest: matrix.fastest,
              }
            : undefined,
          // Errors first and in full: they are the reason a pass rate can lie.
          errors: all
            .filter((r) => r.status === 'error')
            .map((r) => ({
              rowId: r.rowId,
              sample: nameFor(r),
              wfRunId: r.wfRunId,
              cell: cellOf(r),
              error: r.error,
            })),
          drift: driftReport(detail),
          results: shown.map((r) => summarizeResult(r, nameFor(r))),
          resultsWindow: rowId
            ? undefined
            : { offset, shown: shown.length, matched: ordered.length },
          note:
            !rowId && ordered.length > shown.length
              ? `Showing results ${offset + 1}-${offset + shown.length} of ${ordered.length} matched, worst first. Read the rest with offset: ${offset + shown.length}, narrow with status/modelId/promptLabel, or pass rowId for one sample's cells. The \`summary\`, \`cost\` and \`matrix\` blocks above already cover every cell.`
              : undefined,
        }
      },
    },
  ]
}

export function evalRunWriteTools(): WfMcpTool[] {
  return [
    {
      name: 'run_eval',
      title: 'Run eval goals',
      description: [
        'Run one or more Goals: every Sample is executed against its target for real and graded by its checks. Returns the evalRunId immediately and the sweep continues on the server, so poll get_eval_run until `status` is `completed`.',
        '',
        'Optionally sweep across models and alternate prompts, grade an agent’s unsaved draft with draftAgentId, or pin the judge with judgeModelId. Every model you name is checked against the target’s requirements first: a model that cannot do what the agent needs is refused here rather than erroring in every cell of its column and reading as an outage.',
        '',
        `Each cell is a real model call and the cap is ${MAX_CELLS} cells. Keep sweeps small.`,
      ].join('\n'),
      inputSchema: {
        setIds: z
          .array(z.string())
          .describe('Goal ids to run, from list_eval_sets.'),
        concurrency: z
          .number()
          .nullish()
          .describe(
            `Runs in flight at once, 1-8 (default ${DEFAULT_EVAL_CONCURRENCY}). This is the rate the whole sweep hits the model provider.`,
          ),
        models: z
          .array(z.string())
          .nullish()
          .describe(
            'Sweep across these model ids (composite catalog ids, from the agent’s model field). Omit to run the target’s own saved model.',
          ),
        attempts: z
          .number()
          .nullish()
          .describe(
            'Best-of-N: run every sample this many times per model, to see variance. Default 1. Requires models.',
          ),
        attemptsByModel: z
          .record(z.string(), z.number())
          .nullish()
          .describe(
            'Per-model override of `attempts`, keyed by model id — e.g. { "<candidate>": 5 } for best-of-5 on the candidate while every other column stays at 1. This is the cheap variance experiment: uniform attempts multiply the whole matrix, and the cell cap makes that expensive. Ids not in `models` are ignored.',
          ),
        draftAgentId: z
          .string()
          .nullish()
          .describe(
            'Grade this agent’s UNSAVED draft instead of its published version — the way to find out whether an update_agent_draft edit helped without publishing it. Every named Goal must target this same agent.',
          ),
        judgeModelId: z
          .string()
          .nullish()
          .describe(
            'Pin the model the JUDGE checks are graded by (a chat model id from list_models — NOT the same thing as `models`, which is what the target runs on). Omit and the judge is the host default, or failing that whatever sorts first in the enabled catalog — so enabling a model can silently re-grade a whole suite, and the drift report will blame the agent. Pin it whenever you intend to compare this report against an earlier one.',
          ),
        prompts: z
          .array(
            z.object({
              label: z.string().describe('Names the column in the report.'),
              body: z
                .string()
                .describe('System prompt to use instead of the saved one.'),
            }),
          )
          .nullish()
          .describe(
            'Alternate system prompts to compare against the saved one, which is always included as a baseline column. Requires models.',
          ),
      },
      readOnly: false,
      run: async (client, args) => {
        const setIds = (Array.isArray(args.setIds) ? args.setIds : []).filter(
          (id): id is string => typeof id === 'string' && id.length > 0,
        )
        if (setIds.length === 0) {
          throw new Error(
            'Missing required argument `setIds` — one or more goal ids, from list_eval_sets.',
          )
        }

        const models = (Array.isArray(args.models) ? args.models : []).filter(
          (m): m is string => typeof m === 'string' && m.length > 0,
        )
        const prompts = Array.isArray(args.prompts)
          ? (args.prompts as { label?: unknown; body?: unknown }[])
          : []
        const attempts =
          typeof args.attempts === 'number' && args.attempts > 1
            ? Math.floor(args.attempts)
            : 1

        // A sweep is models × prompts; with no model to run them on there is no
        // cell for a prompt variation to be, and the plan would expand the
        // matrix to zero jobs and finalize an empty report.
        if (models.length === 0 && (prompts.length > 0 || attempts > 1)) {
          throw new Error(
            '`prompts` and `attempts` are matrix columns and need at least one entry in `models` to run against. Pass the target’s own model id to compare prompts on it.',
          )
        }

        // Count the cells before launching. The sets have to be read anyway to
        // know how many samples there are, and a model that asks for a 400-cell
        // sweep should be told so rather than billed for it.
        const sets = await Promise.all(
          setIds.map((id) => client.getEvalSet(id)),
        )
        const missing = setIds.filter((_, i) => sets[i] === null)
        if (missing.length > 0) {
          return {
            error: `No eval goal found for id ${missing.join(', ')}. Ids come from list_eval_sets.`,
          }
        }
        const samples = sets.reduce(
          (n, s) => n + (s ? s.rows.filter((r) => !r.archived).length : 0),
          0,
        )
        if (samples === 0) {
          return {
            error:
              'Those goals have no samples, so there is nothing to run. Add samples with upsert_eval_sample first.',
          }
        }
        // The draft override rides on every cell of the sweep and the server
        // applies it without checking WHOSE config it is — the editor can't hit
        // that because it only ever runs its own agent's goals, but a tool call
        // naming an unrelated setId would silently grade agent A's draft against
        // agent B's samples and report the result as B's.
        const draftAgentId = optString(args.draftAgentId)
        let configOverride: AgentConfig | undefined
        let unsavedFields: string[] = []
        if (draftAgentId) {
          const mismatched = sets.filter((s) => {
            return (
              s &&
              (s.set.targetKind !== 'agent' || s.set.targetId !== draftAgentId)
            )
          })
          if (mismatched.length > 0) {
            return {
              error: `draftAgentId only applies to goals that target that agent, and ${mismatched
                .map((s) => `"${s?.set.name ?? '?'}"`)
                .join(
                  ', ',
                )} does not. Run those separately, without draftAgentId.`,
            }
          }
          const detail = await client.getAgent(draftAgentId)
          if (!detail) {
            return { error: `No agent found for id ${draftAgentId}.` }
          }
          const chosen = draftOrPublished(detail)
          if (!chosen || chosen.source !== 'draft') {
            return {
              error: `Agent ${draftAgentId} has no draft to override with. Drop draftAgentId to grade the published version.`,
            }
          }
          configOverride = chosen.config
          // NOT a refusal: this run is exactly as valid as the one you get by
          // dropping the argument, and its results are real. But a draft row
          // exists for nearly every agent and usually matches what was last
          // published, so a sweep launched to answer "did my edit help?" can
          // measure the live config and read as though it measured the edit.
          unsavedFields = chosen.unsavedFields
        }

        // Per-model attempt counts, defaulting to the sweep-wide `attempts`.
        // An id that isn't in `models` is ignored rather than refused: it names a
        // column that doesn't exist, which changes nothing about the sweep.
        const byModel =
          args.attemptsByModel && typeof args.attemptsByModel === 'object'
            ? (args.attemptsByModel as Record<string, unknown>)
            : {}
        const attemptsFor = (modelId: string): number => {
          const raw = byModel[modelId]
          return typeof raw === 'number' && raw > 1 ? Math.floor(raw) : attempts
        }

        // ── Gate the models before spending anything ──────────────────────────
        //
        // Two refusals, both of which used to be a launched sweep that could only
        // fail: an id that is not in the catalog at all, and one that IS but
        // cannot do what the target needs. Either way every cell of that column
        // errors, three in a row latch the circuit breaker (`providerDown`), and
        // the remaining cells are recorded as skips — so the report reads as an
        // outage, the budget is spent, and nothing was learned. The launch dialog
        // never has this problem because it only ever offers models that pass the
        // same gate.
        if (models.length > 0) {
          const catalog: ModelOption[] = await client
            .listModels()
            .catch(() => [])
          // An empty catalog means the read failed or nothing is enabled; gating
          // on it would refuse every legal sweep, so it means "cannot check".
          if (catalog.length > 0) {
            const known = new Map(catalog.map((m) => [m.id, m]))
            const unknown = models.filter((id) => !known.has(id))
            if (unknown.length > 0) {
              return {
                error: `Not a model id in this catalog: ${unknown.join(', ')}. Ids are composite \`provider:model\` and come from list_models — the provider-native half alone will 404 at the provider.`,
              }
            }
            const requirements = await targetRequirements(
              client,
              sets,
              configOverride,
            )
            if (requirements) {
              const gated = models
                .map((id) => ({
                  id,
                  reason: unmetRequirementsReason(known.get(id)!, requirements),
                }))
                .filter((m) => m.reason != null)
              if (gated.length > 0) {
                return {
                  error: `These models cannot run the target(s) of those goals, so every cell of their column would error: ${gated
                    .map((m) => `${m.id} (${m.reason})`)
                    .join(
                      ', ',
                    )}. list_models shows each model's \`capabilities\`; drop them or pick models that meet the requirement.`,
                  requirements,
                }
              }
            }
          }
        }

        const columns = models.length > 0
          ? models.reduce((n, id) => n + attemptsFor(id), 0) *
            (1 + prompts.length)
          : 1
        const cells = samples * columns
        if (cells > MAX_CELLS) {
          return {
            error: `That sweep is ${cells} runs (${samples} samples × ${columns} cells) and the cap is ${MAX_CELLS}. Every cell is a real model call. Narrow it: fewer models, fewer attempts, or one goal at a time.`,
          }
        }

        const input: RunEvalInput = {
          setIds,
          configOverride,
          judgeModelId: optString(args.judgeModelId),
          concurrency:
            typeof args.concurrency === 'number' ? args.concurrency : undefined,
          matrix:
            models.length > 0
              ? {
                  models: models.map((modelId) => ({
                    modelId,
                    attempts: attemptsFor(modelId),
                  })),
                  prompts: [
                    // The baseline carries no `body`, so the target's own saved
                    // prompt runs — the column every comparison is against.
                    { label: BASELINE_PROMPT_LABEL },
                    ...prompts.map((p, i) => ({
                      label:
                        typeof p.label === 'string' && p.label.length > 0
                          ? p.label
                          : `Test prompt ${i + 1}`,
                      body: typeof p.body === 'string' ? p.body : '',
                    })),
                  ],
                }
              : undefined,
        }

        // Create the run with its frozen plan, then drive exactly ONE tick:
        // enough to launch the first cells so the report shows movement and the
        // run leaves `queued`, and short enough that the tool still answers in
        // seconds. The host's resume backstop drives the rest.
        //
        // This endpoint is why sweeps had to become resumable at all. It runs
        // as a single Worker request, whose context is destroyed the instant it
        // responds — so the old fire-and-forget orchestration was cancelled
        // before its first cell started and every MCP-launched run sat at
        // `queued` forever, with the rejection landing in a log nobody read.
        // Now nothing here needs to outlive the response.
        const { evalRunId, plan } = await createEvalSweep(client, input)
        await driveEvalRun(client, evalRunId, { budgetMs: 0 })

        return {
          evalRunId,
          launched: {
            samples,
            cellsPerSample: columns,
            // The plan's own count, not the estimate the cap was checked
            // against: a set whose rows were archived between the count and the
            // expansion produces fewer cells, and the report will show that
            // number rather than this one.
            totalRuns: plan.cells.length,
            // Stated on the way out because the report itself doesn't say it:
            // a draft run and a published run look identical afterwards.
            target: configOverride
              ? `the draft of agent ${draftAgentId ?? ''}`
              : 'each goal’s published target',
            // Echoed because the report cannot say it either way: the judge is
            // not recorded per result, so "which judge graded this?" is only
            // answerable from the plan this launch froze.
            judge:
              plan.judgeModelId ??
              'the host default (unpinned — a later run may use a different judge)',
            attemptsPerModel:
              models.length > 0
                ? Object.fromEntries(
                    models.map((id) => [id, attemptsFor(id)]),
                  )
                : undefined,
            ...(configOverride
              ? {
                  unsavedFields,
                  draftWarning:
                    unsavedFields.length === 0
                      ? 'That draft is IDENTICAL to the published version, so this sweep measures the live agent — not an edit. If you meant to grade a change, write it with update_agent_draft first.'
                      : undefined,
                }
              : {}),
          },
          next: `The sweep runs on the server, not in this session — it finishes whether or not you stay connected. Poll get_eval_run("${evalRunId}") every 20-30s until status is "completed". Read \`errored\` separately from \`failed\` — an errored cell never produced an answer to grade.`,
        }
      },
    },
    {
      name: 'resume_eval_run',
      title: 'Resume a stalled eval run',
      description: [
        'Push a sweep that has stopped moving. Settles whatever finished, launches the next batch of cells up to the run’s concurrency, and returns — it does not wait for the sweep to complete, so call it again (or poll get_eval_run) until `status` is `completed`.',
        '',
        'Only needed when nothing else is driving. A sweep’s plan is persisted on the run row, so normally either the browser tab that launched it or the host’s cron backstop finishes it. A run stuck at `queued` or `running` with a stale heartbeat means neither is — most often a host with no backstop wired — and before this there was no way to move it from here at all.',
        '',
        'Safe to call repeatedly and safe to race: drive state is re-read from storage every tick, so a cell already in flight is polled rather than started a second time. A run that has already finished returns `done` and changes nothing. Runs created before sweeps were resumable have no plan and cannot be driven.',
      ].join('\n'),
      inputSchema: {
        evalRunId: z
          .string()
          .describe('Eval run id, from run_eval or list_eval_runs.'),
      },
      readOnly: false,
      run: async (client, args) => {
        const evalRunId = reqString(args.evalRunId, 'evalRunId')
        const before = await client.getEvalRun(evalRunId)
        if (!before) return { error: `No eval run found for id ${evalRunId}.` }
        if (before.run.status === 'completed') {
          return {
            evalRunId,
            done: true,
            status: before.run.status,
            note: 'That run is already complete — read it with get_eval_run.',
          }
        }
        if (before.run.status === 'cancelled') {
          return {
            evalRunId,
            done: true,
            status: before.run.status,
            note: 'That run was cancelled, so its remaining cells will not be launched. Start a fresh sweep with run_eval.',
          }
        }
        // One tick, the same budget `run_eval` uses and for the same reason: this
        // is a single Worker request whose context dies with the response, so a
        // driver that kept going here would simply be cancelled mid-cell.
        let done = false
        try {
          const result = await driveEvalRun(client, evalRunId, { budgetMs: 0 })
          done = result.done
        } catch (err) {
          // The one expected throw: a pre-plan run, which is a permanent
          // condition and worth saying plainly rather than surfacing as a stack.
          return {
            evalRunId,
            error: err instanceof Error ? err.message : String(err),
          }
        }
        const after = await client.getEvalRun(evalRunId)
        const settledBefore = before.results.length
        const settledAfter = after?.results.length ?? settledBefore
        return {
          evalRunId,
          done,
          status: after?.run.status ?? before.run.status,
          settled: settledAfter,
          total: after?.run.total ?? before.run.total,
          progressedBy: settledAfter - settledBefore,
          next: done
            ? `Finished. Read the report with get_eval_run("${evalRunId}").`
            : `Still going: ${settledAfter} of ${after?.run.total ?? before.run.total} cells have a verdict. Call resume_eval_run again in 20-30s, or poll get_eval_run if something else is driving it.`,
        }
      },
    },

    {
      name: 'cancel_eval_run',
      title: 'Cancel an eval run',
      description: [
        'Call off a sweep that is still queued or running. Every cell is a real, billed model call, so a mis-aimed 100-cell sweep was previously money that could only be watched.',
        '',
        'Nothing is killed mid-flight: the cells already started finish and are graded, and no further cell is launched. The verdicts already recorded are kept and stay readable — `total` minus the settled count is what was called off, and get_eval_run shows that difference as `pending`.',
        '',
        'A run that has already completed is left alone rather than rewritten, and the reply says so.',
      ].join('\n'),
      inputSchema: {
        evalRunId: z
          .string()
          .describe('Eval run id, from run_eval or list_eval_runs.'),
      },
      readOnly: false,
      run: async (client, args) => {
        const evalRunId = reqString(args.evalRunId, 'evalRunId')
        const result = await client.cancelEvalRun(evalRunId)
        return {
          evalRunId,
          ...result,
          note: result.cancelled
            ? `Stopped. ${result.settled} of ${result.total} cells had a verdict; the rest were not launched. The report is still readable with get_eval_run("${evalRunId}").`
            : `Nothing to cancel — that run is already "${result.status}".`,
        }
      },
    },
  ]
}
