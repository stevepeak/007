import { changedEntityMetaFields, changedFields } from '../../engine'
import { toAgentKind, type WfAgentKind } from '../../engine/agent-kind'
import { runDecisionAgent } from '../../engine/decision-agent'
import {
  decisionAgentConfigSchema,
  decisionAgentInputVariables,
} from '../../engine/decision-agent-schema'
import {
  agentConfigSchema,
  agentInputVariables,
  agentModelRequirements,
  type AgentConfig,
} from '../../engine/graph'
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
import type { WfDb } from '../../storage/client'
import type {
  AgentPreviewMessage,
  WfAgentDetail,
  WfAgentSummary,
  WfDecisionAgentSummary,
} from '../protocol'

import { computeAgentChangeSummary } from './change-summary'
import {
  BadRequestError,
  NotFoundError,
  parseAgentConfig,
  parseConfigOfKind,
  parseDecisionAgentConfig,
  parseStringRecord,
  requireAgentExists,
  requireHook,
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

/** The decision half of a summary, or null when the config won't parse. */
function decisionSummary(config: unknown): WfDecisionAgentSummary | null {
  const parsed = decisionAgentConfigSchema.safeParse(config)
  if (!parsed.success) return null
  const cfg = parsed.data
  return {
    questionCount: cfg.questions.length,
    questionIds: cfg.questions.map((q) => q.id),
    verdicts: cfg.verdicts,
    inputVariables: decisionAgentInputVariables(cfg),
  }
}

function agentSummary(
  a: {
    id: string
    name: string
    kind?: string | null
    description: string | null
    icon: string | null
    color: string | null
    createdAt: Date
  },
  config?: unknown,
  workflows: { id: string; name: string }[] = [],
  latestVersionNumber: number | null = null,
): WfAgentSummary {
  const kind = toAgentKind(a.kind)
  // `config` is an untyped JSON column; parse it defensively so a malformed row
  // degrades to "no variables/output" rather than throwing the whole listing.
  // A decision agent's config never satisfies `agentConfigSchema`, which is why
  // the parse is gated on the kind rather than tried and shrugged off — a
  // `safeParse` that always fails would silently blank half the card.
  const parsed =
    config && kind === 'generation' ? agentConfigSchema.safeParse(config) : null
  const cfg = parsed?.success ? parsed.data : null
  const decision = kind === 'decision' && config ? decisionSummary(config) : null
  return {
    id: a.id,
    name: a.name,
    kind,
    description: a.description,
    icon: a.icon,
    color: a.color,
    createdAt: a.createdAt.getTime(),
    // The union across BOTH prompts — a variable used only in the user message is
    // just as much a required node binding as one in the system prompt.
    inputVariables: cfg
      ? agentInputVariables(cfg)
      : (decision?.inputVariables ?? []),
    output: cfg?.output ?? null,
    // `modelId` is the one field both shapes happen to share by name, so it is
    // read from whichever config this agent actually has — a decision agent
    // that reported a null model would look unpublished on every card.
    modelId: cfg?.modelId ?? decisionModelId(kind, config),
    toolIds: cfg?.toolIds ?? [],
    modelRequirements: cfg ? agentModelRequirements(cfg) : null,
    inputKind: cfg?.inputKind ?? 'task',
    latestVersionNumber,
    workflows,
    decision,
  }
}

/**
 * The stored kind of one agent — read before a write, because the kind is what
 * says which schema the incoming config is checked against and the client is
 * not trusted to say. One indexed lookup on a path that is already doing
 * several.
 */
async function agentKindOf(db: WfDb, agentId: string): Promise<WfAgentKind> {
  return toAgentKind((await getAgent(db, agentId))?.agent.kind)
}

/** A decision config's model id, read without committing to the whole parse. */
function decisionModelId(kind: WfAgentKind, config: unknown): string | null {
  if (kind !== 'decision' || !config || typeof config !== 'object') return null
  const modelId = (config as { modelId?: unknown }).modelId
  return typeof modelId === 'string' && modelId.length > 0 ? modelId : null
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
  | 'runDecisionPreview'
  | 'runToolPreview'
> {
  return {
    listAgents: async (c) => {
      const rows = await listAgents(c.db)
      const byAgent = await listWorkflowsReferencingAllAgents(c.db)
      return rows.map((r) => {
        return agentSummary(
          r,
          r.config,
          byAgent.get(r.id) ?? [],
          r.latestVersionNumber,
        )
      })
    },

    getAgent: async (c) => {
      const { agentId } = c.params
      const result = await getAgent(c.db, agentId)
      if (!result) {
        return null
      }
      // The referencing workflows, for real. This used to be a hard-coded `[]`,
      // which is worse than omitting the field: `listAgents` populates it, so
      // asking about ONE agent — the natural place to ask "what breaks if I
      // change this?" — answered "nothing references it" with the same shape a
      // true answer has. Blast radius is the first question before editing a
      // draft and the precondition for any publish or archive.
      const workflows = await listWorkflowsReferencingAgent(c.db, { agentId })
      const kind = toAgentKind(result.agent.kind)
      const detail: WfAgentDetail = {
        agent: agentSummary(
          result.agent,
          result.currentVersion?.config,
          workflows,
          result.currentVersion?.versionNumber ?? null,
        ),
        draft: result.draft
          ? { config: parseConfigOfKind(kind, result.draft.config) }
          : null,
        currentVersion: result.currentVersion
          ? {
              id: result.currentVersion.id,
              versionNumber: result.currentVersion.versionNumber,
              config: parseConfigOfKind(kind, result.currentVersion.config),
            }
          : null,
      }
      return detail
    },

    createAgent: async (c) => {
      const p = c.params
      // The kind is fixed HERE and nowhere else — there is no update path for
      // it, so the config is checked against the schema this choice names and
      // every later write is checked against the stored value.
      const kind = toAgentKind(p.kind)
      return await createAgent(c.db, {
        name: p.name,
        kind,
        description: p.description,
        icon: p.icon,
        color: p.color,
        createdBy: c.ctx.userId,
        config: parseConfigOfKind(kind, p.config),
      })
    },

    updateAgentDraft: async (c) => {
      const { agentId } = c.params
      await requireAgentExists(c.db, agentId)
      const config = parseConfigOfKind(
        await agentKindOf(c.db, agentId),
        c.params.config,
      )
      await updateAgentDraft(c.db, {
        agentId,
        config,
        lastEditedBy: c.ctx.userId,
      })
      // The draft row is PK'd on the agent id and overwritten on every save, so
      // this is the only trace that a save happened at all. The payload stays
      // out — an unpublished draft is not worth a config-sized row per keystroke
      // burst, and the fields say enough to place it on a timeline.
      await c.change({
        entityKind: 'agent',
        entityId: agentId,
        action: 'update',
        fields: ['draft'],
      })
      return { ok: true }
    },

    publishAgent: async (c) => {
      const p = c.params
      const { agentId } = p
      // Read the outgoing config — the base for the diff, including a possible
      // background summary — before publishAgent bumps the latest pointer.
      const owner = await getAgent(c.db, agentId)
      if (!owner) {
        throw new NotFoundError('Agent not found')
      }
      const kind = toAgentKind(owner.agent.kind)
      const config = parseConfigOfKind(kind, p.config)
      // The AI change summary and the field-level diff are both written
      // against `AgentConfig`'s field names, so they only apply to a
      // generation agent. A decision agent publishes with the change LOG
      // entry and its change note, and no generated summary — summarizing a
      // rules table is a different job from summarizing a prompt, and
      // pretending otherwise would produce confident nonsense.
      const previousConfig =
        kind === 'generation' && owner.currentVersion
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
      // A publish already stores its config immutably in wf_agent_version, so
      // the log records the EVENT and what moved — never a second copy.
      await c.change({
        entityKind: 'agent',
        entityId: agentId,
        action: 'publish',
        fields:
          previousConfig && kind === 'generation'
            ? changedFields(previousConfig, config as AgentConfig)
            : ['initial'],
        after: { versionId: out.versionId, versionNumber: out.versionNumber },
        note: p.changeNote ?? null,
      })

      // Published before the summary was ready: generate + persist it in the
      // background so the response returns immediately. Only when the host
      // wired a scheduler — otherwise the summary stays null until a later
      // explicit summarizeAgentChanges call. `env` is resolved now, inside the
      // request scope, so the deferred work doesn't depend on request-bound
      // context that may be gone once the response is sent.
      if (!p.aiSummary && opts.waitUntil && kind === 'generation') {
        const env = await c.env()
        opts.waitUntil(
          (async () => {
            try {
              const summary = await computeAgentChangeSummary(opts, {
                previousConfig,
                nextConfig: config as AgentConfig,
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
              c.logger.error('[wf] background agent summary failed', err)
            }
          })(),
        )
      }
      return out
    },

    summarizeAgentChanges: async (c) => {
      const { agentId } = c.params
      const owner = await getAgent(c.db, agentId)
      if (!owner) {
        throw new NotFoundError('Agent not found')
      }
      if (toAgentKind(owner.agent.kind) !== 'generation') {
        // The summarizer's prompt is written around a system prompt, tools and
        // an output contract. Pointed at a question set it would describe
        // fields that aren't there — so this says no rather than guessing.
        throw new BadRequestError(
          'Change summaries are only generated for generation agents. Write the change note yourself.',
        )
      }
      const nextConfig = parseAgentConfig(c.params.config)
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
      const v = await getAgentVersionConfig(c.db, c.params.versionId)
      if (!v) {
        return null
      }
      return { config: v.config, kind: v.kind, versionNumber: v.versionNumber }
    },

    listAgentVersions: async (c) => {
      const { agentId } = c.params
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
      const p = c.params
      const { agentId } = p
      await requireAgentExists(c.db, agentId)
      // Metadata is unversioned — a rename leaves no trace anywhere else, so
      // read the before-image while it still exists.
      const before = (await getAgent(c.db, agentId))?.agent ?? null
      await updateAgentMeta(c.db, {
        agentId,
        name: p.name,
        description: p.description,
        icon: p.icon,
        color: p.color,
      })
      const after = (await getAgent(c.db, agentId))?.agent ?? null
      await c.change({
        entityKind: 'agent',
        entityId: agentId,
        action: 'update',
        fields:
          before && after
            ? changedEntityMetaFields(before, after)
            : Object.keys(p),
        before,
        after,
        note: after?.name ?? null,
      })
      return { ok: true }
    },

    discardAgentDraft: async (c) => {
      const { agentId } = c.params
      await requireAgentExists(c.db, agentId)
      await discardAgentDraft(c.db, { agentId })
      return { ok: true }
    },

    countAgentReferences: async (c) => {
      const { agentId } = c.params
      await requireAgentExists(c.db, agentId)
      const workflows = await countWorkflowsReferencingAgent(c.db, { agentId })
      return { workflows }
    },

    listAgentReferences: async (c) => {
      const { agentId } = c.params
      await requireAgentExists(c.db, agentId)
      const workflows = await listWorkflowsReferencingAgent(c.db, { agentId })
      return { workflows }
    },

    archiveAgent: async (c) => {
      const { agentId } = c.params
      await requireAgentExists(c.db, agentId)
      const before = (await getAgent(c.db, agentId))?.agent ?? null
      await archiveAgent(c.db, { agentId })
      await c.change({
        entityKind: 'agent',
        entityId: agentId,
        action: 'archive',
        fields: ['archived'],
        before,
        note: before?.name ?? null,
      })
      return { ok: true }
    },

    listAgentCalls: async (c) => {
      const { agentId, limit } = c.params
      await requireAgentExists(c.db, agentId)
      return await listAgentCalls(c.db, { agentId, limit })
    },

    runAgentPreview: async (c) => {
      const runAgentPreview = requireHook(
        opts.runAgentPreview,
        'The agent playground is not configured on this host.',
      )
      // `runAgentPreview` is `NO_INPUT` in the schema table on purpose: the
      // payload is one `AgentPreviewInput` the runner validates as a unit. So
      // this is the one handler that still reads its own params, by design.
      const p = c.params as {
        config?: unknown
        input?: unknown
        promptVariables?: unknown
        liveToolIds?: unknown
        messages?: unknown
        context?: unknown
      }
      const config = parseAgentConfig(p.config)
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

    runDecisionPreview: async (c) => {
      // Pure SDK — no host hook. A decision agent is one call through the
      // config's own `getDecider` seam, so there is no tool registry to build,
      // no run scope to assemble and nothing live to touch. That is also why
      // this preview has none of `runAgentPreview`'s safety apparatus: there
      // is no simulated-vs-live axis when nothing executes but the provider.
      const getDecider = opts.config.getDecider
      if (!getDecider) {
        throw new BadRequestError(
          'No decision provider is wired on this host (WfSdkConfig.getDecider), so a decision agent cannot run here.',
        )
      }
      // One `DecisionPreviewInput`, validated as a unit — `state` is any JSON
      // value, so the schema table passes the whole payload through.
      const p = c.params as {
        config?: unknown
        state?: unknown
        variables?: unknown
      }
      const config = parseDecisionAgentConfig(p.config)
      const env = await c.env()
      return await runDecisionAgent({
        config,
        state: p.state,
        variables: parseStringRecord(p.variables),
        getDecider: (modelId) =>
          getDecider(modelId, { triggerKind: 'preview', env }),
      })
    },

    runToolPreview: async (c) => {
      const runToolPreview = requireHook(
        opts.runToolPreview,
        'The tool playground is not configured on this host.',
      )
      const { toolId, args } = c.params
      // Guard against calling an unregistered tool before we build real deps.
      if (!opts.config.toolRegistry.has(toolId)) {
        throw new Error(`Tool '${toolId}' is not registered.`)
      }
      return await runToolPreview({
        toolId,
        args,
        context: c.params.context ?? {},
        ctx: c.ctx,
        req: c.req,
      })
    },
  }
}
