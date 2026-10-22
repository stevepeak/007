import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'

import { hasJudgeChecks } from '../engine/eval-schema'
import { runEval, type RunEvalInput } from '../eval/run-eval'
import type {
  CheckTree,
  EvalSampleInput,
  EvalTools,
  WfDataClient,
  WfEvalTargetKind,
} from '../server/protocol'

import { useWfClient } from './context'
import { keys, useWfMutation } from './hooks-shared'

// --- Evals -----------------------------------------------------------------

/** True while an eval run's counters are still filling in. */
export function isEvalRunInFlight(run: { status: string }): boolean {
  return run.status === 'queued' || run.status === 'running'
}

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

/**
 * Whether these Goals' Samples carry a judge check — whether a launch has to
 * name the run's judge. Reads each Goal through the same query `useEvalSet` caches.
 */
export function useEvalNeedsJudge(setIds: string[]) {
  const client = useWfClient()
  const sets = useQueries({
    queries: setIds.map((setId) => ({
      queryKey: keys.evalSet(setId),
      queryFn: () => client.getEvalSet(setId),
    })),
  })
  return {
    loading: sets.some((q) => q.isLoading),
    needed: hasJudgeChecks(
      sets.flatMap((q) => (q.data?.rows ?? []).map((row) => row.checks)),
    ),
  }
}

export function useEvalRuns(limit?: number) {
  const client = useWfClient()
  return useQuery({
    queryKey: keys.evalRuns(limit),
    queryFn: () => client.listEvalRuns({ limit }),
    // Poll only while some run is still executing, so its row settles live.
    refetchInterval: (query) => {
      return query.state.data?.some(isEvalRunInFlight) ? 3000 : false
    },
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
      const run = query.state.data?.run
      return run && isEvalRunInFlight(run) ? 2000 : false
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
        input?: EvalSampleInput
        tools?: EvalTools
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

// The orchestrator itself lives in `../eval/run-eval` — it is framework-free and
// shared with `wf-mcp`, which cannot import this file (react-query). Re-exported
// here so UI callers keep importing eval things from the eval hooks module.
export {
  DEFAULT_EVAL_CONCURRENCY,
  EVAL_CONCURRENCY_CHOICES,
  type EvalMatrixModel,
  type EvalMatrixPrompt,
  runEval,
  type RunEvalInput,
} from '../eval/run-eval'


// Kicks off a full client-driven eval run. On success the eval-runs list is
// invalidated and the new `evalRunId` is returned so the caller can navigate to
// the report.
/** The check editor's "Try this check": one judge check against one answer. */
export function usePreviewJudgeCheck() {
  return useWfMutation(
    (client, input: Parameters<WfDataClient['previewJudgeCheck']>[0]) => {
      return client.previewJudgeCheck(input)
    },
  )
}

export function useRunEval() {
  const client = useWfClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: RunEvalInput) => runEval(client, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.evalRunsAll }),
  })
}
