import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'

import type {
  RetryRunMode,
  WfRunDetail,
  WfRunListInput,
} from '../server/protocol'
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

/**
 * Splice a cached version block back into a response that deliberately omitted
 * it, so consumers see the shape they'd have gotten from a full load and never
 * have to know this optimisation exists.
 *
 * The five fields here are exactly the ones `getRun` derives from the workflow
 * version row — keep this in step with the server's `versionOmitted` branch, or
 * a newly version-derived field silently arrives as its placeholder.
 */
export function mergeVersionBlock(
  next: WfRunDetail,
  prev: WfRunDetail,
): WfRunDetail {
  return {
    ...next,
    graph: prev.graph,
    versionNumber: prev.versionNumber,
    run: {
      ...next.run,
      workflowId: prev.run.workflowId,
      workflowName: prev.run.workflowName,
      versionNumber: prev.run.versionNumber,
    },
  }
}

export function useRun(runId: string | null) {
  const client = useWfClient()
  const qc = useQueryClient()
  return useQuery({
    queryKey: keys.run(runId ?? ''),
    queryFn: async () => {
      const key = keys.run(runId as string)
      const prev = qc.getQueryData<WfRunDetail | null>(key) ?? null
      // The version block — graph, version number, workflow identity — is
      // immutable for a given version id, so once we hold it we tell the server
      // not to read or re-send it. Re-fetching it every 1.5s was a D1 query and,
      // far more expensively, the whole serialized graph over the wire and back
      // through `parseStoredGraph` on every tick, to arrive at the same object.
      //
      // Guarded on `prev.graph` too: a run whose version row is genuinely gone
      // has a null graph, and suppressing the lookup would pin that null forever
      // instead of letting it recover.
      const known = prev?.graph ? prev.workflowVersionId : undefined
      const next = await client.getRun(runId as string, known)
      // `prev` can vanish between the read above and here (cache eviction, a
      // `removeQueries`), so re-check rather than assume — worst case we drop
      // one poll's version block and the next one asks for it in full.
      return next?.versionOmitted && prev ? mergeVersionBlock(next, prev) : next
    },
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
