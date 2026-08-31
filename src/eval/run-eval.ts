import type { AgentConfig, WfDataClient } from '../server/protocol'

// Running a Goal — the orchestrator, with no framework in it.
//
// This is client-driven on purpose: the caller creates the umbrella run, then
// for each sample starts a real run, waits for it to reach a terminal status,
// and grades it — concurrency-capped. A later durable orchestrator can replace
// it without touching the protocol.
//
// It lives here rather than beside the React hook that used to own it because
// it has two callers that share nothing else: the eval report's launch dialog,
// and the `wf-mcp` server, which runs in a bun process with no DOM and cannot
// import a module that pulls in react-query. Everything it needs is a
// `WfDataClient` and a way to sleep, so nothing about it was ever browser code.
//
// The orchestration lives in the CALLER's process, which is the property that
// matters most to a new caller: if that process exits mid-sweep, the remaining
// cells are never launched and the umbrella run is never finalized — it sits at
// `running` forever. A browser tab closing and an MCP session ending are the
// same failure.

// Errors on one sample don't abort the batch; the run is finalized over whatever
// results landed — and EVERY cell lands something, pass, fail, or error, so the
// run's totals always match what was requested.
//
// A run has TWO success states: `done` (the Output was reached — the answer is
// final and persisted — while branches that don't feed it are still draining)
// and `completed` (nothing left to run). A waiter after an ANSWER must accept
// both; only a waiter for the graph to fall quiet holds out for `completed`.
const RUN_TERMINAL = new Set(['done', 'completed', 'failed', 'cancelled'])

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
const EVAL_POLL_INTERVAL_MS = 3_000

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

/**
 * Consecutive failed model calls before the run stops launching new tests. Once
 * the provider has refused three in a row, the rest are near-certain to fail
 * too — continuing only burns time and hammers a service that is already down.
 * Client-side timeouts do NOT count toward this: they say nothing about the
 * provider's health.
 */
const MAX_CONSECUTIVE_CELL_ERRORS = 3

function clampConcurrency (n?: number) {
  return Math.max(1, Math.min(n ?? DEFAULT_EVAL_CONCURRENCY, MAX_EVAL_CONCURRENCY))
}

/**
 * What became of one cell's run. Returning the outcome rather than throwing on
 * the unhappy paths is what lets every one of them be recorded — a thrown
 * timeout used to be indistinguishable from a network blip and got swallowed.
 */
type WaitOutcome =
  | { kind: 'terminal'; status: string; error: string | null }
  | { kind: 'timeout' }

async function waitForRun(
  client: WfDataClient,
  wfRunId: string,
  opts: { pollIntervalMs: number; timeoutMs: number },
): Promise<WaitOutcome> {
  const deadline = Date.now() + opts.timeoutMs
  for (;;) {
    // `getRunStatus`, not `getRun`: this loop reads exactly two fields, and at
    // the top concurrency it runs once per matrix cell every few seconds for up
    // to fifteen minutes. On `getRun` that was thousands of full run-inspector
    // loads — every step's tool IO, the whole log feed, and (with no version
    // hint passed) the serialized graph on every single tick.
    const status = await client.getRunStatus(wfRunId)
    if (status && RUN_TERMINAL.has(status.status)) {
      return {
        kind: 'terminal',
        status: status.status,
        error: status.error,
      }
    }
    if (Date.now() > deadline) return { kind: 'timeout' }
    await new Promise((r) => setTimeout(r, opts.pollIntervalMs))
  }
}

async function pool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0
  const runners = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length || 1)) },
    async () => {
      for (;;) {
        const i = cursor++
        if (i >= items.length) return
        await worker(items[i])
      }
    },
  )
  await Promise.all(runners)
}

// One prompt variation in the matrix. `body` undefined = the agent's saved
// prompt (the always-present baseline); a string overrides it. `label` names the
// column in the report ("Agent's saved prompt", "Test prompt 1", …).
export type EvalMatrixPrompt = { label: string; body?: string }
// One model column. `attempts` is best-of-N — each attempt is a separate run of
// every sample × prompt, so a cell aggregates all its attempts.
export type EvalMatrixModel = { modelId: string; attempts: number }

export type RunEvalInput = {
  setIds: string[]
  /**
   * Run every cell against this agent config instead of the target's published
   * version — the agent editor testing its goals against UNSAVED edits. Nothing
   * is persisted; the config rides along on each cell's `startEvalRun`. The
   * matrix's `modelId` / `promptBody` still layer on top of it, so a draft can
   * be swept across models and alternate prompts exactly like a published agent.
   * Omitted → the published version (every other caller).
   */
  configOverride?: AgentConfig
  /**
   * The model × prompt sweep. Omitted → a single plain run per sample on the
   * target's own saved model + prompt (preserves the pre-matrix behavior). When
   * present, every sample is run for each (model × prompt × attempt) cell.
   */
  matrix?: { models: EvalMatrixModel[]; prompts: EvalMatrixPrompt[] }
  concurrency?: number
  pollIntervalMs?: number
  timeoutMs?: number
  onProgress?: (p: { done: number; total: number }) => void
  /**
   * Fired the moment the umbrella run row exists (before any cell runs), so the
   * caller can close its dialog and navigate to the live report while the matrix
   * keeps fanning out in the background.
   */
  onStart?: (evalRunId: string) => void
}

