import {
  changedEntityMetaFields,
  createWorkflow,
  discardDraft,
  getVersionGraph,
  getWorkflow,
  listVersions,
  listWorkflowsWithStats,
  parseStoredGraph,
  saveVersion,
  setVersionAiSummary,
  updateDraft,
  updateWorkflow,
} from '../../storage/data'
import type {
  WfChangeSummary,
  WfWorkflowDetail,
  WfWorkflowSummary,
} from '../protocol'

import { computeChangeSummary } from './change-summary'
import {
  NotFoundError,
  parseGraph,
  requireExists,
  requireStr,
  toEpoch,
  type CreateWfSdkHandlersOptions,
  type WfHandlers,
} from './shared'

function workflowSummary(w: {
  id: string
  name: string
  description: string | null
  createdAt: Date
  archived: boolean
}): WfWorkflowSummary {
  return {
    id: w.id,
    name: w.name,
    description: w.description,
    createdAt: w.createdAt.getTime(),
    archived: w.archived,
  }
}

export function buildWorkflowHandlers<TDeps>(
  opts: CreateWfSdkHandlersOptions<TDeps>,
): Pick<
  WfHandlers,
  | 'listWorkflows'
  | 'getWorkflow'
  | 'createWorkflow'
  | 'updateDraft'
  | 'saveVersion'
  | 'summarizeChanges'
  | 'updateWorkflow'
  | 'discardDraft'
  | 'listVersions'
  | 'getVersion'
