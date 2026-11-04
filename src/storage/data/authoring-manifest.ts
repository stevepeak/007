import { eq, inArray } from 'drizzle-orm'

import {
  decisionAgentConfigSchema,
  type DecisionAgentConfig,
} from '../../engine/decision-agent-schema'
import {
  agentConfigSchema,
  type AgentConfig,
  type WfRunManifestEntry,
  type WfRunManifestRef,
  type WorkflowGraph,
} from '../../engine/graph'
import type { WfDb } from '../client'
import {
  wfAgent,
  wfAgentVersion,
  wfModel,
  wfWorkflow,
  wfWorkflowVersion,
} from '../schema'

import { agentPinKey, resolveAgentVersions } from './authoring-agents'
import {
  agentPinsInGraph,
  MAX_WORKFLOW_DEPTH,
  workflowIdsInGraph,
} from './authoring-graph'
import { latestVersion } from './authoring-workflows'
import { selectChunked } from './shared'

// ---------------------------------------------------------------------------
// Run manifest resolution
// ---------------------------------------------------------------------------

/**
 * Resolve every floating reference reachable from a graph — its agents AND the
 * workflows it calls, transitively — to their latest published versions, and
 * flatten them into one manifest, whose refs are frozen into `wf_run.manifest`
 * at run start. A called workflow's version is frozen as a whole (it runs inline
 * as a subgraph); its own agents and sub-workflows are resolved into the SAME flat manifest, so
 * nested nodes find their entries. An agent's DELEGATION whitelist
 * (`config.subAgents.targets`) is resolved the same way — a `spawn_*` tool
 * launches those targets inline at run time, so they must be in the manifest
 * too, transitively. Reference cycles (A calls B calls A) are a hard error for
 * workflows — inline execution would otherwise recurse forever; agent→agent
 * delegation cycles are bounded harmlessly by the `agentId@pin` dedup.
 */
