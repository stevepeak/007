import type { WorkflowGraph } from '../../engine/graph'
import {
  getLatestVersionId,
  getRun,
  listRunTriggerKinds,
  listRuns,
} from '../../storage/data'

import type {
  RetryRunMode,
  WfRunDetail,
  WfRunLogDTO,
  WfRunStepDTO,
  WfRunSummary,
} from '../protocol'
import {
  requireHook,
  str,
  toEpoch,
  type CreateWfSdkHandlersOptions,
  type WfHandlers,
} from './shared'

function runSummary(
  r: {
    id: string
    status: string
    triggerKind: string
    workflowId: string
    workflowName: string
    versionNumber: number
    subjectId: string | null
    correlationId: string | null
    createdAt: Date
    startedAt: Date | null
    finishedAt: Date | null
    error: string | null
    totalTokens?: number | null
    costUsd?: number | null
    sentryTraceId?: string | null
  },
  traceUrl?: (traceId: string) => string | null,
): WfRunSummary {
  const sentryTraceId = r.sentryTraceId ?? null
  return {
    id: r.id,
    status: r.status,
    triggerKind: r.triggerKind,
    workflowId: r.workflowId,
    workflowName: r.workflowName,
    versionNumber: r.versionNumber,
    subjectId: r.subjectId,
    correlationId: r.correlationId,
    createdAt: r.createdAt.getTime(),
    startedAt: toEpoch(r.startedAt),
    finishedAt: toEpoch(r.finishedAt),
    error: r.error,
    totalTokens: r.totalTokens ?? null,
    costUsd: r.costUsd ?? null,
    sentryTraceId,
    sentryTraceUrl:
      sentryTraceId && traceUrl ? (traceUrl(sentryTraceId) ?? null) : null,
  }
}

export function buildRunHandlers<TDeps>(
  opts: CreateWfSdkHandlersOptions<TDeps>,
): Pick<
  WfHandlers,
  'listRuns' | 'listRunTriggerKinds' | 'getRun' | 'retryRun'
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

    getRun: async (c) => {
      const runId = str(c.params, 'runId')
      const result = await getRun(c.db, runId)
      if (!result) {
        return null
      }
      const steps: WfRunStepDTO[] = result.steps.map((s) => ({
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
        graph: (result.graph as WorkflowGraph | null) ?? null,
        versionNumber: result.versionNumber,
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
      const result = await getRun(c.db, runId)
      if (!result) {
        throw new Error('Run not found.')
      }
      // Reconstruct the trigger input from the recorded trigger step — the
      // run row doesn't persist it. The trigger "executes" instantly with
      // its output set to the validated trigger input (see executor.ts).
      const triggerStep = result.steps.find((s) => s.nodeKind === 'trigger')
      const latestVersionId = result.workflowId
        ? await getLatestVersionId(c.db, result.workflowId)
        : null
      return await retryRun({
        mode,
        source: {
          runId,
          workflowId: result.workflowId ?? '',
          originalVersionId: result.run.workflowVersionId,
          latestVersionId,
          triggerKind: result.run.triggerKind,
          triggerInput: triggerStep?.output ?? triggerStep?.input ?? {},
          subjectId: result.run.subjectId,
          correlationId: result.run.correlationId,
        },
        ctx: c.ctx,
        req: c.req,
      })
    },
  }
}
