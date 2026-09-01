import { z } from 'zod'

import type { CheckResult, EvalCheck } from '../eval/checks'
import {
  DEFAULT_EVAL_CONCURRENCY,
  runEval,
  type RunEvalInput,
} from '../eval/run-eval'
import { clip } from '../server/clip'
import type {
  AgentConfig,
  WfEvalResultDTO,
  WfEvalRunDetail,
} from '../server/protocol'

import { optString, reqString, type WfMcpTool } from './tools'
import { draftOrPublished } from './tools-agents'

// Running a Goal and reading its report — the half of the loop that makes the
// authoring half self-checking. Without these, a model can write a Sample and
// has no way to find out whether it was a good one.
//
// ── Why launching does not block ─────────────────────────────────────────────
//
// `runEval` fans every (sample × model × prompt × attempt) cell out into a real
// run and waits up to fifteen minutes per cell. A tool call that awaited all of
// that would time out long before the report existed. So `run_eval` resolves on
// `onStart` — the moment the umbrella run row exists — and the model polls
// `get_eval_run`. That is also how the launch dialog behaves; the report page it
// navigates to is a poller.
//
// The orchestration runs in THIS process. If the MCP session ends mid-sweep, the
// remaining cells are never launched and the run is never finalized — it sits at
// `running` forever, exactly as it does when a browser tab is closed. The tool
// says so, because a model that fires a sweep and disconnects has produced a
// half-finished report and no error anywhere.
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
  const edited = detail.results.some(
    (r) =>
      r.previousSnapshotHash != null &&
      r.snapshotHash != null &&
      r.previousSnapshotHash !== r.snapshotHash,
  )
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

export function evalRunReadTools(): WfMcpTool[] {
  return [
    {
      name: 'list_eval_runs',
      title: 'List eval runs',
      description:
        'Past eval runs, newest first — which goals each covered, its status, and its totals. `notPassed` lumps failed and errored cells together; get_eval_run separates them, and only it can tell a regression from an outage. Use to find a run to read, or to see whether a goal has ever been run.',
      inputSchema: {
        limit: z.number().nullish().describe('How many runs (default 20, max 100).'),
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
          for (const s of await client.listEvalSets({ includeArchived: true })) {
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
      description:
        "One eval run's report: per-sample verdict, the reason each check gave, cost/tokens/model of the graded call, and what changed since the last comparable run. READ THE COUNTS BEFORE THE PASS RATE — `errored` cells never produced an answer to grade (provider refused, run timed out) and are not the target being wrong. Poll this after run_eval until `status` is `completed`.",
      inputSchema: {
        evalRunId: z.string().describe('Eval run id, from run_eval or list_eval_runs.'),
        rowId: z
          .string()
          .nullish()
          .describe(
            'Drill in: return only this sample’s results (every matrix cell of it), unclipped.',
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

        const scope = rowId ? all.filter((r) => r.rowId === rowId) : all
        if (rowId && scope.length === 0) {
          return {
            error: `Eval run ${evalRunId} has no results for sample ${rowId}.`,
            sampleIds: [...new Set(all.map((r) => r.rowId))],
          }
        }
        const ordered = [...scope].sort(
          (a, b) => (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9),
        )
        const shown = rowId ? ordered : ordered.slice(0, MAX_RESULTS)

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
          note:
            !rowId && ordered.length > shown.length
              ? `Showing ${shown.length} of ${ordered.length} results, worst first. Pass rowId to read one sample's cells.`
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
      description:
        'Run one or more Goals: every Sample is executed against its target for real and graded by its checks. Returns the evalRunId immediately — the sweep keeps running in this MCP session, so poll get_eval_run until `status` is `completed`, and do not end the session before it is (the remaining cells would never launch). Optionally sweep across models and alternate prompts, or grade an agent’s unsaved draft with draftAgentId. Each cell is a real model call; keep sweeps small.',
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
        draftAgentId: z
          .string()
          .nullish()
          .describe(
            'Grade this agent’s UNSAVED draft instead of its published version — the way to find out whether an update_agent_draft edit helped without publishing it. Every named Goal must target this same agent.',
          ),
        prompts: z
          .array(
            z.object({
              label: z.string().describe('Names the column in the report.'),
              body: z.string().describe('System prompt to use instead of the saved one.'),
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
        // cell for a prompt variation to be, and `runEval` would expand the
        // matrix to zero jobs and finalize an empty report.
        if (models.length === 0 && (prompts.length > 0 || attempts > 1)) {
          throw new Error(
            '`prompts` and `attempts` are matrix columns and need at least one entry in `models` to run against. Pass the target’s own model id to compare prompts on it.',
          )
        }

        // Count the cells before launching. The sets have to be read anyway to
        // know how many samples there are, and a model that asks for a 400-cell
        // sweep should be told so rather than billed for it.
        const sets = await Promise.all(setIds.map((id) => client.getEvalSet(id)))
        const missing = setIds.filter((_, i) => !sets[i])
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
          const mismatched = sets.filter(
            (s) =>
              s &&
              (s.set.targetKind !== 'agent' || s.set.targetId !== draftAgentId),
          )
          if (mismatched.length > 0) {
            return {
              error: `draftAgentId only applies to goals that target that agent, and ${mismatched
                .map((s) => `"${s?.set.name ?? '?'}"`)
                .join(', ')} does not. Run those separately, without draftAgentId.`,
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

        const columns = Math.max(1, models.length) * attempts * (1 + prompts.length)
        const cells = samples * columns
        if (cells > MAX_CELLS) {
          return {
            error: `That sweep is ${cells} runs (${samples} samples × ${columns} cells) and the cap is ${MAX_CELLS}. Every cell is a real model call. Narrow it: fewer models, fewer attempts, or one goal at a time.`,
          }
        }

        const input: RunEvalInput = {
          setIds,
          configOverride,
          concurrency:
            typeof args.concurrency === 'number' ? args.concurrency : undefined,
          matrix:
            models.length > 0
              ? {
                  models: models.map((modelId) => ({ modelId, attempts })),
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

        // Resolve on `onStart`, not on completion: the sweep takes minutes to
        // tens of minutes and a tool call cannot wait that long. Failures BEFORE
        // the run row exists still reach the caller, because they reject this
        // promise before it settles.
        let started = false
        const evalRunId = await new Promise<string>((resolve, reject) => {
          runEval(client, {
            ...input,
            onStart: (id) => {
              started = true
              resolve(id)
            },
          }).then(
            () => {},
            (err: unknown) => {
              if (started) {
                // The tool call has already returned, so this rejection lands
                // nowhere and the log is the only place left to say it. Never
                // silent: a sweep that dies half way leaves the run stuck at
                // `running` with nothing anywhere explaining why.
                console.error('[wf-mcp] eval sweep failed:', err)
                return
              }
              reject(err instanceof Error ? err : new Error(String(err)))
            },
          )
        })

        return {
          evalRunId,
          launched: {
            samples,
            cellsPerSample: columns,
            totalRuns: cells,
            // Stated on the way out because the report itself doesn't say it:
            // a draft run and a published run look identical afterwards.
            target: configOverride
              ? `the draft of agent ${draftAgentId ?? ''}`
              : 'each goal’s published target',
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
          next: `The sweep is running in this session. Poll get_eval_run("${evalRunId}") every 20-30s until status is "completed". Read \`errored\` separately from \`failed\` — an errored cell never produced an answer to grade.`,
        }
      },
    },
  ]
}