export async function resolveRunManifest(
  db: WfDb,
  graph: WorkflowGraph,
): Promise<WfRunManifestEntry[]> {
  const entries: WfRunManifestEntry[] = []
  // Dedup key is `agentId@pin` so the same agent pinned to different versions
  // by different nodes lands as several distinct entries.
  const seenAgentPins = new Set<string>()
  const seenWorkflows = new Set<string>()
  // Agent rows by id (null = no such agent). Loaded a graph or a delegation
  // whitelist at a time so the walk reads `wf_agent` once per level, not once
  // per agent.
  const agentRows = new Map<
    string,
    { name: string; kind: typeof wfAgent.$inferSelect.kind } | null
  >()
  const loadAgents = async (agentIds: readonly string[]): Promise<void> => {
    const missing = [...new Set(agentIds)].filter((id) => !agentRows.has(id))
    if (missing.length === 0) {
      return
    }
    const rows = await selectChunked(missing, (ids) => {
      return db
        .select({ id: wfAgent.id, name: wfAgent.name, kind: wfAgent.kind })
        .from(wfAgent)
        .where(inArray(wfAgent.id, ids))
    })
    for (const id of missing) {
      agentRows.set(id, null)
    }
    for (const { id, ...row } of rows) {
      agentRows.set(id, row)
    }
  }

  // Resolved versions by `agentPinKey` (absent = pin resolves to nothing).
  // Loaded a level at a time alongside the agent rows, for the same reason.
  const versions = new Map<string, typeof wfAgentVersion.$inferSelect>()
  const loadedPins = new Set<string>()
  const loadLevel = async (
    pins: readonly { agentId: string; pin: number | null }[],
  ): Promise<void> => {
    const missing = pins.filter((p) => !loadedPins.has(agentPinKey(p)))
    const [found] = await Promise.all([
      resolveAgentVersions(db, missing),
      loadAgents(pins.map((p) => p.agentId)),
    ])
    for (const p of missing) loadedPins.add(agentPinKey(p))
    for (const [key, v] of found) versions.set(key, v)
  }

  // Resolve one agent pin (from a graph node OR a delegation target), push its
  // frozen entry, then recurse into its own delegation whitelist. `stack` is the
  // workflow-nesting chain, threaded so a workflow reached via delegation still
  // participates in cycle/depth detection.
  const resolveAgentPin = async (
    agentId: string,
    pin: number | null,
    stack: string[],
  ): Promise<void> => {
    const key = agentPinKey({ agentId, pin })
    if (seenAgentPins.has(key)) {
      return
    }
    seenAgentPins.add(key)
    // `null` pin floats to latest; a number resolves that exact version. A
    // pin pointing at a version that no longer exists resolves to nothing —
    // the node then fails at run time with a clear "not in manifest" error.
    // Callers prefetch the level through `loadLevel`, so this is a map read.
    await loadLevel([{ agentId, pin }])
    const version = versions.get(key)
    if (!version) {
      return
    }
    const agent = agentRows.get(agentId)
    // A DECISION agent is a question set, not a prompt and a tool loop, so it
    // freezes into its own entry kind — parsed against its own schema BEFORE
    // `agentConfigSchema` ever sees it, which would otherwise throw
    // `prompt: expected string, received undefined` and leave the run sitting at
    // `queued` with no error and no logs (manifest resolution runs before
    // `markRunRunning`). It floats or pins like any agent: the same node shape
    // points at either kind, and `runNode` asks the manifest which it got.
    if (agent?.kind === 'decision') {
      entries.push({
        kind: 'decision-agent',
        id: agentId,
        pinnedVersion: pin,
        versionId: version.id,
        versionNumber: version.versionNumber,
        name: agent.name,
        config: decisionAgentConfigSchema.parse(version.config),
      })
      return
    }
    const config = agentConfigSchema.parse(version.config)
    // `contextLength` is filled in after the walk, in one query for every model.
    entries.push({
      kind: 'agent',
      id: agentId,
      pinnedVersion: pin,
      versionId: version.id,
      versionNumber: version.versionNumber,
      name: agent?.name ?? '',
      config,
    })
    // Freeze the agent's delegation targets so its `spawn_*` tools resolve.
    await loadLevel(
      config.subAgents.targets
        .filter((t) => t.kind === 'agent')
        .map((t) => ({ agentId: t.id, pin: t.version })),
    )
    for (const target of config.subAgents.targets) {
      if (target.kind === 'agent') {
        await resolveAgentPin(target.id, target.version, stack)
      } else {
        await resolveWorkflow(target.id, stack)
      }
    }
  }

  const resolveWorkflow = async (
    workflowId: string,
    stack: string[],
  ): Promise<void> => {
    if (stack.includes(workflowId)) {
      throw new Error(
        `Workflow reference cycle: ${[...stack, workflowId].join(' → ')}.`,
      )
    }
    if (seenWorkflows.has(workflowId)) {
      return
    }
    seenWorkflows.add(workflowId)
    // The workflow row does not depend on the version, so both reads run
    // together.
    const [version, workflowRows] = await Promise.all([
      latestVersion(db, workflowId),
      db
        .select({ name: wfWorkflow.name })
        .from(wfWorkflow)
        .where(eq(wfWorkflow.id, workflowId))
        .limit(1),
    ])
    if (!version) {
      return
    }
    const workflow = workflowRows[0]
    const calleeGraph = version.graph as WorkflowGraph
    entries.push({
      kind: 'workflow',
      id: workflowId,
      versionId: version.id,
      versionNumber: version.versionNumber,
      name: workflow?.name ?? '',
      graph: calleeGraph,
    })
    await resolveInto(calleeGraph, [...stack, workflowId])
  }

  const resolveInto = async (
    g: WorkflowGraph,
    // The chain of workflow ids currently being resolved, for cycle detection.
    stack: string[],
  ): Promise<void> => {
    if (stack.length > MAX_WORKFLOW_DEPTH) {
      throw new Error(
        `Workflow nesting too deep (> ${MAX_WORKFLOW_DEPTH}): ${stack.join(' → ')}.`,
      )
    }
    const pins = agentPinsInGraph(g)
    await loadLevel(pins.map((p) => ({ agentId: p.agentId, pin: p.version })))
    for (const { agentId, version: pin } of pins) {
      await resolveAgentPin(agentId, pin, stack)
    }
    for (const workflowId of workflowIdsInGraph(g)) {
      await resolveWorkflow(workflowId, stack)
    }
  }

  await resolveInto(graph, [])

  // Freeze each agent's model context window alongside its config: the engine's
  // overflow guard needs it, and `getModel` only returns a model, not its
  // metadata. A model the platform hasn't catalogued (or one reporting no
  // context length) leaves this undefined and the guard simply stands down.
  const agentEntries = entries.filter((e) => e.kind === 'agent')
  const modelIds = [...new Set(agentEntries.map((e) => e.config.modelId))]
  if (modelIds.length > 0) {
    const models = await db
      .select({ id: wfModel.id, contextLength: wfModel.contextLength })
      .from(wfModel)
      .where(inArray(wfModel.id, modelIds))
    const contextLengths = new Map(models.map((m) => [m.id, m.contextLength]))
    for (const entry of agentEntries) {
      const contextLength = contextLengths.get(entry.config.modelId)
      if (contextLength != null) {
        entry.contextLength = contextLength
      }
    }
  }
  return entries
}

// ---------------------------------------------------------------------------
// Run manifest hydration
// ---------------------------------------------------------------------------

type VersionContent =
  | { kind: 'agent'; config: AgentConfig }
  | { kind: 'decision-agent'; config: DecisionAgentConfig }
  | { kind: 'workflow'; graph: WorkflowGraph }