// The per-run unit of work: a sample crossed with one matrix cell. `modelId` /
// `promptBody` are the overrides handed to `startEvalRun` (both undefined on the
// plain path); `promptLabel` / `attempt` are stamped on the graded result so the
// report can group by cell.
type EvalJob = {
  rowId: string
  modelId?: string
  promptLabel?: string
  promptBody?: string
  attempt?: number
}

export async function runEval(
  client: WfDataClient,
  input: RunEvalInput,
): Promise<{ evalRunId: string }> {
  const sets = await Promise.all(
    input.setIds.map((id) => client.getEvalSet(id)),
  )
  const rowIds = sets
    .filter((s): s is NonNullable<typeof s> => !!s)
    .flatMap((s) => s.rows.map((row) => row.id))

  // Expand the matrix into per-run cells. Absent matrix → one plain cell (no
  // overrides), so `jobs` stays one-per-sample exactly as before.
  const cells: Omit<EvalJob, 'rowId'>[] = input.matrix
    ? input.matrix.models.flatMap((m) =>
        input.matrix!.prompts.flatMap((p) =>
          Array.from({ length: Math.max(1, m.attempts) }, (_, attempt) => ({
            modelId: m.modelId,
            promptLabel: p.label,
            promptBody: p.body,
            attempt,
          })),
        ),
      )
    : [{}]
  const jobs: EvalJob[] = rowIds.flatMap((rowId) =>
    cells.map((cell) => ({ rowId, ...cell })),
  )

  const { evalRunId } = await client.createEvalRun({
    setIds: input.setIds,
    total: jobs.length,
  })
  // Run row exists — let the caller navigate to the live report now. The fan-out
  // below keeps running in this (still-pending) mutation; the report polls it.
  input.onStart?.(evalRunId)

  const wait = {
    pollIntervalMs: input.pollIntervalMs ?? EVAL_POLL_INTERVAL_MS,
    timeoutMs: input.timeoutMs ?? EVAL_WAIT_TIMEOUT_MS,
  }
  let done = 0
  // Circuit breaker state, shared across the pool's workers.
  let consecutiveErrors = 0
  let providerDown = false

  await pool(jobs, clampConcurrency(input.concurrency), async (job) => {
    const cell = {
      modelId: job.modelId,
      promptLabel: job.promptLabel,
      promptBody: job.promptBody,
      attempt: job.attempt,
    }
    // Every exit from this worker goes through here. A cell with no row does
    // not merely lose its own verdict — `finalizeEvalRun` rolls up the rows
    // that exist, so a missing row silently shrinks the run's `total` and the
    // report reads as if the cell was never requested.
    const record = (error: string, wfRunId?: string) =>
      client
        .recordEvalFailure({ evalRunId, rowId: job.rowId, wfRunId, error, ...cell })
        .catch((e: unknown) => {
          console.error(`[wf] eval failure not recorded for ${job.rowId}:`, e)
        })

    let wfRunId: string | undefined
    try {
      if (providerDown) {
        await record(
          `Skipped — the model provider failed ${MAX_CONSECUTIVE_CELL_ERRORS} calls in a row, so the rest of this run was not launched.`,
        )
        return
      }

      ;({ wfRunId } = await client.startEvalRun({
        evalRunId,
        rowId: job.rowId,
        modelId: job.modelId,
        promptBody: job.promptBody,
        config: input.configOverride,
      }))
      const outcome = await waitForRun(client, wfRunId, wait)

      if (outcome.kind === 'timeout') {
        // Not a provider verdict — the run may still be going — so this does
        // NOT trip the breaker.
        await record(
          `The run was still executing after ${Math.round(wait.timeoutMs / 60_000)} minutes; the report stopped waiting for it.`,
          wfRunId,
        )
        return
      }

      if (outcome.status !== 'done' && outcome.status !== 'completed') {
        // A failed or cancelled run has no gradeable output. Grading it anyway
        // would produce a `fail` verdict that blames the Sample for what was an
        // infrastructure failure — the other half of "pass rate 0, no idea why".
        consecutiveErrors += 1
        if (consecutiveErrors >= MAX_CONSECUTIVE_CELL_ERRORS) providerDown = true
        await record(
          outcome.error ?? `The run ended as "${outcome.status}".`,
          wfRunId,
        )
        return
      }

      await client.gradeEvalResult({
        evalRunId,
        rowId: job.rowId,
        wfRunId,
        ...cell,
      })
      consecutiveErrors = 0
    } catch (err) {
      // startEvalRun threw, the network dropped, grading blew up. Never
      // swallow: the run is finalized over the rows that exist, so silence here
      // is indistinguishable from success that produced nothing.
      await record(err instanceof Error ? err.message : String(err), wfRunId)
    } finally {
      done += 1
      input.onProgress?.({ done, total: jobs.length })
    }
  })

  await client.finalizeEvalRun({ evalRunId })
  return { evalRunId }
}
