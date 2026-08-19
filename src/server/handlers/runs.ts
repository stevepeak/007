import {
  deleteAllRuns,
  getLatestVersionId,
  getRun,
  getRunRetrySource,
  getRunStatus,
  listRunTriggerKinds,
  listRuns,
} from '../../storage/data'
import type {
  RetryRunMode,
  WfRunDetail,
  WfRunLogDTO,
  WfRunStatusDTO,
  WfRunStepDTO,
} from '../protocol'

import {
  NotFoundError,
  optNum,
  optStr,
  requireHook,
  runSummary,
  str,
  toEpoch,
  type CreateWfSdkHandlersOptions,
  type WfHandlers,
} from './shared'

export function buildRunHandlers<TDeps>(
  opts: CreateWfSdkHandlersOptions<TDeps>,
): Pick<
  WfHandlers,
  | 'listRuns'
  | 'listRunTriggerKinds'
  | 'getRun'
  | 'getRunStatus'
  | 'retryRun'
  | 'deleteAllRuns'
> {
  return {
    listRuns: async (c) => {
      const p = c.params as {
        workflowVersionId?: string
        workflowId?: string
        triggerKind?: string
        status?: string
        search?: string
        since?: number
        until?: number
        limit?: number
        offset?: number
      }
      const result = await listRuns(c.db, {
        workflowVersionId: p.workflowVersionId,
        workflowId: p.workflowId,
        triggerKind: p.triggerKind,
        status: p.status,
        search: p.search?.trim() || undefined,
        since: typeof p.since === 'number' ? new Date(p.since) : undefined,
        until: typeof p.until === 'number' ? new Date(p.until) : undefined,
        limit: p.limit,
        offset: p.offset,
      })
      return {
        runs: result.rows.map((r) => runSummary(r, opts.sentryTraceUrl)),
        total: result.total,
        limit: result.limit,
        offset: result.offset,
      }
    },

    listRunTriggerKinds: async (c) => await listRunTriggerKinds(c.db),

    // Wipe all run history (steps, logs, eval results/runs go with it). Takes
    // no params on purpose — it is all-or-nothing, never a filtered delete, so
    // there's no shape in which a mistyped filter silently deletes the wrong
    // slice. See `deleteAllRuns` for exactly what cascades.
    deleteAllRuns: async (c) => await deleteAllRuns(c.db),

    // The settle check. Deliberately NOT `getRun` with the fields picked off:
    // this is one indexed row, and the whole point is that a poll loop never
    // touches the step, log, graph or price-map reads to learn a run finished.
    getRunStatus: async (c) => {
      const runId = str(c.params, 'runId')
      const row = await getRunStatus(c.db, runId)
      if (!row) {
        return null
      }
      // Named rather than spread, so a column added to the storage read can't
      // silently widen the payload this exists to keep narrow.
      const status: WfRunStatusDTO = {
        status: row.status,
        output: row.output,
        error: row.error,
      }
      return status
    },

    getRun: async (c) => {
      const runId = str(c.params, 'runId')
      const knownVersionId = optStr(c.params, 'knownVersionId')
      const settledStepCursor = optNum(c.params, 'settledStepCursor')
      const result = await getRun(c.db, runId, {
        knownVersionId,
        settledStepCursor,
      })
      if (!result) {
        return null
      }
      const steps: WfRunStepDTO[] = result.steps.map((s) => ({
        cursor: s.cursor,
        nodeId: s.nodeId,
        nodeKind: s.nodeKind,
        parentNodeId: s.parentNodeId ?? null,
        itemIndex: s.itemIndex,
        sequence: s.sequence,
        status: s.status,
        input: s.input,
        output: s.output,
        branchResult: s.branchResult,
        meta: s.meta,
        error: s.error,
        startedAt: toEpoch(s.startedAt),
        finishedAt: toEpoch(s.finishedAt),
        costUsd: s.costUsd ?? null,
      }))
      // `getRunLogs` already returns exactly the wire shape (WfRunLogRow is
      // field-identical to WfRunLogDTO), so this is a direct assignment, not a
      // remap — the annotation makes any future field drift a compile error.
      const logs: WfRunLogDTO[] = result.logs
      const detail: WfRunDetail = {
        run: {
          ...runSummary(
            {
              ...result.run,
              workflowId: result.workflowId ?? '',
              workflowName: result.workflowName ?? '(unknown workflow)',
              versionNumber: result.versionNumber ?? 0,
              totalTokens: result.totalTokens,
              costUsd: result.costUsd,
            },
            opts.sentryTraceUrl,
          ),
          output: result.run.output,
        },
        steps,
        logs,
        graph: result.graph,
        versionNumber: result.versionNumber,
        workflowVersionId: result.workflowVersionId,
        // Only ever set, never set-to-false — these are presence flags, and an
        // explicit `false` would be more bytes on every full load for no reader.
        ...(result.versionOmitted ? { versionOmitted: true as const } : {}),
        ...(result.stepsPartial ? { stepsPartial: true as const } : {}),
        ...(result.logsTruncated ? { logsTruncated: true as const } : {}),
      }
      return detail
    },

    retryRun: async (c) => {
      const retryRun = requireHook(
        opts.retryRun,
        'Retry is not configured for this host.',
      )
      const runId = str(c.params, 'runId')
      const mode: RetryRunMode =
        (c.params as { mode?: string }).mode === 'resume' ? 'resume' : 'restart'
      // The narrow read, not `getRun`: retry needs four run columns and one
      // trigger step, and used to pay for every step, every log, the whole
      // graph and the model price map to get them.
      const source = await getRunRetrySource(c.db, runId)
      if (!source) {
        throw new NotFoundError('Run not found.')
      }
      const latestVersionId = source.workflowId
        ? await getLatestVersionId(c.db, source.workflowId)
        : null
      return await retryRun({
        mode,
        source: {
          runId,
          workflowId: source.workflowId ?? '',
          originalVersionId: source.workflowVersionId,
          latestVersionId,
          triggerKind: source.triggerKind,
          triggerInput: source.triggerInput,
          subjectId: source.subjectId,
          correlationId: source.correlationId,
        },
        ctx: c.ctx,
        req: c.req,
      })
    },
  }
}
