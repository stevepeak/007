import { agentConfigSchema, agentInputVariables } from '../../engine/graph'
import {
  archiveAgent,
  countWorkflowsReferencingAgent,
  createAgent,
  discardAgentDraft,
  getAgent,
  getAgentVersionConfig,
  listAgentCalls,
  listAgentVersions,
  listAgents,
  listWorkflowsReferencingAgent,
  listWorkflowsReferencingAllAgents,
  parseStoredAgentConfig,
  publishAgent,
  setAgentVersionAiSummary,
  updateAgentDraft,
  updateAgentMeta,
} from '../../storage/data'
import type {
  AgentPreviewMessage,
  WfAgentDetail,
  WfAgentSummary,
} from '../protocol'

import { computeAgentChangeSummary } from './change-summary'
import {
  NotFoundError,
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
  | 'summarizeAgentChanges'
  | 'listAgentVersions'
  | 'getAgentVersion'
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
      const p = c.params as {
        changeNote?: string
        aiSummary?: { short: string; long: string } | null
      }
      // Read the outgoing config — the base for the diff, including a possible
      // background summary — before publishAgent bumps the latest pointer.
      const owner = await getAgent(c.db, agentId)
      if (!owner) {
        throw new NotFoundError('Agent not found')
      }
      const previousConfig = owner.currentVersion
        ? parseStoredAgentConfig(owner.currentVersion.config)
        : null
      const out = await publishAgent(c.db, {
        agentId,
        config,
        changeNote: p.changeNote,
        aiSummaryShort: p.aiSummary?.short,
        aiSummaryLong: p.aiSummary?.long,
        publishedBy: c.ctx.userId,
      })
      // Published before the summary was ready: generate + persist it in the
      // background so the response returns immediately. Only when the host
      // wired a scheduler — otherwise the summary stays null until a later
      // explicit summarizeAgentChanges call. `env` is resolved now, inside the
      // request scope, so the deferred work doesn't depend on request-bound
      // context that may be gone once the response is sent.
      if (!p.aiSummary && opts.waitUntil) {
        const env = await c.env()
        opts.waitUntil(
          (async () => {
            try {
              const summary = await computeAgentChangeSummary(opts, {
                previousConfig,
                nextConfig: config,
                ctx: c.ctx,
                req: c.req,
                env,
              })
              await setAgentVersionAiSummary(c.db, {
                versionId: out.versionId,
                short: summary.short,
                long: summary.long,
              })
            } catch (err) {
              console.error('[wf] background agent summary failed:', err)
            }
          })(),
        )
      }
      return out
    },

    summarizeAgentChanges: async (c) => {
      const agentId = str(c.params, 'agentId')
      const nextConfig = parseAgentConfig(c.params)
      const owner = await getAgent(c.db, agentId)
      if (!owner) {
        throw new NotFoundError('Agent not found')
      }
      const previousConfig = owner.currentVersion
        ? parseStoredAgentConfig(owner.currentVersion.config)
        : null
      return await computeAgentChangeSummary(opts, {
        previousConfig,
        nextConfig,
        ctx: c.ctx,
        req: c.req,
        env: await c.env(),
      })
    },

    getAgentVersion: async (c) => {
      const versionId = str(c.params, 'versionId')
      const v = await getAgentVersionConfig(c.db, versionId)
      if (!v) {
        return null
      }
      return { config: v.config, versionNumber: v.versionNumber }
    },

    listAgentVersions: async (c) => {
      const agentId = str(c.params, 'agentId')
      await requireAgentExists(c.db, agentId)
      const rows = await listAgentVersions(c.db, agentId)
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
