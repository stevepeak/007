import { changedEvalRowFields, changedEvalSetFields } from '../../engine'
import { toAgentKind } from '../../engine/agent-kind'
import { runDecisionAgent } from '../../engine/decision-agent'
import {
  decisionAgentConfigSchema,
  type DecisionAgentConfig,
} from '../../engine/decision-agent-schema'
import type { EvalRowSnapshot } from '../../engine/eval-schema'
import { agentConfigSchema } from '../../engine/graph'
import {
  collectSeededToolCalls,
  decisionInvocation,
  EVAL_NODE_EXECUTION,
  gradeRow,
  type GradeDeciderFactory,
  resolveEvalTarget,
  evalInvocation,
  rollup,
  type GradeModelFactory,
  type GradeStep,
} from '../../eval'
import {
  evalCellKey,
  parseEvalDriveState,
  parseEvalPlan,
} from '../../eval/plan'
import {
  agentVersionByNumber,
  buildEvalSnapshot,
  cancelEvalRun,
  changesBetween,
  createEvalRun,
  createEvalSet,
  deleteEvalRow,
  deleteEvalSet,
  getEvalRow,
  getEvalRun,
  getEvalRunDrive,
  getAgent,
  getEvalSet,
  getRunForGrading,
  hashEvalSnapshot,
  insertEvalResult,
  latestAgentVersion,
  listEvalRuns,
  listEvalSets,
  loadPreviousEvalRun,
  loadPreviousSnapshotHashes,
  loadModelPriceMap,
  loadRunStats,
  restoreEvalRow,
  saveEvalRunDrive,
  updateEvalRun,
  updateEvalSet,
  upsertEvalRow,
} from '../../storage/data'
import type { WfChangeRecord } from '../../storage/data'
import type {
  WfEvalDriftChange,
  WfEvalRowDTO,
  WfEvalRunDrift,
} from '../protocol'

