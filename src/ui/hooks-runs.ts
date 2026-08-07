import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'

import type { RetryRunMode, WfRunListInput } from '../server/protocol'
import { useWfClient } from './context'
import { keys } from './hooks-shared'

export function useRuns(input: WfRunListInput = {}) {
  const client = useWfClient()
  return useQuery({
    queryKey: keys.runs(input),
    queryFn: () => client.listRuns(input),
    // Keep the prior page visible while the next page/filter loads — avoids the
    // table flashing empty on every keystroke or page change.
    placeholderData: keepPreviousData,
  })
}

export function useRunTriggerKinds() {
  const client = useWfClient()
  return useQuery({
    queryKey: keys.runTriggerKinds,
    queryFn: () => client.listRunTriggerKinds(),
  })
}

export function useRun(runId: string | null) {
  const client = useWfClient()
  return useQuery({
    queryKey: keys.run(runId ?? ''),
    queryFn: () => client.getRun(runId as string),
    enabled: !!runId,
    // Poll while the run is live so the graph glow, node statuses, and the Logs
    // feed fill in as it executes, then stop once it settles. Mirrors
    // `useEvalRun`. 1.5s keeps it feeling live without hammering D1.
    // `done` keeps polling: the answer has landed but background arms are still
    // executing and still writing steps, and the viewer should show them fill
    // in rather than freeze on the moment the Output was reached.
    refetchInterval: (query) => {
      const status = query.state.data?.run.status
      return status === 'queued' || status === 'running' || status === 'done'
        ? 1500
        : false
    },
  })
}

// Wipe ALL run history — runs, steps, logs, and the eval results/runs that
// grade them. Every run-derived query is invalidated (and the per-run caches
// dropped outright, since those runs no longer exist).
export function useDeleteAllRuns() {
  const client = useWfClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => client.deleteAllRuns(),
    onSuccess: () => {
      qc.removeQueries({ queryKey: ['wf', 'run'] })
      return Promise.all([
        qc.invalidateQueries({ queryKey: keys.runsAll }),
        qc.invalidateQueries({ queryKey: keys.runTriggerKinds }),
        qc.invalidateQueries({ queryKey: keys.evalRunsAll }),
        qc.invalidateQueries({ queryKey: keys.feedbackAll }),
      ])
    },
  })
}

// Re-dispatch a finished run. On success the runs list + this run are
// invalidated (its status may flip) and the new run id is returned so the
// caller can navigate to it.
export function useRetryRun() {
  const client = useWfClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { runId: string; mode: RetryRunMode }) =>
      client.retryRun(input),
    onSuccess: (_r, input) => {
      void qc.invalidateQueries({ queryKey: keys.run(input.runId) })
      void qc.invalidateQueries({ queryKey: keys.runsAll })
    },
  })
}
