import { asc, desc, eq, inArray } from 'drizzle-orm'

import type {
  AgentUsageRef,
  ModelCapabilities,
  ModelCatalog,
  ModelCatalogEntry,
  ModelOption,
  ModelProvider,
  ModelProviderKind,
  ModelProviderStatus,
} from '../../engine/config'
import type { WfDb } from '../client'
import {
  wfAgent,
  wfAgentDraft,
  wfAgentVersion,
  wfModel,
  wfModelProvider,
} from '../schema'

// Data-access for the model catalog: providers, per-model rows + pricing, the
// admin catalog view, enablement toggles, and agent→model usage. The catalog is
// a single GLOBAL set (no tenancy), like workflows and agents.
// ---------------------------------------------------------------------------
// Model catalog + providers
// ---------------------------------------------------------------------------
//
// The platform's model catalog is a single GLOBAL set (no tenancy, like the
// rest of `wf_*`). A model's `id` is the composite `providerId:modelId`; the
// pickers see only ENABLED models via `listEnabledModels`, while the admin page
// reads the whole catalog via `getModelCatalog`. `upsertModels` is the refresh
// write — it preserves the `enabled` flag so a refresh never re-hides models the
// user turned on, and never auto-enables the 300+ new ones.

type WfModelRow = typeof wfModel.$inferSelect

/** Assemble the capabilities object from a row, omitted when nothing is set. */
function rowCapabilities(r: WfModelRow): ModelCapabilities | undefined {
  if (
    !r.supportsTools &&
    !r.supportsReasoning &&
    !r.supportsStructuredOutput &&
    !r.supportsVision
  ) {
    return undefined
  }
  return {
    tools: r.supportsTools,
    reasoning: r.supportsReasoning,
    structuredOutput: r.supportsStructuredOutput,
    vision: r.supportsVision,
  }
}

/** Map a stored row to the picker-facing {@link ModelOption} (enabled subset). */
function rowToModelOption(r: WfModelRow): ModelOption {
  return {
    id: r.id,
    label: r.label,
    providerId: r.providerId,
    costPerMTok: r.costPerMTok ?? undefined,
    tokensPerSec: r.tokensPerSec ?? undefined,
    capabilities: rowCapabilities(r),
  }
}

/** Map a stored row to the admin-page {@link ModelCatalogEntry} (full metadata). */
function rowToCatalogEntry(r: WfModelRow): ModelCatalogEntry {
  return {
    id: r.id,
    modelId: r.modelId,
    label: r.label,
    providerId: r.providerId,
    vendor: r.vendor ?? undefined,
    enabled: r.enabled,
    costPerMTok: r.costPerMTok ?? undefined,
    promptPricePerMTok: r.promptPricePerMTok ?? undefined,
    completionPricePerMTok: r.completionPricePerMTok ?? undefined,
    contextLength: r.contextLength ?? undefined,
    tokensPerSec: r.tokensPerSec ?? undefined,
    releasedAt: r.releasedAt ? r.releasedAt.getTime() : undefined,
    capabilities: rowCapabilities(r),
    raw: r.raw ?? undefined,
  }
}

/**
 * The enabled models, as the pickers consume them. Empty until the platform
 * enables some (the caller falls back to the host's static list when empty).
 */
export async function listEnabledModels(db: WfDb): Promise<ModelOption[]> {
  const rows = await db
    .select()
    .from(wfModel)
    .where(eq(wfModel.enabled, true))
    .orderBy(asc(wfModel.vendor), asc(wfModel.label))
  return rows.map(rowToModelOption)
}

/** The wired-up providers, as the pickers' grouping consumes them. */
export async function listModelProviders(db: WfDb): Promise<ModelProvider[]> {
  const rows = await db
    .select()
    .from(wfModelProvider)
    .orderBy(asc(wfModelProvider.label))
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    kind: r.kind as ModelProviderKind,
    note: r.note ?? undefined,
  }))
}

/**
 * The provider status + full catalog (enabled and disabled) for the Models admin
 * page. `usage` (which agents reference each model) is assembled separately by
 * {@link getModelUsage} and merged by the handler, so this stays a pure DB read.
 */
export async function getModelCatalog(
  db: WfDb,
): Promise<Pick<ModelCatalog, 'providers' | 'models'>> {
  const [providerRows, modelRows] = await Promise.all([
    db.select().from(wfModelProvider).orderBy(asc(wfModelProvider.label)),
    db.select().from(wfModel).orderBy(asc(wfModel.vendor), asc(wfModel.label)),
  ])
  const models = modelRows.map(rowToCatalogEntry)
  const providers: ModelProviderStatus[] = providerRows.map((p) => {
    const of = models.filter((m) => m.providerId === p.id)
    return {
      id: p.id,
      label: p.label,
      kind: p.kind as ModelProviderKind,
      note: p.note ?? undefined,
      enabled: p.enabled,
      lastRefreshedAt: p.lastRefreshedAt ? p.lastRefreshedAt.getTime() : null,
      modelCount: of.length,
      enabledCount: of.filter((m) => m.enabled).length,
    }
  })
  return { providers, models }
}

