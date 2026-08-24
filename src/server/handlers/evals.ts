import { agentConfigSchema } from '../../engine/graph'
import {
  collectSeededToolCalls,
  EVAL_NODE_EXECUTION,
  gradeRow,
  resolveEvalTarget,
  evalInvocation,
  rollup,
  type GradeModelFactory,
  type GradeStep,
} from '../../eval'
import type { EvalRowSnapshot } from '../../eval/checks'
import {
  buildEvalSnapshot,
  changedEvalRowFields,
  changesBetween,
  changedEvalSetFields,
  createEvalRun,
  createEvalSet,
  deleteEvalRow,
  deleteEvalSet,
  getEvalRow,
  getEvalRun,
  getEvalSet,
  getRunForGrading,
  hashEvalSnapshot,
  insertEvalResult,
  listEvalRuns,
  listEvalSets,
  loadPreviousEvalRun,
  loadPreviousSnapshotHashes,
  loadRunStats,
  updateEvalRun,
  updateEvalSet,
  upsertEvalRow,
} from '../../storage/data'
import type { WfChangeRecord } from '../../storage/data'
import type {
  WfEvalDriftChange,
  WfEvalRowDTO,
  WfEvalRunDrift,
  WfEvalTargetKind,
} from '../protocol'

import { evalResultDTO, evalRunSummary, evalSetSummary } from './eval-dto'
import {
  NotFoundError,
  requireHook,
  requireStr,
  type CreateWfSdkHandlersOptions,
  type HandlerCtx,
  type WfHandlers,
} from './shared'

// Cap on a recorded failure reason. Provider response bodies can be whole HTML
// error pages; the report shows this inline, and the full detail already lives
// in `wf_run_step.error` reachable via `wfRunId`.
const MAX_RECORDED_ERROR_CHARS = 2000

// Project recorded steps onto the shape a grader reads. The "top-level only"
// rule — checks address the workflow's own nodes, never an iteration's per-item
// subgraph copies — now lives in `getRunForGrading`'s WHERE clause, so those
// rows are never read rather than read and discarded.
function toGradeSteps(
  steps: Array<{
    nodeId: string
    nodeKind: string
    input?: unknown
    output?: unknown
    meta?: unknown
  }>,
): GradeStep[] {
  return steps.map((s) => ({
    nodeId: s.nodeId,
    nodeKind: s.nodeKind,
    input: s.input,
    output: s.output,
    meta: s.meta,
  }))
}


// What changed between an eval run and the last one that measured the same
// samples — the question a moved pass rate always raises.
//
// Two axes, because either alone misleads. The GOAL axis is edits to the Goal
// and its samples; the TARGET axis is edits to the agent under test, which a
// sample's snapshot hash structurally cannot see when the Goal floats to the
// latest published version.
//
// Never throws: a report that can't explain itself is still a report.
async function loadDrift(
  c: HandlerCtx,
  input: {
    previous: Map<string, { hash: string | null; evalRunId: string; at: Date }>
    setIds: string[]
    rowIds: string[]
    targetId: string | null
    targetKind: 'agent' | 'workflow'
    until: Date
  },
): Promise<WfEvalRunDrift | null> {
  try {
    const prev = await loadPreviousEvalRun(c.db, input.previous)
    if (!prev) return null

    const window = { from: prev.at, to: input.until }
    const [goal, target] = await Promise.all([
      changesBetween(
        c.db,
        [
          { entityKind: 'eval_set', entityIds: input.setIds },
          { entityKind: 'eval_row', entityIds: input.rowIds },
        ],
        window,
      ),
      input.targetId
        ? changesBetween(
            c.db,
            [{ entityKind: input.targetKind, entityIds: [input.targetId] }],
            window,
          )
        : Promise.resolve([]),
    ])

    return {
      previousRunId: prev.id,
      previousRunAt: prev.at.getTime(),
      previousAgentVersion: prev.agentVersion,
      goalChanges: goal.map(driftChange),
      targetChanges: target.map(driftChange),
    }
  } catch (err) {
    console.warn('[wf] eval drift lookup failed:', err)
    return null
  }
}

