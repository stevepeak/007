import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'

import { runEval, type RunEvalInput } from '../eval/run-eval'
import type {
  CheckTree,
  EvalSampleInput,
  EvalTools,
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
export function useRunEval() {
  const client = useWfClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: RunEvalInput) => runEval(client, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.evalRunsAll }),
  })
}
