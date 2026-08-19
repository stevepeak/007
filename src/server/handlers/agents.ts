import { agentConfigSchema, agentInputVariables } from '../../engine/graph'
import {
  archiveAgent,
  countWorkflowsReferencingAgent,
  createAgent,
  discardAgentDraft,
  getAgent,
  listAgentCalls,
  listAgentVersions,
  listAgents,
  listWorkflowsReferencingAgent,
  listWorkflowsReferencingAllAgents,
  publishAgent,
  updateAgentDraft,
  updateAgentMeta,
} from '../../storage/data'
import type {
  AgentPreviewMessage,
  WfAgentDetail,
  WfAgentSummary,
} from '../protocol'

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

/**
 * Reads the playground's scratch conversation off the wire. Each entry must be a
 * `{ role, text }` pair with a known role; anything else is skipped, so a
 * malformed history degrades the run's context instead of failing it.
 */
function parsePreviewMessages(value: unknown): AgentPreviewMessage[] {
  if (!Array.isArray(value)) return []
  const out: AgentPreviewMessage[] = []
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue
    const { role, text } = raw as { role?: unknown; text?: unknown }
    if (role !== 'user' && role !== 'assistant') continue
    if (typeof text !== 'string' || text.trim().length === 0) continue
    out.push({ role, text })
  }
  return out
}

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
  latestVersionNumber: number | null = null,
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
    // The union across BOTH prompts — a variable used only in the user message is
    // just as much a required node binding as one in the system prompt.
    inputVariables: cfg ? agentInputVariables(cfg) : [],
    output: cfg?.output ?? null,
    modelId: cfg?.modelId ?? null,
    toolIds: cfg?.toolIds ?? [],
    inputKind: cfg?.inputKind ?? 'task',
    latestVersionNumber,
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
  | 'listAgentCalls'
  | 'runAgentPreview'
  | 'runToolPreview'
> {
  return {
    listAgents: async (c) => {
      const rows = await listAgents(c.db)
      const byAgent = await listWorkflowsReferencingAllAgents(c.db)
      return rows.map((r) =>
        agentSummary(
          r,
          r.config,
          byAgent.get(r.id) ?? [],
          r.latestVersionNumber,
        ),
      )
    },

    getAgent: async (c) => {
      const agentId = str(c.params, 'agentId')
      const result = await getAgent(c.db, agentId)
      if (!result) {
        return null
      }
      const detail: WfAgentDetail = {
        agent: agentSummary(
          result.agent,
          result.currentVersion?.config,
          [],
          result.currentVersion?.versionNumber ?? null,
        ),
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

    listAgentCalls: async (c) => {
      const agentId = str(c.params, 'agentId')
      await requireAgentExists(c.db, agentId)
      const p = c.params as { limit?: number }
      return await listAgentCalls(c.db, { agentId, limit: p.limit })
    },

    runAgentPreview: async (c) => {
      const runAgentPreview = requireHook(
        opts.runAgentPreview,
        'The agent playground is not configured on this host.',
      )
      const config = parseAgentConfig(c.params)
      const p = c.params as {
        input?: unknown
        promptVariables?: unknown
        liveToolIds?: unknown
        messages?: unknown
        context?: unknown
      }
      const input = typeof p.input === 'string' ? p.input : ''
      const promptVariables = parseStringRecord(p.promptVariables)
      if (!input && Object.keys(promptVariables).length === 0) {
        throw new Error('Provide a test input or fill in the prompt variables.')
      }
      // Prior turns for a conversational agent. Anything malformed is dropped
      // rather than rejected — a broken history should not fail the run, it
      // should just leave the agent with less context.
      const messages = parsePreviewMessages(p.messages)
      // Ambient run scope for whatever is running live (client org, chat
      // thread). Opaque here — only the host knows how these map onto a run.
      const context = parseStringRecord(p.context)
      // Which tools run for real. Anything not listed is simulated, so a
      // malformed/absent field degrades to the safe all-simulated run.
      const liveToolIds = Array.isArray(p.liveToolIds)
        ? p.liveToolIds.filter((id): id is string => typeof id === 'string')
        : []
      return await runAgentPreview({
        config,
        input,
        promptVariables,
        liveToolIds,
        messages,
        context,
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
