import type { AnyAgentConfig } from '../engine/decision-agent-schema'

// The sweep manifest — what a run was launched to do, written down.
//
// `wf_eval_run` records the list of cells (sample × model × prompt × attempt) so
// the run row is a plan rather than a counter. No process has to stay alive to
// remember what remains.
//
// With the plan persisted, "what is left" becomes derivable by anyone holding
// the database — `plan.cells` minus the results already written — so a restarted
// sweep picks up where the last one left off. The plan is FROZEN at launch, like a run manifest: re-expanding it later
// against the live sets would silently change what a half-finished run is
// measuring if a Sample were added or archived mid-sweep.

/**
 * One unit of work: a Sample crossed with one matrix cell.
 *
 * `modelId` / `promptBody` are the overrides handed to `startEvalRun` (both
 * undefined on the plain, non-matrix path); `promptLabel` / `attempt` are
 * stamped on the graded result so the report can group by cell.
 */
export type EvalCell = {
  rowId: string
  modelId?: string
  promptLabel?: string
  promptBody?: string
  attempt?: number
}

/** One prompt variation. `body` undefined = the agent's own saved prompt. */
export type EvalMatrixPrompt = { label: string; body?: string }
/** One model column. `attempts` is best-of-N — each is a separate run. */
export type EvalMatrixModel = { modelId: string; attempts: number }
export type EvalMatrix = {
  models: EvalMatrixModel[]
  prompts: EvalMatrixPrompt[]
}

/**
 * How a cell of this sweep is executed — the one structural difference between
 * the two agent kinds, frozen at launch alongside everything else.
 *
 * `'run'` is every sweep against a generation agent: the cell STARTS a `wf_run` and later ticks poll it to a
 * terminal status. `'decision'` is a decision-agent target, which has no graph
 * and no run — one provider call, settled inside the tick that started it.
 *
 * It lives on the plan rather than being re-derived from the Goal's target on
 * every tick for the same reason the cells do: re-reading the live target would
 * let a half-finished sweep change how it executes mid-flight.
 */
export type EvalCellMode = 'run' | 'decision'

export type EvalPlan = {
  /** Bumped only if the shape changes incompatibly; readers skip what they can't parse. */
  version: 1
  cells: EvalCell[]
  /** See {@link EvalCellMode}. Absent on every plan written before ART-238. */
  mode?: EvalCellMode
  /**
   * Run every cell against this agent config instead of the target's published
   * version — the agent editor grading UNSAVED edits. Frozen into the plan
   * because a restarted sweep has no other way to learn it: the draft it was
   * launched from may have been edited again, or saved, since. Of whichever
   * shape the target agent's kind declares.
   */
  configOverride?: AnyAgentConfig
  concurrency: number
  /** How long one cell's run may take before the driver stops waiting for it. */
  timeoutMs: number
  /**
   * The chat model that graded the sweep's judge checks, on a plan frozen while
   * judges were chat models. Read only to label those runs' reports; nothing
   * grades with it any more.
   */
  judgeModelId?: string
  /**
   * The decision model every judge check in this sweep is graded by. Chosen at
   * launch and required whenever the sweep's Samples carry a judge check;
   * checks cannot name their own.
   *
   * Frozen into the plan for the same reason `configOverride` is: a resuming
   * driver has no other way to learn it, and half a matrix graded by one judge
   * and half by another is a report that cannot be compared with itself. Note
   * this is the JUDGE, not the matrix's per-cell `modelId` — that one is the
   * model the target runs on.
   */
  decisionJudgeModelId?: string
}

/** What a sweep reads back from storage. */
export type EvalRunDrive = {
  evalRunId: string
  status: string
  /** Null for runs created before plans were persisted — those can't run. */
  plan: EvalPlan | null
  /** `evalCellKey` of every cell that already has a result row. */
  settledKeys: string[]
}

/**
 * Stable identity for a cell, used to match plan entries against the results
 * already written.
 *
 * Deliberately excludes `promptBody`: `promptLabel` is what the report groups
 * by and what `wf_eval_result` stores as the cell's identity, and the body is
 * derived from the label within a single plan. Including it would also make the
 * key enormous for a long system prompt.
 *
 * `\u0000` separates the parts so a label containing the separator can't forge
 * another cell's key.
 */
