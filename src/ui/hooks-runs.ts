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
  WfRunStepDTO,
} from '../server/protocol'

import { useWfClient } from './context'
import { keys, useWfMutation } from './hooks-shared'

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

/**
 * The child runs one run spawned — a durable iteration's items, or a
 * workflow-call node's callee.
 *
 * `enabled` is how both callers pay only for what they show: the runs explorer
 * turns it on for the row someone expands, and the run viewer turns it on only
 * for a run that actually has children. Polls on the same 1.5s cadence as
 * `useRun` while the PARENT is live, because that is when items are appearing
 * and changing state — a child's own status is not something this list can
 * watch for.
 */
export function useChildRuns(
  parentRunId: string | null,
  opts: { enabled?: boolean; live?: boolean } = {},
) {
  const client = useWfClient()
  const { enabled = true, live = false } = opts
  return useQuery({
    queryKey: keys.runChildren(parentRunId ?? ''),
    queryFn: () => client.listChildRuns({ parentRunId: parentRunId as string }),
    enabled: !!parentRunId && enabled,
    refetchInterval: live ? 1500 : false,
    // Keep the last set on screen through a refetch, so an expanded fan-out
    // doesn't blink empty every tick.
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

/**
 * Step statuses that can never change again. `failed` is deliberately absent:
 * a resume re-runs a failed node, and the row it upserts carries the same
 * cursor — treating it as settled would pin the failure on screen forever.
 */
const SETTLED_STEP_STATUSES = new Set(['completed', 'skipped'])

/**
 * The watermark to ask the server to read above: the highest cursor such that
 * every step at or below it is held AND settled.
 *
 * The "held" half is what makes the scan from the bottom, rather than "the
 * highest settled cursor anywhere". A full load returns every step, and each
 * incremental load returns everything above the last watermark, so by induction
 * the client always holds an unbroken prefix — but only up to the first
 * still-moving step. Stopping there is what keeps an in-flight step, and every
 * step recorded after it, arriving in full on every tick.
 */
export function settledStepCursor(
  steps: readonly WfRunStepDTO[],
): number | undefined {
  let watermark: number | undefined
  for (const s of [...steps].sort((a, b) => a.cursor - b.cursor)) {
    if (!SETTLED_STEP_STATUSES.has(s.status)) break
    watermark = s.cursor
  }
  return watermark
}

/**
 * Splice an incremental steps read into the set already held, so consumers see
 * the shape a full load would have given them. The sibling of
 * {@link mergeVersionBlock}, and the reason the three step consumers
 * (`buildActivityTree`, the iteration item picker, `create-sample-from-run`)
 * need no accumulator of their own — every one of them still receives the whole
 * run's steps.
 *
 * Keyed on `cursor`, which is stable across a step's `running` → terminal
 * transition, so a re-sent step replaces its earlier state rather than doubling
 * it. Ordering stays `sequence`-primary (what consumers have always seen), with
 * `cursor` breaking the ties that an iteration's per-item steps create.
 */
export function mergeStepBlock(
  next: WfRunDetail,
  prev: WfRunDetail,
): WfRunDetail {
  const byCursor = new Map(prev.steps.map((s) => [s.cursor, s]))
  for (const s of next.steps) byCursor.set(s.cursor, s)
  return {
    ...next,
    steps: [...byCursor.values()].sort(
      (a, b) => a.sequence - b.sequence || a.cursor - b.cursor,
    ),
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
      // Both hints are derived from `prev` and both are spliced back against
      // that SAME snapshot below. `prev` is a local const, so a cache eviction
      // racing this fetch can't leave us merging a delta into nothing — the
      // only way to ask for a partial response is to be holding the full one.
      const next = await client.getRun(runId as string, {
        knownVersionId: known,
        settledStepCursor: prev ? settledStepCursor(prev.steps) : undefined,
      })
      if (!next || !prev) return next
      const withVersion = next.versionOmitted
        ? mergeVersionBlock(next, prev)
        : next
      return withVersion.stepsPartial
        ? mergeStepBlock(withVersion, prev)
        : withVersion
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

// Write or clear the run's shared note. Invalidates this run (the viewer's own
// copy) and the whole runs list — the note is a searchable, displayed column
// there, so a page holding the edited run is now stale either way.
export function useSetRunNote() {
  return useWfMutation(
    (client, input: { runId: string; note: string | null }) =>
      client.setRunNote(input),
    (input) => [keys.run(input.runId), keys.runsAll],
  )
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
