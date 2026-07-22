import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'

import type {
  CheckTree,
  EvalFixtures,
  EvalInitialCondition,
  WfDataClient,
  WfEvalTargetKind,
} from '../server/protocol'
import { useWfClient } from './context'
import { keys, useWfMutation } from './hooks-shared'

// --- Evals -----------------------------------------------------------------

export function useEvalSets(includeArchived?: boolean) {
  const client = useWfClient()
  return useQuery({
    queryKey: keys.evalSets(includeArchived),
    queryFn: () => client.listEvalSets({ includeArchived }),
  })
}

export function useEvalSet(setId: string | null) {
  const client = useWfClient()
  return useQuery({
    queryKey: keys.evalSet(setId ?? ''),
    queryFn: () => client.getEvalSet(setId as string),
    enabled: !!setId,
  })
}

export function useEvalRuns(limit?: number) {
  const client = useWfClient()
  return useQuery({
    queryKey: keys.evalRuns(limit),
    queryFn: () => client.listEvalRuns({ limit }),
  })
}

// Poll while the run is still executing so the report fills in live, then stop.
export function useEvalRun(evalRunId: string | null) {
  const client = useWfClient()
  return useQuery({
    queryKey: keys.evalRun(evalRunId ?? ''),
    queryFn: () => client.getEvalRun(evalRunId as string),
    enabled: !!evalRunId,
    refetchInterval: (query) => {
      const status = query.state.data?.run.status
      return status === 'queued' || status === 'running' ? 2000 : false
    },
  })
}

export function useCreateEvalSet() {
  return useWfMutation(
    (
      client,
      input: {
        name: string
        description?: string
        targetKind: WfEvalTargetKind
        targetId: string
        targetVersion?: number | null
        triggerKind: string
      },
    ) => client.createEvalSet(input),
    () => [keys.evalSetsAll],
  )
}

export function useUpdateEvalSet() {
  const client = useWfClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: {
      setId: string
      name?: string
      description?: string | null
      targetKind?: WfEvalTargetKind
      targetId?: string
      targetVersion?: number | null
      triggerKind?: string
      archived?: boolean
    }) => client.updateEvalSet(input),
    onSuccess: (_r, input) => {
      void qc.invalidateQueries({ queryKey: keys.evalSetsAll })
      void qc.invalidateQueries({ queryKey: keys.evalSet(input.setId) })
    },
  })
}

export function useDeleteEvalSet() {
  return useWfMutation(
    (client, setId: string) => client.deleteEvalSet(setId),
    () => [keys.evalSetsAll],
  )
}

export function useUpsertEvalRow() {
  return useWfMutation(
    (
      client,
      input: {
        id?: string
        setId: string
        name: string
        description?: string | null
        initialCondition?: EvalInitialCondition
        fixtures?: EvalFixtures
        checks?: CheckTree
        sortOrder?: number
      },
    ) => client.upsertEvalRow(input),
    (input) => [keys.evalSet(input.setId)],
  )
}

export function useDeleteEvalRow(setId: string) {
  return useWfMutation(
    (client, rowId: string) => client.deleteEvalRow(rowId),
    () => [keys.evalSet(setId)],
  )
}

// Client-driven eval orchestration (Phase 5 v1): create the run, then for each
// sample start a real (simulated) run, wait for it to finish, and grade it —
// concurrency-capped. A later durable orchestrator can replace this without
// touching the protocol. Errors on one sample don't abort the batch; the run is
// finalized over whatever results landed.
const RUN_TERMINAL = new Set(['completed', 'failed', 'cancelled'])

async function waitForRun(
  client: WfDataClient,
  wfRunId: string,
  opts: { pollIntervalMs: number; timeoutMs: number },
): Promise<void> {
  const deadline = Date.now() + opts.timeoutMs
  for (;;) {
    const detail = await client.getRun(wfRunId)
    if (detail && RUN_TERMINAL.has(detail.run.status)) return
    if (Date.now() > deadline) {
      throw new Error(`Eval run ${wfRunId} did not finish within the timeout.`)
    }
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
        await worker(items[i] as T)
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
   * The model × prompt sweep. Omitted → a single plain run per sample on the
   * target's own saved model + prompt (preserves the pre-matrix behavior). When
   * present, every sample is run for each (model × prompt × attempt) cell.
   */
  matrix?: { models: EvalMatrixModel[]; prompts: EvalMatrixPrompt[] }
  concurrency?: number
  pollIntervalMs?: number
  timeoutMs?: number
  onProgress?: (p: { done: number; total: number }) => void
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

  const wait = {
    pollIntervalMs: input.pollIntervalMs ?? 1500,
    timeoutMs: input.timeoutMs ?? 120000,
  }
  let done = 0
  await pool(jobs, input.concurrency ?? 4, async (job) => {
    try {
      const { wfRunId } = await client.startEvalRun({
        evalRunId,
        rowId: job.rowId,
        modelId: job.modelId,
        promptBody: job.promptBody,
      })
      await waitForRun(client, wfRunId, wait)
      await client.gradeEvalResult({
        evalRunId,
        rowId: job.rowId,
        wfRunId,
        modelId: job.modelId,
        promptLabel: job.promptLabel,
        promptBody: job.promptBody,
        attempt: job.attempt,
      })
    } catch (err) {
      // Keep the batch going — a single cell's failure is captured by the
      // absence of its result and the run still finalizes.
      console.error(`[wf] eval sample ${job.rowId} failed:`, err)
    } finally {
      done += 1
      input.onProgress?.({ done, total: jobs.length })
    }
  })

  await client.finalizeEvalRun({ evalRunId })
  return { evalRunId }
}

// Kicks off a full client-driven eval run. On success the eval-runs list is
// invalidated and the new `evalRunId` is returned so the caller can navigate to
// the report.
export function useRunEval() {
  const client = useWfClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: RunEvalInput) => runEval(client, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.evalRunsAll }),
  })
}
