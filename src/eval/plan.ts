import type { AgentConfig } from '../server/protocol'

// The sweep manifest — what a run was launched to do, written down.
//
// This module exists because `wf_eval_run` used to record only `setIds` and a
// `total` count. The actual list of cells (sample × model × prompt × attempt)
// lived as a local array inside whichever process called `runEval`, which made
// the run row a counter rather than a plan: nothing outside that process could
// say what remained. A browser tab closing or an MCP request ending stranded
// the sweep with no way for anything else to finish it.
//
// With the plan persisted, "what is left" becomes derivable by anyone holding
// the database — `plan.cells` minus the results already written minus the cells
// currently in flight — so any driver can pick a sweep up where another left
// off. The plan is FROZEN at launch, like a run manifest: re-expanding it later
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

export type EvalPlan = {
  /** Bumped only if the shape changes incompatibly; readers skip what they can't parse. */
  version: 1
  cells: EvalCell[]
  /**
   * Run every cell against this agent config instead of the target's published
   * version — the agent editor grading UNSAVED edits. Frozen into the plan
   * because a resuming driver has no other way to learn it: the draft it was
   * launched from may have been edited again, or saved, since.
   */
  configOverride?: AgentConfig
  concurrency: number
  /** How long one cell's run may take before the driver stops waiting for it. */
  timeoutMs: number
}

/** A cell that has been started and whose run has not yet reached a verdict. */
export type EvalInflightCell = {
  cell: EvalCell
  wfRunId: string
  /** Epoch ms — the deadline for this cell is measured from here. */
  startedAt: number
}

/**
 * Mutable driver state, persisted beside the plan.
 *
 * `inflight` is the part that matters: a cell whose run is already going has no
 * result row yet, so without this it would read as "not started" and the next
 * driver would launch it a second time — two live runs and a doubled model
 * bill for one cell of the matrix.
 */
export type EvalDriveState = {
  version: 1
  inflight: EvalInflightCell[]
  /**
   * Consecutive failed model calls. The circuit breaker survives across ticks
   * because the failure it protects against — a provider that is down — lasts
   * far longer than one tick does.
   */
  consecutiveErrors: number
  /** Latched once the breaker trips; the remaining cells are recorded, not run. */
  providerDown: boolean
}

export const EMPTY_DRIVE_STATE: EvalDriveState = {
  version: 1,
  inflight: [],
  consecutiveErrors: 0,
  providerDown: false,
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
 * Tolerant rather than strict on purpose: this is read by the backstop across
 * every unfinished run in the table, and one malformed blob must mean "skip
 * this run" — not an exception that stops the whole sweep of runs.
 */
export function parseEvalPlan(raw: unknown): EvalPlan | null {
  if (!raw || typeof raw !== 'object') return null
  const p = raw as Partial<EvalPlan>
  if (p.version !== 1 || !Array.isArray(p.cells)) return null
  const cells = p.cells.filter(
    (c): c is EvalCell =>
      !!c && typeof c === 'object' && typeof c.rowId === 'string',
  )
  // An EMPTY cell list is a valid plan, not a missing one. A Goal with no
  // samples used to launch and finalize an immediately-empty report, and that
  // stays true: the first tick finds nothing to do and finalizes. Rejecting it
  // here would turn "this goal has no samples" into "the plan is malformed",
  // which is a worse thing to read and a different thing to fix.
  return {
    version: 1,
    cells,
    configOverride: p.configOverride,
    concurrency: typeof p.concurrency === 'number' ? p.concurrency : 1,
    timeoutMs: typeof p.timeoutMs === 'number' ? p.timeoutMs : 15 * 60_000,
  }
}

/** Parse a `drive_state` column; an unreadable one restarts from empty. */
export function parseEvalDriveState(raw: unknown): EvalDriveState {
  if (!raw || typeof raw !== 'object') return EMPTY_DRIVE_STATE
  const s = raw as Partial<EvalDriveState>
  if (s.version !== 1) return EMPTY_DRIVE_STATE
  const inflight = Array.isArray(s.inflight)
    ? s.inflight.filter(
        (i): i is EvalInflightCell =>
          !!i &&
          typeof i === 'object' &&
          typeof i.wfRunId === 'string' &&
          typeof i.startedAt === 'number' &&
          !!i.cell &&
          typeof i.cell.rowId === 'string',
      )
    : []
  return {
    version: 1,
    inflight,
    consecutiveErrors:
      typeof s.consecutiveErrors === 'number' ? s.consecutiveErrors : 0,
    providerDown: s.providerDown === true,
  }
}