export function evalCellKey(cell: {
  rowId: string
  modelId?: string | null
  promptLabel?: string | null
  attempt?: number | null
}): string {
  return [
    cell.rowId,
    cell.modelId ?? '',
    cell.promptLabel ?? '',
    cell.attempt == null ? '' : String(cell.attempt),
  ].join('\u0000')
}

/**
 * Expand sample ids × the matrix into the concrete cell list.
 *
 * No matrix → one plain cell per sample (the target's own saved model and
 * prompt), which is the pre-matrix behavior and still what most runs are.
 */
export function expandEvalCells(
  rowIds: string[],
  matrix?: EvalMatrix,
): EvalCell[] {
  const cells: Omit<EvalCell, 'rowId'>[] = matrix
    ? matrix.models.flatMap((m) => {
        return matrix.prompts.flatMap((p) => {
          return Array.from(
            { length: Math.max(1, m.attempts) },
            (_, attempt) => ({
              modelId: m.modelId,
              promptLabel: p.label,
              promptBody: p.body,
              attempt,
            }),
          )
        })
      })
    : [{}]
  return rowIds.flatMap((rowId) => cells.map((cell) => ({ rowId, ...cell })))
}

/**
 * Parse a `plan` column back into a plan, or null when it is absent or
 * unreadable.
 *
 * Tolerant rather than strict on purpose: a malformed blob must mean "this run
 * has no plan", which the caller can say plainly, not a parse exception.
 */
export function parseEvalPlan(raw: unknown): EvalPlan | null {
  if (!raw || typeof raw !== 'object') return null
  const p = raw as Partial<EvalPlan>
  if (p.version !== 1 || !Array.isArray(p.cells)) return null
  const cells = p.cells.filter(
    (c): c is EvalCell => { return !!c && typeof c === 'object' && typeof c.rowId === 'string' },
  )
  // An EMPTY cell list is a valid plan, not a missing one. A Goal with no
  // samples used to launch and finalize an immediately-empty report, and that
  // stays true: the first tick finds nothing to do and finalizes. Rejecting it
  // here would turn "this goal has no samples" into "the plan is malformed",
  // which is a worse thing to read and a different thing to fix.
  return {
    version: 1,
    cells,
    // Absent on every pre-ART-238 plan, which is exactly what `'run'` means —
    // so no migration is needed.
    mode: p.mode === 'decision' ? 'decision' : 'run',
    configOverride: p.configOverride,
    concurrency: typeof p.concurrency === 'number' ? p.concurrency : 1,
    timeoutMs: typeof p.timeoutMs === 'number' ? p.timeoutMs : 15 * 60_000,
    // Absent on every plan written before judges could be pinned, which is the
    // same as "use the host default" — so no migration is needed.
    judgeModelId:
      typeof p.judgeModelId === 'string' && p.judgeModelId.length > 0
        ? p.judgeModelId
        : undefined,
    decisionJudgeModelId:
      typeof p.decisionJudgeModelId === 'string' &&
      p.decisionJudgeModelId.length > 0
        ? p.decisionJudgeModelId
        : undefined,
  }
}

/**
 * Which execution mode a sweep over these Goals runs in.
 *
 * A sweep is one plan with one mode, so a set of Goals that mixes a decision
 * agent with anything else has no answer and is refused. That is not a
 * limitation worth engineering around: the two produce incomparable reports —
 * one has runs, steps, tool traces and a cost per cell, the other has a
 * verdict and a matrix — and running them together would put both in one table
 * with half the columns empty.
 *
 * Pure, and takes the kinds as a map rather than a client, so the caller
 * decides how to fetch them (the UI already holds `listAgents`; MCP reads it
 * once for the model gate).
 */
export function resolveEvalCellMode(
  targets: readonly { targetId: string }[],
  agentKinds: ReadonlyMap<string, 'generation' | 'decision'>,
): { mode: EvalCellMode } | { error: string } {
  const modes = new Set(
    targets.map((t): EvalCellMode => {
      return agentKinds.get(t.targetId) === 'decision' ? 'decision' : 'run'
    }),
  )
  if (modes.size > 1) {
    return {
      error:
        'One run cannot cover both a decision agent and a generation agent — they produce incomparable reports. Run those goals separately.',
    }
  }
  return { mode: modes.has('decision') ? 'decision' : 'run' }
}