function driftChange(row: WfChangeRecord): WfEvalDriftChange {
  return {
    entityKind: row.entityKind as WfEvalDriftChange['entityKind'],
    action: row.action,
    fields: Array.isArray(row.fields) ? (row.fields as string[]) : [],
    actorId: row.actorId,
    note: row.note,
    at: row.createdAt.getTime(),
  }
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
  | 'recordEvalFailure'
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
      const setId = requireStr(c.params, 'setId')
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
      const name = requireStr(c.params, 'name')
      const targetId = requireStr(c.params, 'targetId')
      const triggerKind = requireStr(c.params, 'triggerKind')
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
      await c.change({
        entityKind: 'eval_set',
        entityId: setId,
        action: 'create',
        fields: ['name', 'target'],
        after: { name, targetKind, targetId, triggerKind },
        note: name,
      })
      return { setId }
    },

    updateEvalSet: async (c) => {
      const setId = requireStr(c.params, 'setId')
      const p = c.params as {
        name?: string
        description?: string | null
        targetKind?: WfEvalTargetKind
        targetId?: string
        targetVersion?: number | null
        triggerKind?: string
        archived?: boolean
      }
      // Read first: a Goal has no version history, so this before-image is the
      // only record of what it used to say.
      const existing = await getEvalSet(c.db, setId)
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
      const before = existing?.set ?? null
      const after = (await getEvalSet(c.db, setId))?.set ?? null
      await c.change({
        entityKind: 'eval_set',
        entityId: setId,
        action: p.archived === true ? 'archive' : 'update',
        fields:
          before && after ? changedEvalSetFields(before, after) : Object.keys(p),
        before,
        after,
        note: after?.name ?? before?.name ?? null,
      })
      return { ok: true }
    },

    deleteEvalSet: async (c) => {
      const setId = requireStr(c.params, 'setId')
      const existing = await getEvalSet(c.db, setId)
      await deleteEvalSet(c.db, setId)
      await c.change({
        entityKind: 'eval_set',
        entityId: setId,
        action: 'archive',
        fields: ['archived'],
        before: existing?.set ?? null,
        note: existing?.set.name ?? null,
      })
      return { ok: true }
    },

    upsertEvalRow: async (c) => {
      const setId = requireStr(c.params, 'setId')
      const name = requireStr(c.params, 'name')
      const p = c.params as {
        id?: string
        description?: string | null
        input?: WfEvalRowDTO['input']
        tools?: WfEvalRowDTO['tools']
        checks?: WfEvalRowDTO['checks']
        sortOrder?: number
      }
      // A Sample carries the grading criteria and has no version history, so
      // the before-image here is the only way to see what a score was measured
      // against yesterday.
      const before = p.id ? ((await getEvalRow(c.db, p.id))?.row ?? null) : null
      // The JSON payloads are validated inside `upsertEvalRow` (zod).
      const rowId = await upsertEvalRow(c.db, {
        id: p.id,
        setId,
        name,
        description: p.description,
        input: p.input,
        tools: p.tools,
        checks: p.checks,
        sortOrder: p.sortOrder,
      })
      const after = (await getEvalRow(c.db, rowId))?.row ?? null
      await c.change({
        entityKind: 'eval_row',
        entityId: rowId,
        parentId: setId,
        action: before ? 'update' : 'create',
        fields:
          before && after ? changedEvalRowFields(before, after) : ['input', 'checks'],
        before,
        after,
        note: name,
      })
      return { rowId }
    },

    deleteEvalRow: async (c) => {
      const rowId = requireStr(c.params, 'rowId')
      const existing = await getEvalRow(c.db, rowId)
      await deleteEvalRow(c.db, rowId)
      await c.change({
        entityKind: 'eval_row',
        entityId: rowId,
        parentId: existing?.row.setId ?? null,
        action: 'archive',
        fields: ['archived'],
        before: existing?.row ?? null,
        note: existing?.row.name ?? null,
      })
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
      const evalRunId = requireStr(c.params, 'evalRunId')
      const rowId = requireStr(c.params, 'rowId')
      // Matrix cell overrides — swap the target agent's model / system prompt for
      // this run. Absent → the agent's own saved model/prompt (the plain path).
      const cell = c.params as {
        modelId?: string
        promptBody?: string
        config?: unknown
      }
      // Draft override: the agent editor sends its unsaved config so a goal can
      // be run before publishing. Parsed HERE, at the API boundary, so a
      // malformed draft fails as a 400-shaped error the editor can show rather
      // than as a zod throw halfway through a run that already exists.
      const configOverride = cell.config
        ? agentConfigSchema.parse(cell.config)
        : undefined
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
        {
          kind: set.targetKind,
          id: set.targetId,
          // The Goal's pin. Passing it is what makes "pinned v3" in the UI and
          // `targetVersion: 3` in the frozen snapshot true statements about the
          // version that actually ran.
          version: set.targetVersion,
        },
        set.triggerKind,
        { createdBy: c.ctx.userId },
      )
      // The Sample's authored input + tools become the engine's run signals.
      // One translation, in `evalInvocation` — the handler no longer decides
      // which of several overlapping fields wins.
      const invocation = evalInvocation(row.input, row.tools)
      const started = await startEvalRun({
        evalRunId,
        rowId,
        target: { kind: set.targetKind, id: set.targetId },
        workflowVersionId: resolved.workflowVersionId,
        triggerKind: resolved.triggerKind,
        triggerInput: invocation.triggerInput,
        promptVariables: invocation.promptVariables,
        fixtures: invocation.fixtures,
        freezeTools: invocation.freezeTools,
        liveReads: invocation.liveReads,
        modelId: cell.modelId,
        promptBody: cell.promptBody,
        configOverride,
        // Cap this run's nodes. Applied per-run rather than baked into the
        // graph so it covers workflow targets (whose graphs we must not
        // rewrite) and agent targets whose hidden wrapper was cached long ago.
        executionOverride: EVAL_NODE_EXECUTION,
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
      const evalRunId = requireStr(c.params, 'evalRunId')
      const rowId = requireStr(c.params, 'rowId')
      const wfRunId = requireStr(c.params, 'wfRunId')
      // Matrix cell identity to stamp on the result — all absent for a plain run.
      const cell = c.params as {
        modelId?: string
        promptLabel?: string
        promptBody?: string
        attempt?: number
      }
      const found = await getEvalRow(c.db, rowId)
      if (!found) {
        throw new NotFoundError('Eval sample not found.')
      }
      // The narrow read, not `getRun`: a judge reads the run's output and its
      // top-level steps, never the log feed, the graph or the price map. This
      // fires once per eval cell, on top of that cell's own settle poll.
      const runResult = await getRunForGrading(c.db, wfRunId)
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
        output: runResult.output,
        getModel,
        defaultJudgeModelId,
        // Synthesis mode: the tools were frozen, so the model's context came from
        // the Sample's seeded conversation, not the run trace. Hand those staged
        // tool results to the judge so it can grade the answer's groundedness.
        seededToolCalls: collectSeededToolCalls(
          found.row.input.kind === 'conversation'
            ? found.row.input.turns
            : undefined,
        ),
      })
      // Freeze the Sample + Goal target this result was graded against, so
      // the report reproduces it exactly even after the definitions change.
      // The concrete agent version that ran stays reachable via wfRunId →
      // wf_run.manifest, so it isn't duplicated in the snapshot.
      const snapshot = buildEvalSnapshot(found.row, found.set)
      const snapshotHash = await hashEvalSnapshot(snapshot)
      // Build the persisted columns once, then reuse them for the returned DTO so
      // the two can't drift when a column is added.
      const record = {
        evalRunId,
        rowId,
        wfRunId,
        status: graded.status,
        score: graded.score,
        checkResults: graded.checkResults,
        // The grader's own explanation for an errored verdict — an empty check
        // tree, or a judge that threw. Same column `recordEvalFailure` writes
        // and the report already renders, so an errored GRADED cell stops
        // showing up as a red row above an empty banner. Capped identically to
        // that path: the cap is a storage concern, not a grading one.
        error: graded.error?.slice(0, MAX_RECORDED_ERROR_CHARS) ?? null,
        snapshot,
        snapshotHash,
        modelId: cell.modelId,
        promptLabel: cell.promptLabel,
        promptBody: cell.promptBody,
        attempt: cell.attempt,
      }
      const resultId = await insertEvalResult(c.db, record)
      // Reuse the shared mapper so this result's shape can't drift from the one
      // `getEvalRun` returns. `createdAt` is the response's best-effort now (the
      // row isn't re-read); the mapper takes a Date and emits epoch ms.
      const stats = await loadRunStats(c.db, [wfRunId])
      return evalResultDTO(
        { ...record, id: resultId, createdAt: new Date() },
        stats.get(wfRunId),
      )
    },

    recordEvalFailure: async (c) => {
      const evalRunId = requireStr(c.params, 'evalRunId')
      const rowId = requireStr(c.params, 'rowId')
      const error = requireStr(c.params, 'error')
      const p = c.params as {
        wfRunId?: string
        modelId?: string
        promptLabel?: string
        promptBody?: string
        attempt?: number
      }
      const found = await getEvalRow(c.db, rowId)
      if (!found) {
        throw new NotFoundError('Eval sample not found.')
      }
      // Freeze the same Sample + Goal snapshot the graded path does. Without it
      // the report has nothing to name the row by and renders a raw UUID — the
      // failure would be recorded but still unreadable.
      const snapshot = buildEvalSnapshot(found.row, found.set)
      const snapshotHash = await hashEvalSnapshot(snapshot)
      const record = {
        evalRunId,
        rowId,
        wfRunId: p.wfRunId ?? null,
        status: 'error' as const,
        score: null,
        checkResults: [],
        error: error.slice(0, MAX_RECORDED_ERROR_CHARS),
        snapshot,
        snapshotHash,
        modelId: p.modelId,
        promptLabel: p.promptLabel,
        promptBody: p.promptBody,
        attempt: p.attempt,
      }
      const resultId = await insertEvalResult(c.db, record)
      // A run that failed AFTER burning tokens still cost real money — surface
      // that in the report rather than showing the cell as free.
      const stats = p.wfRunId ? await loadRunStats(c.db, [p.wfRunId]) : null
      return evalResultDTO(
        { ...record, id: resultId, createdAt: new Date() },
        p.wfRunId ? stats?.get(p.wfRunId) : null,
      )
    },

    finalizeEvalRun: async (c) => {
      const evalRunId = requireStr(c.params, 'evalRunId')
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
      const evalRunId = requireStr(c.params, 'evalRunId')
      const result = await getEvalRun(c.db, evalRunId)
      if (!result) {
        return null
      }
      // Enrich each result with the cost/speed/model of its wf_run (the agent
      // call), derived live so it reflects current pricing and old runs too.
      const runIds = result.results
        .map((r) => r.wfRunId)
        .filter((id): id is string => id != null)
      const stats = await loadRunStats(c.db, runIds)
      // What each sample looked like the last time it ran, so the report can say
      // whether a moved score followed a moved test.
      // The frozen target identity — every result in a run shares it.
      const firstSnapshot = result.results
        .map((r) => r.snapshot as EvalRowSnapshot | null)
        .find((snap) => snap != null)
      const previous = await loadPreviousSnapshotHashes(c.db, {
        evalRunId,
        rowIds: [...new Set(result.results.map((r) => r.rowId))],
        before: result.run.createdAt,
      })
      return {
        run: evalRunSummary(result.run),
        results: result.results.map((r) =>
          evalResultDTO(
            r,
            r.wfRunId ? stats.get(r.wfRunId) : null,
            previous.get(r.rowId)?.hash ?? null,
          ),
        ),
        drift: await loadDrift(c, {
          previous,
          setIds: Array.isArray(result.run.setIds)
            ? (result.run.setIds as string[])
            : [],
          rowIds: [...new Set(result.results.map((r) => r.rowId))],
          targetId: firstSnapshot?.target.targetId ?? null,
          targetKind:
            firstSnapshot?.target.targetKind === 'workflow' ? 'workflow' : 'agent',
          until: result.run.createdAt,
        }),
      }
    },
  }
}
