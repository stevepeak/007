import { agentConfigSchema, inferPromptVariables } from '../../engine/graph'
import {
  archiveAgent,
  countWorkflowsReferencingAgent,
  createAgent,
  discardAgentDraft,
  getAgent,
  listAgentVersions,
  listAgents,
  listWorkflowsReferencingAgent,
  listWorkflowsReferencingAllAgents,
  publishAgent,
  updateAgentDraft,
  updateAgentMeta,
} from '../../storage/data'
import type { WfAgentDetail, WfAgentSummary } from '../protocol'

import {
  parseAgentConfig,
  parseStringRecord,
  requireAgentExists,
  requireHook,
  str,
  toEpoch,
  type CreateWfSdkHandlersOptions,
  type WfHandlers,
} from './shared'

function agentSummary(
  a: {
    id: string
    name: string
    description: string | null
    icon: string | null
    color: string | null
    createdAt: Date
  },
  config?: unknown,
  workflows: { id: string; name: string }[] = [],
): WfAgentSummary {
  // `config` is an untyped JSON column; parse it defensively so a malformed row
  // degrades to "no variables/output" rather than throwing the whole listing.
  const parsed = config ? agentConfigSchema.safeParse(config) : null
  const cfg = parsed?.success ? parsed.data : null
  return {
    id: a.id,
    name: a.name,
    description: a.description,
    icon: a.icon,
    color: a.color,
    createdAt: a.createdAt.getTime(),
    inputVariables: cfg ? inferPromptVariables(cfg.prompt) : [],
    output: cfg?.output ?? null,
    modelId: cfg?.modelId ?? null,
    toolIds: cfg?.toolIds ?? [],
    workflows,
  }
}

export function buildAgentHandlers<TDeps>(
  opts: CreateWfSdkHandlersOptions<TDeps>,
): Pick<
  WfHandlers,
  | 'listAgents'
  | 'getAgent'
  | 'createAgent'
  | 'updateAgentDraft'
  | 'publishAgent'
  | 'listAgentVersions'
  | 'updateAgentMeta'
  | 'discardAgentDraft'
  | 'countAgentReferences'
  | 'listAgentReferences'
  | 'archiveAgent'
  | 'runAgentPreview'
  | 'runToolPreview'
> {
  return {
    listAgents: async (c) => {
      const rows = await listAgents(c.db)
      const byAgent = await listWorkflowsReferencingAllAgents(c.db)
      return rows.map((r) => agentSummary(r, r.config, byAgent.get(r.id) ?? []))
    },

    getAgent: async (c) => {
      const agentId = str(c.params, 'agentId')
      const result = await getAgent(c.db, agentId)
      if (!result) {
        return null
      }
      const detail: WfAgentDetail = {
        agent: agentSummary(result.agent, result.currentVersion?.config),
        draft: result.draft
          ? { config: agentConfigSchema.parse(result.draft.config) }
          : null,
        currentVersion: result.currentVersion
          ? {
              id: result.currentVersion.id,
              versionNumber: result.currentVersion.versionNumber,
              config: agentConfigSchema.parse(result.currentVersion.config),
            }
          : null,
      }
      return detail
    },

    createAgent: async (c) => {
      const name = str(c.params, 'name')
      const config = parseAgentConfig(c.params)
      const p = c.params as {
        description?: string
        icon?: string
        color?: string
      }
      return await createAgent(c.db, {
        name,
        description: p.description,
        icon: p.icon,
        color: p.color,
        createdBy: c.ctx.userId,
        config,
      })
    },

    updateAgentDraft: async (c) => {
      const agentId = str(c.params, 'agentId')
      const config = parseAgentConfig(c.params)
      await requireAgentExists(c.db, agentId)
      await updateAgentDraft(c.db, {
        agentId,
        config,
        lastEditedBy: c.ctx.userId,
      })
      return { ok: true }
    },

    publishAgent: async (c) => {
      const agentId = str(c.params, 'agentId')
      const config = parseAgentConfig(c.params)
      const changeNote = (c.params as { changeNote?: string }).changeNote
      await requireAgentExists(c.db, agentId)
      return await publishAgent(c.db, {
        agentId,
        config,
        changeNote,
        publishedBy: c.ctx.userId,
      })
    },

    listAgentVersions: async (c) => {
      const agentId = str(c.params, 'agentId')
      await requireAgentExists(c.db, agentId)
      const rows = await listAgentVersions(c.db, agentId)
      return rows.map((v) => ({
        id: v.id,
        versionNumber: v.versionNumber,
        changeNote: v.changeNote,
        createdAt: v.createdAt.getTime(),
        publishedAt: toEpoch(v.publishedAt),
      }))
    },

    updateAgentMeta: async (c) => {
      const agentId = str(c.params, 'agentId')
      await requireAgentExists(c.db, agentId)
      const p = c.params as {
        name?: string
        description?: string
        icon?: string
        color?: string
      }
      await updateAgentMeta(c.db, {
        agentId,
        name: p.name,
        description: p.description,
        icon: p.icon,
        color: p.color,
      })
      return { ok: true }
    },

    discardAgentDraft: async (c) => {
      const agentId = str(c.params, 'agentId')
      await requireAgentExists(c.db, agentId)
      await discardAgentDraft(c.db, { agentId })
      return { ok: true }
    },

    countAgentReferences: async (c) => {
      const agentId = str(c.params, 'agentId')
      await requireAgentExists(c.db, agentId)
      const workflows = await countWorkflowsReferencingAgent(c.db, { agentId })
      return { workflows }
    },

    listAgentReferences: async (c) => {
      const agentId = str(c.params, 'agentId')
      await requireAgentExists(c.db, agentId)
      const workflows = await listWorkflowsReferencingAgent(c.db, { agentId })
      return { workflows }
    },

    archiveAgent: async (c) => {
      const agentId = str(c.params, 'agentId')
      await requireAgentExists(c.db, agentId)
      await archiveAgent(c.db, { agentId })
      return { ok: true }
    },

    runAgentPreview: async (c) => {
      const runAgentPreview = requireHook(
        opts.runAgentPreview,
        'The agent playground is not configured on this host.',
      )
      const config = parseAgentConfig(c.params)
      const p = c.params as { input?: unknown; promptVariables?: unknown }
      const input = typeof p.input === 'string' ? p.input : ''
      const promptVariables = parseStringRecord(p.promptVariables)
      if (!input && Object.keys(promptVariables).length === 0) {
        throw new Error('Provide a test input or fill in the prompt variables.')
      }
      return await runAgentPreview({
        config,
        input,
        promptVariables,
        ctx: c.ctx,
        req: c.req,
      })
    },

    runToolPreview: async (c) => {
      const runToolPreview = requireHook(
        opts.runToolPreview,
        'The tool playground is not configured on this host.',
      )
      const toolId = str(c.params, 'toolId')
      // Guard against calling an unregistered tool before we build real deps.
      if (!opts.config.toolRegistry.has(toolId)) {
        throw new Error(`Tool '${toolId}' is not registered.`)
      }
      const rawArgs = (c.params as { args?: unknown }).args
      const args =
        rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
          ? (rawArgs as Record<string, unknown>)
          : {}
      const context = parseStringRecord(
        (c.params as { context?: unknown }).context,
      )
      return await runToolPreview({
        toolId,
        args,
        context,
        ctx: c.ctx,
        req: c.req,
      })
    },
  }
}
