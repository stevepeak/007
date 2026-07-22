import {
  gradeRow,
  resolveEvalTarget,
  rollup,
  type GradeModelFactory,
  type GradeStep,
} from '../../eval'
import {
  buildEvalSnapshot,
  createEvalRun,
  createEvalSet,
  deleteEvalRow,
  deleteEvalSet,
  getEvalRow,
  getEvalRun,
  getEvalSet,
  getRun,
  hashEvalSnapshot,
  insertEvalResult,
  listEvalRuns,
  listEvalSets,
  updateEvalRun,
  updateEvalSet,
  upsertEvalRow,
} from '../../storage/data'
import type {
  EvalRowSnapshot,
  WfEvalResultDTO,
  WfEvalRowDTO,
  WfEvalRunSummary,
  WfEvalSetSummary,
  WfEvalTargetKind,
} from '../protocol'

import {
  NotFoundError,
  requireHook,
  str,
  toEpoch,
  type CreateWfSdkHandlersOptions,
  type WfHandlers,
} from './shared'

function evalSetSummary(
  s: {
    id: string
    name: string
    description: string | null
    targetKind: WfEvalTargetKind
    targetId: string
    targetVersion: number | null
    triggerKind: string
    archived: boolean
    createdAt: Date
    updatedAt: Date | null
  },
  rowCount: number,
): WfEvalSetSummary {
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    targetKind: s.targetKind,
    targetId: s.targetId,
    targetVersion: s.targetVersion,
    triggerKind: s.triggerKind,
    archived: s.archived,
    rowCount,
    createdAt: s.createdAt.getTime(),
    updatedAt: toEpoch(s.updatedAt),
  }
}

function evalRunSummary(r: {
  id: string
  status: string
  setIds: unknown
  total: number
  passed: number
  failed: number
  score: number | null
  createdAt: Date
  startedAt: Date | null
  finishedAt: Date | null
}): WfEvalRunSummary {
  return {
    id: r.id,
    status: r.status,
    setIds: Array.isArray(r.setIds) ? (r.setIds as string[]) : [],
    total: r.total,
    passed: r.passed,
    failed: r.failed,
    score: r.score,
    createdAt: r.createdAt.getTime(),
    startedAt: toEpoch(r.startedAt),
    finishedAt: toEpoch(r.finishedAt),
  }
}

function evalResultDTO(r: {
  id: string
  evalRunId: string
  rowId: string
  wfRunId: string | null
  status: WfEvalResultDTO['status']
  score: number | null
  checkResults: unknown
  snapshot?: unknown
  snapshotHash?: string | null
  createdAt: Date
}): WfEvalResultDTO {
  return {
    id: r.id,
    evalRunId: r.evalRunId,
    rowId: r.rowId,
    wfRunId: r.wfRunId,
    status: r.status,
    score: r.score,
    checkResults: Array.isArray(r.checkResults)
      ? (r.checkResults as WfEvalResultDTO['checkResults'])
      : [],
    snapshot: (r.snapshot as EvalRowSnapshot | null) ?? null,
    snapshotHash: r.snapshotHash ?? null,
    createdAt: r.createdAt.getTime(),
  }
}

// The top-level run steps a grader reads. Iteration inner-subgraph steps (those
// with a `parentNodeId`) are excluded — checks address the workflow's own nodes,
// not an iteration's per-item subgraph nodes.
function toGradeSteps(
  steps: Array<{
    nodeId: string
    nodeKind: string
    parentNodeId?: string | null
    input?: unknown
    output?: unknown
    meta?: unknown
  }>,
): GradeStep[] {
  return steps
    .filter((s) => !s.parentNodeId)
    .map((s) => ({
      nodeId: s.nodeId,
      nodeKind: s.nodeKind,
      input: s.input,
      output: s.output,
      meta: s.meta,
    }))
}

export function buildEvalHandlers<TDeps>(
  opts: CreateWfSdkHandlersOptions<TDeps>,
): Pick<
  WfHandlers,
  | 'listEvalSets'
  | 'getEvalSet'
  | 'createEvalSet'
  | 'updateEvalSet'
  | 'deleteEvalSet'
  | 'upsertEvalRow'
  | 'deleteEvalRow'
  | 'createEvalRun'
  | 'startEvalRun'
  | 'gradeEvalResult'
  | 'finalizeEvalRun'
  | 'listEvalRuns'
  | 'getEvalRun'