> {
  return {
    listWorkflows: async (c) => {
      const rows = await listWorkflowsWithStats(c.db)
      return rows.map((w) => ({
        ...workflowSummary(w),
        latestVersionNumber: w.latestVersionNumber,
        updatedAt: w.updatedAt,
        lastRunAt: w.lastRunAt,
        runCount: w.runCount,
        agents: w.agents,
        triggerKind: w.triggerKind,
      }))
    },

    getWorkflow: async (c) => {
      const workflowId = requireStr(c.params, 'workflowId')
      const result = await getWorkflow(c.db, workflowId)
      if (!result) {
        return null
      }
      const detail: WfWorkflowDetail = {
        workflow: workflowSummary(result.workflow),
        draft: result.draft
          ? { graph: parseStoredGraph(result.draft.graph) }
          : null,
        currentVersion: result.currentVersion
          ? {
              id: result.currentVersion.id,
              versionNumber: result.currentVersion.versionNumber,
              graph: parseStoredGraph(result.currentVersion.graph),
            }
          : null,
      }
      return detail
    },

    createWorkflow: async (c) => {
      const name = requireStr(c.params, 'name')
      const graph = parseGraph(c.params)
      const description = (c.params as { description?: string }).description
      return await createWorkflow(c.db, {
        name,
        description,
        createdBy: c.ctx.userId,
        graph,
      })
    },

    updateDraft: async (c) => {
      const workflowId = requireStr(c.params, 'workflowId')
      const graph = parseGraph(c.params)
      await requireExists(c.db, workflowId)
      await updateDraft(c.db, { workflowId, graph, lastEditedBy: c.ctx.userId })
      // The draft row is PK'd on the workflow id and overwritten on every save,
      // so this is the only trace a save happened. The graph itself stays out —
      // it is unbounded, and a published version already stores it immutably.
      await c.change({
        entityKind: 'workflow',
        entityId: workflowId,
        action: 'update',
        fields: ['draft'],
      })
      return { ok: true }
    },

    saveVersion: async (c) => {
      const workflowId = requireStr(c.params, 'workflowId')
      const graph = parseGraph(c.params)
      const p = c.params as {
        changeNote?: string
        aiSummary?: WfChangeSummary
      }
      // Capture the outgoing latest version's graph as the "previous" for a
      // possible background summary — before saveVersion bumps the latest
      // pointer.
      const owner = await getWorkflow(c.db, workflowId)
      if (!owner) {
        throw new NotFoundError('Workflow not found')
      }
      const previousGraph = owner.currentVersion
        ? parseStoredGraph(owner.currentVersion.graph)
        : null
      const out = await saveVersion(c.db, {
        workflowId,
        graph,
        changeNote: p.changeNote,
        aiSummaryShort: p.aiSummary?.short,
        aiSummaryLong: p.aiSummary?.long,
        publishedBy: c.ctx.userId,
      })
      // The graph is already immutable in wf_workflow_version — record the EVENT
      // and its note, never a second copy of the payload.
      await c.change({
        entityKind: 'workflow',
        entityId: workflowId,
        action: 'publish',
        fields: previousGraph ? ['graph'] : ['initial'],
        after: { versionId: out.versionId, versionNumber: out.versionNumber },
        note: p.changeNote ?? null,
      })

      // Published before the summary was ready: generate + persist it in the
      // background so the response returns immediately. Only when the host
      // wired a scheduler — otherwise the summary stays null until a later
      // explicit summarizeChanges call. `env` is resolved now, inside the
      // request scope, so the deferred work doesn't depend on request-bound
      // context that may be gone once the response is sent.
      if (!p.aiSummary && opts.waitUntil) {
        const env = await c.env()
        opts.waitUntil(
          (async () => {
            try {
              const summary = await computeChangeSummary(opts, {
                previousGraph,
                nextGraph: graph,
                ctx: c.ctx,
                req: c.req,
                env,
              })
              await setVersionAiSummary(c.db, {
                versionId: out.versionId,
                short: summary.short,
                long: summary.long,
              })
            } catch (err) {
              console.error('[wf] background summary failed:', err)
            }
          })(),
        )
      }
      return out
    },

    summarizeChanges: async (c) => {
      const workflowId = requireStr(c.params, 'workflowId')
      const nextGraph = parseGraph(c.params)
      const owner = await getWorkflow(c.db, workflowId)
      if (!owner) {
        throw new NotFoundError('Workflow not found')
      }
      const previousGraph = owner.currentVersion
        ? parseStoredGraph(owner.currentVersion.graph)
        : null
      return await computeChangeSummary(opts, {
        previousGraph,
        nextGraph,
        ctx: c.ctx,
        req: c.req,
        env: await c.env(),
      })
    },

    updateWorkflow: async (c) => {
      const workflowId = requireStr(c.params, 'workflowId')
      const p = c.params as {
        name?: string
        description?: string | null
        archived?: boolean
      }
      await requireExists(c.db, workflowId)
      // Metadata is unversioned — a rename leaves no trace anywhere else.
      const before = (await getWorkflow(c.db, workflowId))?.workflow ?? null
      await updateWorkflow(c.db, {
        workflowId,
        name: p.name,
        description: p.description,
        archived: p.archived,
      })
      const after = (await getWorkflow(c.db, workflowId))?.workflow ?? null
      await c.change({
        entityKind: 'workflow',
        entityId: workflowId,
        action: p.archived === true ? 'archive' : 'update',
        fields:
          before && after ? changedEntityMetaFields(before, after) : Object.keys(p),
        before,
        after,
        note: after?.name ?? null,
      })
      return { ok: true }
    },

    discardDraft: async (c) => {
      const workflowId = requireStr(c.params, 'workflowId')
      await requireExists(c.db, workflowId)
      await discardDraft(c.db, { workflowId })
      return { ok: true }
    },

    listVersions: async (c) => {
      const workflowId = requireStr(c.params, 'workflowId')
      await requireExists(c.db, workflowId)
      const rows = await listVersions(c.db, workflowId)
      return rows.map((v) => ({
        id: v.id,
        versionNumber: v.versionNumber,
        changeNote: v.changeNote,
        aiSummaryShort: v.aiSummaryShort,
        aiSummaryLong: v.aiSummaryLong,
        createdAt: v.createdAt.getTime(),
        publishedAt: toEpoch(v.publishedAt),
      }))
    },

    getVersion: async (c) => {
      const versionId = requireStr(c.params, 'versionId')
      const v = await getVersionGraph(c.db, versionId)
      if (!v) {
        return null
      }
      return {
        graph: v.graph,
        versionNumber: v.versionNumber,
      }
    },
  }
}