const VERSION_CONTENT_CACHE_MAX = 256
const VERSION_READ_ATTEMPTS = 3
const VERSION_READ_BACKOFF_MS = 100

/**
 * Parsed version content by `versionId`, per isolate. Never stale: a version's
 * config and graph are immutable. Keyed by the driver for the same reason as
 * the price-map memo in `runs-cost.ts`.
 */
const versionContentCache = new WeakMap<object, Map<string, VersionContent>>()

function versionContentCacheFor(db: WfDb): Map<string, VersionContent> | null {
  const client = (db as unknown as { $client?: unknown }).$client
  if (typeof client !== 'object' || client === null) return null
  let cache = versionContentCache.get(client)
  if (!cache) {
    cache = new Map()
    versionContentCache.set(client, cache)
  }
  return cache
}

async function readVersionRows(db: WfDb, refs: readonly WfRunManifestRef[]) {
  const idsOf = (workflow: boolean) => {
    return [
      ...new Set(
        refs
          .filter((r) => (r.kind === 'workflow') === workflow)
          .map((r) => r.versionId),
      ),
    ]
  }
  const [agentRows, workflowRows] = await Promise.all([
    selectChunked(idsOf(false), (ids) => {
      return db
        .select({ id: wfAgentVersion.id, content: wfAgentVersion.config })
        .from(wfAgentVersion)
        .where(inArray(wfAgentVersion.id, ids))
    }),
    selectChunked(idsOf(true), (ids) => {
      return db
        .select({ id: wfWorkflowVersion.id, content: wfWorkflowVersion.graph })
        .from(wfWorkflowVersion)
        .where(inArray(wfWorkflowVersion.id, ids))
    }),
  ])
  return [...agentRows, ...workflowRows]
}

/**
 * The durable engine hydrates outside `step.do`, because a step would journal
 * the content on every run. That leaves it no platform retry, so a transient D1
 * failure is retried here: thrown from the run body, it would end the instance
 * without recording anything on the run.
 */
async function readVersionRowsWithRetry(
  db: WfDb,
  refs: readonly WfRunManifestRef[],
) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await readVersionRows(db, refs)
    } catch (err) {
      if (attempt >= VERSION_READ_ATTEMPTS) throw err
      await new Promise((resolve) => {
        setTimeout(resolve, VERSION_READ_BACKOFF_MS * 2 ** attempt)
      })
    }
  }
}

function parseVersionContent(
  ref: WfRunManifestRef,
  content: unknown,
): VersionContent {
  switch (ref.kind) {
    case 'workflow':
      return { kind: ref.kind, graph: content as WorkflowGraph }
    case 'decision-agent':
      return {
        kind: ref.kind,
        config: decisionAgentConfigSchema.parse(content),
      }
    case 'agent':
      return { kind: ref.kind, config: agentConfigSchema.parse(content) }
  }
}

/**
 * Turn frozen refs back into the entries the engine executes, by `versionId`, so
 * a publish since the run started changes nothing. Rows written when manifests
 * embedded their content hydrate the same way: the embedded copy is ignored.
 *
 * A ref whose version no longer exists (its workflow was deleted) is dropped, so
 * a node that needs it fails with the usual "not in the manifest" error.
 */
export async function hydrateRunManifest(
  db: WfDb,
  refs: readonly WfRunManifestRef[],
): Promise<WfRunManifestEntry[]> {
  const cache = versionContentCacheFor(db)
  const contents = new Map<string, VersionContent>()
  const misses = new Map<string, WfRunManifestRef>()
  for (const ref of refs) {
    const cached = cache?.get(ref.versionId)
    if (cached) contents.set(ref.versionId, cached)
    else misses.set(ref.versionId, ref)
  }
  if (misses.size > 0) {
    const rows = await readVersionRowsWithRetry(db, [...misses.values()])
    for (const { id, content } of rows) {
      const ref = misses.get(id)
      if (!ref) continue
      const parsed = parseVersionContent(ref, content)
      contents.set(id, parsed)
      if (!cache) continue
      if (cache.size >= VERSION_CONTENT_CACHE_MAX) {
        const oldest = cache.keys().next()
        if (!oldest.done) cache.delete(oldest.value)
      }
      cache.set(id, parsed)
    }
  }
  return refs.flatMap((ref): WfRunManifestEntry[] => {
    const cached = contents.get(ref.versionId)
    if (!cached) return []
    // Cloned because the cache is shared across runs: nothing one run does to
    // its entries may reach another.
    const content = structuredClone(cached)
    if (ref.kind === 'workflow' && content.kind === 'workflow') {
      return [{ ...ref, graph: content.graph }]
    }
    if (ref.kind === 'decision-agent' && content.kind === 'decision-agent') {
      return [{ ...ref, config: content.config }]
    }
    if (ref.kind === 'agent' && content.kind === 'agent') {
      return [{ ...ref, config: content.config }]
    }
    return []
  })
}