/**
 * Which agents currently reference each model, keyed by CATALOG model id. An
 * agent counts if either its latest published version OR its live draft names
 * the model. Agent `modelId`s may be composite (`provider:model`) or bare
 * (legacy) — both are resolved to the catalog id by matching `wf_model.id` or
 * `wf_model.model_id`, so no provider prefix is hardcoded here.
 */
export async function getModelUsage(
  db: WfDb,
): Promise<Record<string, AgentUsageRef[]>> {
  const agents = await db.select().from(wfAgent)
  if (agents.length === 0) return {}

  // Map every known id form → canonical catalog id.
  const modelRows = await db
    .select({ id: wfModel.id, modelId: wfModel.modelId })
    .from(wfModel)
  const canonical = new Map<string, string>()
  for (const r of modelRows) {
    canonical.set(r.id, r.id)
    if (!canonical.has(r.modelId)) canonical.set(r.modelId, r.id)
  }

  const agentIds = agents.map((a) => a.id)
  const versions = await db
    .select()
    .from(wfAgentVersion)
    .where(inArray(wfAgentVersion.agentId, agentIds))
    .orderBy(desc(wfAgentVersion.versionNumber))
  const latestConfig = new Map<string, unknown>()
  for (const v of versions) {
    if (!latestConfig.has(v.agentId)) latestConfig.set(v.agentId, v.config)
  }
  const drafts = await db
    .select()
    .from(wfAgentDraft)
    .where(inArray(wfAgentDraft.agentId, agentIds))
  const draftConfig = new Map(drafts.map((d) => [d.agentId, d.config]))

  const modelIdOf = (config: unknown): string | undefined => {
    const mid = (config as { modelId?: unknown } | null | undefined)?.modelId
    return typeof mid === 'string' && mid ? mid : undefined
  }

  const usage: Record<string, AgentUsageRef[]> = {}
  const seen = new Set<string>() // `${catalogId}|${agentId}`
  for (const a of agents) {
    const ref: AgentUsageRef = {
      id: a.id,
      name: a.name,
      icon: a.icon,
      color: a.color,
    }
    const ids = new Set<string>()
    for (const cfg of [latestConfig.get(a.id), draftConfig.get(a.id)]) {
      const mid = modelIdOf(cfg)
      if (mid) ids.add(mid)
    }
    for (const mid of ids) {
      const catId = canonical.get(mid)
      if (!catId) continue
      const key = `${catId}|${a.id}`
      if (seen.has(key)) continue
      seen.add(key)
      ;(usage[catId] ??= []).push(ref)
    }
  }
  return usage
}

/**
 * Persist a provider's freshly-fetched catalog. New models are ALWAYS inserted
 * DISABLED — the admin opts them in explicitly — and existing rows keep their
 * `enabled` flag while their metadata refreshes. A refresh therefore never
 * auto-enables anything (a fresh DB starts with zero enabled models) and never
 * re-hides a model the user turned on. Returns the number of entries written.
 */
export async function upsertModels(
  db: WfDb,
  providerId: string,
  entries: Omit<ModelCatalogEntry, 'enabled'>[],
): Promise<number> {
  if (entries.length === 0) return 0
  const now = new Date()
  for (const e of entries) {
    const caps: ModelCapabilities = e.capabilities ?? {}
    // `enabled` is intentionally absent from `meta`, so the conflict path never
    // touches it — a refresh preserves the user's curation.
    const meta = {
      providerId,
      modelId: e.modelId,
      label: e.label,
      vendor: e.vendor ?? null,
      costPerMTok: e.costPerMTok ?? null,
      promptPricePerMTok: e.promptPricePerMTok ?? null,
      completionPricePerMTok: e.completionPricePerMTok ?? null,
      contextLength: e.contextLength ?? null,
      tokensPerSec: e.tokensPerSec ?? null,
      releasedAt: e.releasedAt != null ? new Date(e.releasedAt) : null,
      supportsTools: caps.tools ?? false,
      supportsReasoning: caps.reasoning ?? false,
      supportsStructuredOutput: caps.structuredOutput ?? false,
      supportsVision: caps.vision ?? false,
      raw: e.raw ?? null,
      updatedAt: now,
    }
    await db
      .insert(wfModel)
      .values({ id: e.id, enabled: false, ...meta })
      .onConflictDoUpdate({ target: wfModel.id, set: meta })
  }
  return entries.length
}

/** Toggle a single model's availability to the pickers. */
export async function setModelEnabled(
  db: WfDb,
  input: { modelId: string; enabled: boolean },
): Promise<void> {
  await db
    .update(wfModel)
    .set({ enabled: input.enabled, updatedAt: new Date() })
    .where(eq(wfModel.id, input.modelId))
}

/** Upsert a provider row and stamp its last successful refresh. */
export async function touchModelProvider(
  db: WfDb,
  provider: ModelProvider,
  refreshedAt: Date,
): Promise<void> {
  const base = {
    label: provider.label,
    kind: provider.kind,
    note: provider.note ?? null,
    lastRefreshedAt: refreshedAt,
    updatedAt: refreshedAt,
  }
  await db
    .insert(wfModelProvider)
    .values({ id: provider.id, ...base })
    .onConflictDoUpdate({ target: wfModelProvider.id, set: base })
}