import {
  evalResultDTO,
  evalRunSummary,
  evalSetSummary,
  runlessCellStats,
} from './eval-dto'
import {
  BadRequestError,
  NotFoundError,
  requireHook,
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
    c.logger.warn('[wf] eval drift lookup failed', err)
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
  | 'restoreEvalRow'
  | 'createEvalRun'
  | 'startEvalRun'
  | 'runDecisionEvalCell'
  | 'gradeEvalResult'
  | 'recordEvalFailure'
  | 'finalizeEvalRun'
  | 'cancelEvalRun'
  | 'listEvalRuns'
  | 'getEvalRun'
  | 'getEvalRunDrive'
  | 'saveEvalRunDrive'
> {
  return {
    listEvalSets: async (c) => {
      const rows = await listEvalSets(c.db, c.params)
      return rows.map((r) => evalSetSummary(r, Number(r.rowCount)))
    },

    getEvalSet: async (c) => {
      const { setId, includeArchived } = c.params
      const result = await getEvalSet(c.db, setId, { includeArchived })
      if (!result) {
        return null
      }
      const rows: WfEvalRowDTO[] = result.rows
      return {
        // Counted over live rows even when archived ones are included, so a
        // Goal's advertised size doesn't change depending on who asked.
        set: evalSetSummary(
          result.set,
          rows.filter((r) => !r.archived).length,
        ),
        rows,
      }
    },

    createEvalSet: async (c) => {
      // `targetKind` used to be defaulted to 'agent' here, which quietly
      // disagreed with the schema that has always REQUIRED it — the handler was
      // defending against a value the dispatcher could not let through.
      const { name, targetId, triggerKind, targetKind } = c.params
      const p = c.params
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
      const p = c.params
      const { setId } = p
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
          before && after
            ? changedEvalSetFields(before, after)
            : Object.keys(p),
        before,
        after,
        note: after?.name ?? before?.name ?? null,
      })
      return { ok: true }
    },

    deleteEvalSet: async (c) => {
      const { setId } = c.params
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
      const p = c.params
      const { setId, name } = p
      // A Sample carries the grading criteria and has no version history, so
      // the before-image here is the only way to see what a score was measured
      // against yesterday.
      const before = p.id ? ((await getEvalRow(c.db, p.id))?.row ?? null) : null
      // `input` / `tools` / `checks` are the one place a cast survives this
      // handler, and it is the honest kind: they are `PASSED_THROUGH` in the
      // schema table on purpose (their real schemas live in `engine/eval-schema`, and
      // `upsertEvalRow` runs them — `evalSampleInputSchema.parse`,
      // `parseEvalTools`, `checkTreeSchema.parse` — on the very next line it
      // executes). So the value is genuinely `unknown` here and genuinely
      // validated one call deeper; naming the shape twice is what this ticket
      // is removing everywhere else.
      const rowId = await upsertEvalRow(c.db, {
        id: p.id,
        setId,
        name,
        description: p.description,
        input: p.input as WfEvalRowDTO['input'],
        tools: p.tools as WfEvalRowDTO['tools'],
        checks: p.checks as WfEvalRowDTO['checks'],
        sortOrder: p.sortOrder,
      })
      const after = (await getEvalRow(c.db, rowId))?.row ?? null
      await c.change({
        entityKind: 'eval_row',
        entityId: rowId,
        parentId: setId,
        action: before ? 'update' : 'create',
        fields:
          before && after
            ? changedEvalRowFields(before, after)
            : ['input', 'checks'],
        before,
        after,
        note: name,
      })
      return { rowId }
    },

    deleteEvalRow: async (c) => {
      const { rowId } = c.params
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

    restoreEvalRow: async (c) => {
      const { rowId } = c.params
      // `includeArchived`: the row being restored is archived by definition, so
      // the default read would report it as missing and lose the before-image.
      const existing = await getEvalRow(c.db, rowId, { includeArchived: true })
      if (!existing) {
        throw new NotFoundError('Eval sample not found.')
      }
      await restoreEvalRow(c.db, rowId)
      await c.change({
        entityKind: 'eval_row',
        entityId: rowId,
        parentId: existing.row.setId,
        action: 'restore',
        fields: ['archived'],
        before: existing.row,
        after: { ...existing.row, archived: false },
        note: existing.row.name,
      })
      return { ok: true }
    },

    createEvalRun: async (c) => {
      const p = c.params
      const { setIds } = p
      if (setIds.length === 0) {
        throw new Error('createEvalRun requires at least one set id.')
      }
      // Validated on the way IN so a run is never created with a plan that
      // can't be read back — a run whose plan fails to parse is exactly the
      // stranded run this column exists to prevent.
      const plan = p.plan == null ? null : parseEvalPlan(p.plan)
      if (p.plan != null && !plan) {
        throw new BadRequestError('The eval plan is malformed.')
      }
      const evalRunId = await createEvalRun(c.db, {
        setIds,
        total: p.total,
        createdBy: c.ctx.userId,
        plan,
      })
      return { evalRunId }
    },

    getEvalRunDrive: async (c) => {
      const { evalRunId } = c.params
      const found = await getEvalRunDrive(c.db, evalRunId)
      if (!found) return null
      return {
        evalRunId,
        status: found.run.status,
        plan: parseEvalPlan(found.run.plan),
        driveState: parseEvalDriveState(found.run.driveState),
        // The cell identity of every result already written. This — not the
        // driver's memory — is what makes a tick safe to repeat: a cell with a
        // row is never started again, whoever started it the first time.
        settledKeys: found.cells.map(evalCellKey),
      }
    },

    saveEvalRunDrive: async (c) => {
      const p = c.params
      await saveEvalRunDrive(c.db, {
        evalRunId: p.evalRunId,
        driveState: parseEvalDriveState(p.driveState),
        // Releasing clears the heartbeat, which is what makes the run adoptable
        // again immediately rather than after a stale window this driver has no
        // reason to hold.
        heartbeatAt: p.release === true ? null : undefined,
      })
      return { ok: true }
    },

    startEvalRun: async (c) => {
      const startEvalRun = requireHook(
        opts.startEvalRun,
        'Eval runs are not configured for this host.',
      )
      // Matrix cell overrides — swap the target agent's model / system prompt for
      // this run. Absent → the agent's own saved model/prompt (the plain path).
      const cell = c.params
      const { evalRunId, rowId } = cell
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
        toolModes: invocation.toolModes,
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

    runDecisionEvalCell: async (c) => {
      // A decision cell, start to finish, in one call. There is no `wf_run`
      // here: a decision agent has no graph, so there is nothing to start, poll
      // or record steps against. What that buys is worth naming — a generation
      // agent's eval cell goes through a hidden wrapper workflow, a Durable
      // Object and a poll loop to produce one model call's worth of answer.
      const p = c.params
      const { evalRunId, rowId } = p
      const getDecider = opts.config.getDecider
      if (!getDecider) {
        throw new BadRequestError(
          'No decision provider is wired on this host (WfSdkConfig.getDecider), so a decision agent cannot be evaluated here.',
        )
      }
      const run = await getEvalRun(c.db, evalRunId)
      if (!run) {
        throw new NotFoundError('Eval run not found.')
      }
      if (run.run.status === 'queued') {
        await updateEvalRun(c.db, {
          evalRunId,
          status: 'running',
          startedAt: new Date(),
        })
      }
      const found = await getEvalRow(c.db, rowId)
      if (!found) {
        throw new NotFoundError('Eval sample not found.')
      }
      const { row, set } = found
      if (set.targetKind !== 'agent') {
        throw new BadRequestError(
          'This goal does not target an agent, so it has no decision agent to run.',
        )
      }
      const agent = await getAgent(c.db, set.targetId)
      if (!agent) {
        throw new NotFoundError('The goal’s target agent no longer exists.')
      }
      if (toAgentKind(agent.agent.kind) !== 'decision') {
        throw new BadRequestError(
          'This goal targets a generation agent; use startEvalRun for it.',
        )
      }

      // The draft override wins, then the Goal's pin, then latest published —
      // the same precedence `resolveEvalTarget` applies, minus the wrapper. A
      // pin that names nothing THROWS rather than floating: the frozen
      // snapshot records `targetVersion`, so a silent float would make the
      // stored result a lie about what was graded.
      let config: DecisionAgentConfig
      if (p.config) {
        config = decisionAgentConfigSchema.parse(p.config)
      } else {
        const version =
          set.targetVersion == null
            ? await latestAgentVersion(c.db, set.targetId)
            : await agentVersionByNumber(c.db, set.targetId, set.targetVersion)
        if (!version) {
          throw new BadRequestError(
            set.targetVersion == null
              ? `Decision agent ${set.targetId} has no published version to eval against.`
              : `This goal pins v${set.targetVersion} of agent ${set.targetId}, which has no published version ${set.targetVersion}. Repoint the goal at Latest, or at a version that exists.`,
          )
        }
        config = decisionAgentConfigSchema.parse(version.config)
      }
      // The matrix's model column, layered on top — the only axis a decision
      // sweep has. There is no prompt to A/B: the questions ARE the prompt, and
      // swapping them wholesale is a different agent, not a cell.
      if (p.modelId) config = { ...config, modelId: p.modelId }

      const { state, variables } = decisionInvocation(row.input)
      const env = await c.env()
      const result = await runDecisionAgent({
        config,
        state,
        variables,
        getDecider: (modelId) =>
          getDecider(modelId, { triggerKind: 'eval', env }),
      })

      // Graded off the SAME `{ verdict, because, answers }` object the
      // playground shows, with no steps — a decision agent visits no nodes and
      // calls no tools, so `node_visited` / `tool_called` checks in a tree
      // authored for a generation agent correctly fail rather than throw.
      const graded = await gradeRow({
        checks: row.checks,
        steps: [],
        output: result,
        getModel: (modelId) =>
          opts.config.getModel(modelId, { triggerKind: 'eval', env }),
        defaultJudgeModelId:
          opts.evalJudgeModelId ??
          (await opts.config.listModels({ env }))[0]?.id,
        getDecider: (modelId) => getDecider(modelId, { triggerKind: 'eval', env }),
        defaultDecisionModelId: config.modelId,
      })

      const snapshot = buildEvalSnapshot(row, set)
      const snapshotHash = await hashEvalSnapshot(snapshot)
      const record = {
        evalRunId,
        rowId,
        // No run to link. The report renders the cell from `snapshot` +
        // `checkResults` alone, which is what `recordEvalFailure` already
        // relies on for a cell that never started one.
        wfRunId: null,
        status: graded.status,
        score: graded.score,
        checkResults: graded.checkResults,
        error: graded.error?.slice(0, MAX_RECORDED_ERROR_CHARS) ?? null,
        snapshot,
        snapshotHash,
        modelId: p.modelId,
        promptLabel: undefined,
        promptBody: undefined,
        attempt: p.attempt,
        // The echoed id, not the one we asked with — `jev-latest` floats, and
        // this is the only place a report can see that it moved.
        answeredModelId: result.modelId ?? null,
        // The provider returns usage on every decision call and this cell has no
        // `wf_run` to park it on, so it is recorded here or it is lost. Already
        // summed across chunks by `runDecisionAgent` — a question set too big for
        // one request is still one cell and must report one bill.
        inputTokens: result.usage?.inputTokens ?? null,
        outputTokens: result.usage?.outputTokens ?? null,
      }
      const resultId = await insertEvalResult(c.db, record)
      return evalResultDTO(
        { ...record, id: resultId, createdAt: new Date() },
        // No run to load stats from — assembled from the usage just recorded, so
        // the cell reports its cost on the response that creates it rather than
        // only once the report is re-read.
        runlessCellStats(record, await loadModelPriceMap(c.db)),
      )
    },

    gradeEvalResult: async (c) => {
      // Matrix cell identity to stamp on the result — all absent for a plain run.
      const cell = c.params
      const { evalRunId, rowId, wfRunId } = cell
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
      const getModel: GradeModelFactory = (modelId) => {
        return opts.config.getModel(modelId, { triggerKind: 'eval', env })
      }
      // The caller's pin wins over the host's, which wins over "whatever sorts
      // first in the enabled catalog". That last fallback is why a pin matters:
      // the judge is the measuring instrument, so enabling a new model can
      // silently re-grade an entire suite, and the drift report — which watches
      // the sample and the target — would attribute the move to the agent.
      const defaultJudgeModelId =
        cell.judgeModelId ??
        opts.evalJudgeModelId ??
        (await opts.config.listModels({ env }))[0]?.id
      // The decision counterpart, for `decision_judge` checks. Both stay
      // undefined on a host with no decision provider, and `gradeDecisionJudge`
      // then reports that in the check's own error rather than failing the row
      // with something opaque.
      const getDecider: GradeDeciderFactory | undefined =
        opts.config.getDecider
          ? (modelId) => { return opts.config.getDecider!(modelId, { triggerKind: 'eval', env }) }
          : undefined
      const defaultDecisionModelId = opts.config.listDecisionModels
        ? (await opts.config.listDecisionModels({ env }))[0]?.id
        : undefined
      const graded = await gradeRow({
        checks: found.row.checks,
        steps,
        output: runResult.output,
        getModel,
        defaultJudgeModelId,
        getDecider,
        defaultDecisionModelId,
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
      const p = c.params
      const { evalRunId, rowId, error } = p
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
      const { evalRunId } = c.params
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

    cancelEvalRun: async (c) => {
      const { evalRunId } = c.params
      const found = await getEvalRun(c.db, evalRunId)
      if (!found) {
        throw new NotFoundError('Eval run not found.')
      }
      const cancelled = await cancelEvalRun(c.db, evalRunId)
      // Re-read rather than trust the write: the status predicate inside
      // `cancelEvalRun` means a run that finished between the two reads is NOT
      // cancelled, and the caller needs to be told what it actually is.
      const after = await getEvalRun(c.db, evalRunId)
      return {
        cancelled,
        status: after?.run.status ?? found.run.status,
        // The cells that already have a verdict. A cancelled sweep keeps them —
        // `total` minus this is what was called off, and the report shows the
        // difference as `pending`.
        settled: (after ?? found).results.length,
        total: (after ?? found).run.total,
      }
    },

    listEvalRuns: async (c) => {
      const rows = await listEvalRuns(c.db, c.params)
      return rows.map(evalRunSummary)
    },

    getEvalRun: async (c) => {
      const { evalRunId } = c.params
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
      // Cells with no run (decision cells) carry their own usage; price it with
      // the same table the run fold uses. Loaded unconditionally — it is memoized
      // per isolate and `loadRunStats` has already paid for it.
      const priceMap = await loadModelPriceMap(c.db)
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
        results: result.results.map((r) => {
          return evalResultDTO(
            r,
            r.wfRunId ? stats.get(r.wfRunId) : runlessCellStats(r, priceMap),
            previous.get(r.rowId)?.hash ?? null,
          )
        }),
        drift: await loadDrift(c, {
          previous,
          setIds: Array.isArray(result.run.setIds)
            ? (result.run.setIds as string[])
            : [],
          rowIds: [...new Set(result.results.map((r) => r.rowId))],
          targetId: firstSnapshot?.target.targetId ?? null,
          targetKind:
            firstSnapshot?.target.targetKind === 'workflow'
              ? 'workflow'
              : 'agent',
          until: result.run.createdAt,
        }),
      }
    },
  }
}