> {
  return {
    listEvalSets: async (c) => {
      const includeArchived = (c.params as { includeArchived?: boolean })
        .includeArchived
      const rows = await listEvalSets(c.db, { includeArchived })
      return rows.map((r) => evalSetSummary(r, Number(r.rowCount)))
    },

    getEvalSet: async (c) => {
      const setId = str(c.params, 'setId')
      const result = await getEvalSet(c.db, setId)
      if (!result) {
        return null
      }
      const rows: WfEvalRowDTO[] = result.rows
      return {
        set: evalSetSummary(result.set, rows.length),
        rows,
      }
    },

    createEvalSet: async (c) => {
      const name = str(c.params, 'name')
      const targetId = str(c.params, 'targetId')
      const triggerKind = str(c.params, 'triggerKind')
      const p = c.params as {
        description?: string
        targetKind?: WfEvalTargetKind
        targetVersion?: number | null
      }
      const targetKind: WfEvalTargetKind =
        p.targetKind === 'workflow' ? 'workflow' : 'agent'
      const setId = await createEvalSet(c.db, {
        name,
        description: p.description,
        targetKind,
        targetId,
        targetVersion: p.targetVersion ?? null,
        triggerKind,
        createdBy: c.ctx.userId,
      })
      return { setId }
    },

    updateEvalSet: async (c) => {
      const setId = str(c.params, 'setId')
      const p = c.params as {
        name?: string
        description?: string | null
        targetKind?: WfEvalTargetKind
        targetId?: string
        targetVersion?: number | null
        triggerKind?: string
        archived?: boolean
      }
      await updateEvalSet(c.db, {
        setId,
        name: p.name,
        description: p.description,
        targetKind: p.targetKind,
        targetId: p.targetId,
        targetVersion: p.targetVersion,
        triggerKind: p.triggerKind,
        archived: p.archived,
      })
      return { ok: true }
    },

    deleteEvalSet: async (c) => {
      const setId = str(c.params, 'setId')
      await deleteEvalSet(c.db, setId)
      return { ok: true }
    },

    upsertEvalRow: async (c) => {
      const setId = str(c.params, 'setId')
      const name = str(c.params, 'name')
      const p = c.params as {
        id?: string
        description?: string | null
        initialCondition?: WfEvalRowDTO['initialCondition']
        fixtures?: WfEvalRowDTO['fixtures']
        checks?: WfEvalRowDTO['checks']
        sortOrder?: number
      }
      // The JSON payloads are validated inside `upsertEvalRow` (zod).
      const rowId = await upsertEvalRow(c.db, {
        id: p.id,
        setId,
        name,
        description: p.description,
        initialCondition: p.initialCondition,
        fixtures: p.fixtures,
        checks: p.checks,
        sortOrder: p.sortOrder,
      })
      return { rowId }
    },

    deleteEvalRow: async (c) => {
      const rowId = str(c.params, 'rowId')
      await deleteEvalRow(c.db, rowId)
      return { ok: true }
    },

    createEvalRun: async (c) => {
      const p = c.params as { setIds?: unknown; total?: number }
      const setIds = Array.isArray(p.setIds)
        ? p.setIds.filter((s): s is string => typeof s === 'string')
        : []
      if (setIds.length === 0) {
        throw new Error('createEvalRun requires at least one set id.')
      }
      const evalRunId = await createEvalRun(c.db, {
        setIds,
        total: p.total,
        createdBy: c.ctx.userId,
      })
      return { evalRunId }
    },

    startEvalRun: async (c) => {
      const startEvalRun = requireHook(
        opts.startEvalRun,
        'Eval runs are not configured for this host.',
      )
      const evalRunId = str(c.params, 'evalRunId')
      const rowId = str(c.params, 'rowId')
      const run = await getEvalRun(c.db, evalRunId)
      if (!run) {
        throw new NotFoundError('Eval run not found.')
      }
      const found = await getEvalRow(c.db, rowId)
      if (!found) {
        throw new NotFoundError('Eval sample not found.')
      }
      const { row, set } = found
      // Resolve the target to a concrete version (agent → hidden wrapper) and
      // the trigger kind to start under, before handing the host the run.
      const resolved = await resolveEvalTarget(
        c.db,
        { kind: set.targetKind, id: set.targetId },
        set.triggerKind,
        { createdBy: c.ctx.userId },
      )
      const started = await startEvalRun({
        evalRunId,
        rowId,
        target: { kind: set.targetKind, id: set.targetId },
        workflowVersionId: resolved.workflowVersionId,
        triggerKind: resolved.triggerKind,
        triggerInput: row.initialCondition.triggerInput ?? {},
        promptVariables: row.initialCondition.promptVariables ?? {},
        fixtures: row.fixtures,
        ctx: c.ctx,
        req: c.req,
      })
      // Flip the umbrella run to running on its first started row.
      if (run.run.status === 'queued') {
        await updateEvalRun(c.db, {
          evalRunId,
          status: 'running',
          startedAt: new Date(),
        })
      }
      return started
    },

    gradeEvalResult: async (c) => {
      const evalRunId = str(c.params, 'evalRunId')
      const rowId = str(c.params, 'rowId')
      const wfRunId = str(c.params, 'wfRunId')
      const found = await getEvalRow(c.db, rowId)
      if (!found) {
        throw new NotFoundError('Eval sample not found.')
      }
      const runResult = await getRun(c.db, wfRunId)
      if (!runResult) {
        throw new NotFoundError('Run not found.')
      }
      const steps = toGradeSteps(runResult.steps)
      const env = await c.env()
      // Judge checks resolve their model through the host's live seam.
      const getModel: GradeModelFactory = (modelId) =>
        opts.config.getModel(modelId, { triggerKind: 'eval', env })
      const defaultJudgeModelId =
        opts.evalJudgeModelId ?? (await opts.config.listModels({ env }))[0]?.id
      const graded = await gradeRow({
        checks: found.row.checks,
        steps,
        output: runResult.run.output,
        getModel,
        defaultJudgeModelId,
      })
      // Freeze the Sample + Goal target this result was graded against, so
      // the report reproduces it exactly even after the definitions change.
      // The concrete agent version that ran stays reachable via wfRunId →
      // wf_run.manifest, so it isn't duplicated in the snapshot.
      const snapshot = buildEvalSnapshot(found.row, found.set)
      const snapshotHash = await hashEvalSnapshot(snapshot)
      const resultId = await insertEvalResult(c.db, {
        evalRunId,
        rowId,
        wfRunId,
        status: graded.status,
        score: graded.score,
        checkResults: graded.checkResults,
        snapshot,
        snapshotHash,
      })
      // Reuse the shared mapper so this result's shape can't drift from the one
      // `getEvalRun` returns. `createdAt` is the response's best-effort now (the
      // row isn't re-read); the mapper takes a Date and emits epoch ms.
      return evalResultDTO({
        id: resultId,
        evalRunId,
        rowId,
        wfRunId,
        status: graded.status,
        score: graded.score,
        checkResults: graded.checkResults,
        snapshot,
        snapshotHash,
        createdAt: new Date(),
      })
    },

    finalizeEvalRun: async (c) => {
      const evalRunId = str(c.params, 'evalRunId')
      const found = await getEvalRun(c.db, evalRunId)
      if (!found) {
        throw new NotFoundError('Eval run not found.')
      }
      const summary = rollup(
        found.results.map((r) => ({ status: r.status, score: r.score })),
      )
      await updateEvalRun(c.db, {
        evalRunId,
        status: 'completed',
        total: summary.total,
        passed: summary.passed,
        failed: summary.failed,
        score: summary.meanScore,
        finishedAt: new Date(),
      })
      const updated = await getEvalRun(c.db, evalRunId)
      return evalRunSummary(updated?.run ?? found.run)
    },

    listEvalRuns: async (c) => {
      const limit = (c.params as { limit?: number }).limit
      const rows = await listEvalRuns(c.db, { limit })
      return rows.map(evalRunSummary)
    },

    getEvalRun: async (c) => {
      const evalRunId = str(c.params, 'evalRunId')
      const result = await getEvalRun(c.db, evalRunId)
      if (!result) {
        return null
      }
      return {
        run: evalRunSummary(result.run),
        results: result.results.map(evalResultDTO),
      }
    },
  }
}
