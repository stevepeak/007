import type { AnyAgentConfig } from '../engine/decision-agent-schema'
import { hasJudgeChecks } from '../engine/eval-schema'
import type { WfDataClient } from '../server/protocol'

import {
  type EvalCellMode,
  type EvalMatrixModel,
  type EvalMatrixPrompt,
  type EvalPlan,
  expandEvalCells,
} from './plan'

// Running a Goal — the orchestrator, with no framework in it.
//
// The caller creates the umbrella run with a frozen PLAN of every cell, then
// starts the workflow that works through it. The
// running of it lives in `./sweep`; everything here is about launching one.
//
// A sweep runs entirely on the server, in a workflow of its own (`./sweep`). The
// plan is persisted on the run row, so whoever launched it only reads progress
// back, which is why a closed tab or an ended MCP request cannot affect it.
//
// Errors on one cell don't abort the batch; the run is finalized over whatever
// results landed — and EVERY cell lands something, pass, fail, or error, so the
// run's totals always match what was requested.

export type { EvalMatrixModel, EvalMatrixPrompt }

/**
 * How long to wait for one cell's run to reach a terminal status.
 *
 * This MUST exceed the server's own bound on a failing agent node (see
 * `EVAL_NODE_EXECUTION` in `./execution-policy`), or it fires first and
 * we're back to a waiter that gives up before the thing it waits on can
 * possibly answer — which is exactly how a provider outage produced an eval
 * report with zero results and no explanation.
 */
const EVAL_WAIT_TIMEOUT_MS = 15 * 60_000

/**
 * Concurrent runs one eval may have in flight. Each is a full agent call, so
 * this is the rate at which the whole matrix hits the model provider — the
 * knob that decides whether a large sweep is a workload or a denial of service.
 *
 * The default stays low because a big matrix against a struggling provider is
 * exactly how a 429 storm starts. Raising it is now much safer than it was —
 * the circuit breaker stops the run after three consecutive provider failures
 * and every cell records its own outcome — so the launch dialog offers the
 * choice rather than hard-coding one.
 */
export const DEFAULT_EVAL_CONCURRENCY = 2
/**
 * The values the launch dialog offers — coarse steps rather than a free-form
 * number, because the difference that matters is order-of-magnitude pressure on
 * the provider, not 5 versus 6. Each slot is one in-flight agent call; the runs
 * themselves each execute in their own Durable Object and don't contend
 * locally, so this bounds the model API and nothing else.
 */
export const EVAL_CONCURRENCY_CHOICES = [1, 2, 4, 8] as const

// The clamp ceiling is the largest offered choice, derived rather than restated
// so the two can't drift apart.
const MAX_EVAL_CONCURRENCY = Math.max(...EVAL_CONCURRENCY_CHOICES)

function clampConcurrency(n?: number) {
  return Math.max(
    1,
    Math.min(n ?? DEFAULT_EVAL_CONCURRENCY, MAX_EVAL_CONCURRENCY),
  )
}

export type RunEvalInput = {
  setIds: string[]
  /**
   * Run every cell against this agent config instead of the target's published
   * version — the agent editor testing its goals against UNSAVED edits. Nothing
   * is persisted on the AGENT; the config is frozen into the run's plan so a
   * restarted sweep grades the same thing the launcher meant to. The matrix's
   * `modelId` / `promptBody` still layer on top of it, so a draft can be swept
   * across models and alternate prompts exactly like a published agent.
   * Omitted → the published version (every other caller).
   */
  configOverride?: AnyAgentConfig
  /**
   * The model × prompt sweep. Omitted → a single plain run per sample on the
   * target's own saved model + prompt (preserves the pre-matrix behavior). When
   * present, every sample is run for each (model × prompt × attempt) cell.
   */
  matrix?: { models: EvalMatrixModel[]; prompts: EvalMatrixPrompt[] }
  /**
   * The decision model every judge check is graded by. Required when the
   * sweep's Samples carry a judge check — checks cannot name their own, so one
   * report has one judge. Frozen into the plan so a restarted sweep grades by
   * the same one.
   */
  decisionJudgeModelId?: string
  /**
   * How each cell executes — see {@link EvalCellMode}. Omitted → `'run'`, the
   * workflow/generation-agent path. The caller supplies it because only the
   * caller has already resolved the Goal's target; the plan then freezes it so
   * a restarted sweep doesn't have to re-derive it from a target that may have
   * been repointed since.
   */
  mode?: EvalCellMode
  concurrency?: number
  timeoutMs?: number
}

/** Create the umbrella run with its frozen plan, launching nothing. */
export async function createEvalSweep(
  client: WfDataClient,
  input: RunEvalInput,
): Promise<{ evalRunId: string; plan: EvalPlan }> {
  const sets = await Promise.all(
    input.setIds.map((id) => client.getEvalSet(id)),
  )
  const rows = sets
    .filter((s): s is NonNullable<typeof s> => !!s)
    .flatMap((s) => s.rows)
  const rowIds = rows.map((row) => row.id)

  const judged = hasJudgeChecks(rows.map((row) => row.checks))
  if (judged && !input.decisionJudgeModelId) {
    throw new Error(
      'These Samples have judge checks — pick the decision judge for this run.',
    )
  }

  const plan: EvalPlan = {
    version: 1,
    cells: expandEvalCells(rowIds, input.matrix),
    mode: input.mode ?? 'run',
    configOverride: input.configOverride,
    concurrency: clampConcurrency(input.concurrency),
    timeoutMs: input.timeoutMs ?? EVAL_WAIT_TIMEOUT_MS,
    decisionJudgeModelId: judged ? input.decisionJudgeModelId : undefined,
  }

  const { evalRunId } = await client.createEvalRun({
    setIds: input.setIds,
    total: plan.cells.length,
    plan,
  })
  return { evalRunId, plan }
}

/**
 * Create a sweep and start the workflow that runs it. If the workflow can't be
 * started the run is cancelled, so an error here never leaves a run that looks
 * in progress with nothing behind it.
 */
export async function launchEvalSweep(
  client: WfDataClient,
  input: RunEvalInput,
): Promise<{ evalRunId: string; plan: EvalPlan }> {
  const created = await createEvalSweep(client, input)
  try {
    await client.startEvalSweep({ evalRunId: created.evalRunId })
  } catch (err) {
    await client.cancelEvalRun(created.evalRunId)
    throw err
  }
  return created
}
