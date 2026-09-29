import type { ModelBudget } from '../model-budget'
import type { StreamSink } from '../stream-sink'

// Two things a generation needs before it makes a single call: a clock, and an
// answer to "is this failure worth retrying?".
//
// They belong together because the guard PRODUCES one of the two fatal cases.
// `armTotalBudget` owns the clock, `runGuarded` classifies whatever comes back,
// and the markers below are how that classification crosses the `step.do`
// boundary — where Cloudflare rebuilds the error object and everything but the
// message and stack is lost. The dispatch reads them via `isFatalAgentError` to
// decide between retrying the node and failing the run.

/** The armed total-budget guard: the signal to pass the provider, plus the two
 * questions the catch and the `finally` ask of it. */
export type BudgetGuard = {
  signal?: AbortSignal
  overran: () => boolean
  disarm: () => void
}

/**
 * Arm the total-budget guard for one generation.
 *
 * We use our OWN controller rather than the AI SDK's `timeout.totalMs` so the
 * catch can tell an overrun from a stall by identity (`signal.aborted`) instead
 * of matching a `DOMException` message. That distinction drives the two
 * behaviors: a stalled round-trip is transient and the node is retried, while a
 * node that burns its entire budget is failed outright — retrying it would just
 * repeat the same work and hit the same wall.
 */
export function armTotalBudget(budget: ModelBudget | undefined): BudgetGuard {
  if (!budget) return { overran: () => false, disarm: () => {} }
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort(
      new DOMException(
        `Agent exceeded its total budget of ${Math.round(budget.totalMs / 1000)}s`,
        'TimeoutError',
      ),
    )
  }, budget.totalMs)
  return {
    signal: controller.signal,
    overran: () => controller.signal.aborted,
    disarm: () => {
      clearTimeout(timer)
    },
  }
}

/** Marks a total-budget overrun so the dispatch can fail the run rather than
 * retry it. Set on the error as it leaves this module. */
export const TOTAL_BUDGET_OVERRUN = 'wfTotalBudgetOverrun'

/** Marks an agent that finished its loop without writing any answer text. Like
 * a budget overrun, retrying it just repeats the same expensive dead end. */
export const AGENT_NO_OUTPUT = 'wfAgentNoOutput'

export function markOverrun(err: unknown): unknown {
  if (err != null && typeof err === 'object') {
    ;(err as Record<string, unknown>)[TOTAL_BUDGET_OVERRUN] = true
  }
  return err
}

export function markNoOutput(err: Error): Error {
  ;(err as unknown as Record<string, unknown>)[AGENT_NO_OUTPUT] = true
  return err
}

/** True for an error the engine should fail outright instead of retrying — the
 * second attempt would deterministically reach the same wall. */
export function isFatalAgentError(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false
  const e = err as Record<string, unknown>
  return e[TOTAL_BUDGET_OVERRUN] === true || e[AGENT_NO_OUTPUT] === true
}

// A model call is the longest thing a run does with nothing to say about
// itself: `generateText` is non-streaming, so its per-step callback can't fire
// until a whole round-trip (thinking included) lands — minutes, on a reasoning
// model. Bookending the call gives the feed a heartbeat at the two moments that
// actually exist without streaming: dispatch and outcome. `info` is the dev
// feed; `progress` (the user-facing level) is deliberately untouched here.
export function logModelCallStart(
  sink: StreamSink | undefined,
  modelId: string,
  detail: Record<string, unknown>,
): number {
  void sink?.log?.({
    level: 'info',
    message: `→ ${modelId}`,
    meta: detail,
  })
  return Date.now()
}

export function logModelCallEnd(
  sink: StreamSink | undefined,
  modelId: string,
  startedAt: number,
  detail: Record<string, unknown>,
): void {
  void sink?.log?.({
    level: 'info',
    message: `← ${modelId} (${Math.round((Date.now() - startedAt) / 1000)}s)`,
    meta: detail,
  })
}

/**
 * Run one generation under its budget guard, logging and classifying a failure.
 *
 * The log line matters as much as the classification: a failed model call is
 * otherwise completely silent (`onStepFinish` never fires on the error path),
 * which is what made a stall indistinguishable from a hung run. Tagging a total
 * overrun here — while the error object is still ours, before it crosses the
 * `step.do` boundary and gets reconstructed — is what lets the dispatch decide
 * between retrying the node and failing the run.
 */
export async function runGuarded<T>(
  sink: StreamSink | undefined,
  modelId: string,
  startedAt: number,
  guard: Pick<BudgetGuard, 'overran' | 'disarm'>,
  body: () => Promise<T>,
): Promise<T> {
  try {
    return await body()
  } catch (err) {
    const elapsed = Math.round((Date.now() - startedAt) / 1000)
    const overran = guard.overran()
    const reason = overran
      ? 'exceeded its total budget'
      : isTimeoutError(err)
        ? 'stalled'
        : 'failed'
    void sink?.log?.({
      level: 'error',
      message: `✕ ${modelId} ${reason} after ${elapsed}s`,
      meta: { elapsedSeconds: elapsed, totalBudgetOverrun: overran },
    })
    throw overran ? markOverrun(err) : err
  } finally {
    guard.disarm()
  }
}

/** A watchdog firing — ours (total budget) or the AI SDK's (per round-trip,
 * per tool). Both surface as a `TimeoutError`-named DOMException. */
export function isTimeoutError(err: unknown): boolean {
  return (
    err != null &&
    typeof err === 'object' &&
    'name' in err &&
    (err as { name?: unknown }).name === 'TimeoutError'
  )
}
