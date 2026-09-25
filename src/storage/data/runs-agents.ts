import { and, desc, eq, inArray, or, sql, type SQL } from 'drizzle-orm'

import type { WorkflowGraph } from '../../engine/graph'
import type { AgentNodeMeta } from '../../engine/nodes/agent'
import type { WfDb } from '../client'
import { tokenCostUsd, type ModelPriceMap } from '../cost'
import { wfRun, wfRunStep, wfWorkflow, wfWorkflowVersion } from '../schema'

import { allNodes } from './authoring-graph'
import { loadModelPriceMap } from './runs-cost'
import { chunk, clampLimit, ID_CHUNK_SIZE } from './shared'

// ---------------------------------------------------------------------------
// One agent's recent calls, with per-call metrics
// ---------------------------------------------------------------------------

const AGENT_CALL_PAGE_MAX = 100

/**
 * Ceiling on the individual steps fetched to fold ONE page of groups. A fan-out
 * wider than this still reports its true `callCount` (SQL counts it), but the
 * summed metrics and `itemIndexes` cover only the newest calls in it — far
 * better than pulling thousands of `meta` blobs over the wire for one row.
 */
const AGENT_CALL_STEP_MAX = 1000

/**
 * How many candidate (run, node) groups phase 1 pulls before phase 2 resolves
 * their runs, drops the eval ones and re-sorts by run creation time.
 *
 * It has to exceed `limit` because that re-sort can reorder the window, and by
 * enough that a stretch of eval runs at the top can't starve the page. It is a
 * window and not the whole history because an agent that has run for months has
 * thousands of call sites and a page shows twenty: 500 group rows (four small
 * columns, no `meta`) is a cheap read, and ordering by `started_at` is near
 * enough to ordering by the run's creation time — a run's steps start moments
 * after it — that the two agree on everything but the boundary.
 */
const GROUP_WINDOW_MAX = 500

/** Each (run, node) pair binds two parameters, so half the id budget. */
const PAIR_CHUNK_SIZE = Math.floor(ID_CHUNK_SIZE / 2)

/** Map key for one call site. `\u{0}` can't occur in an id, so it can't collide. */
function groupKey(runId: string, nodeId: string): string {
  return `${runId}\u{0}${nodeId}`
}

/**
 * How loudly a status speaks for the whole group: one failed item makes the row
 * failed, and a still-running one outranks anything already settled. Anything
 * unlisted sorts below `completed`, so a group of them keeps its own status.
 */
const STATUS_RANK: Record<string, number> = {
  failed: 4,
  running: 3,
  queued: 2,
  completed: 1,
}

/**
 * One agent's executions inside ONE run node, folded into a single row.
 *
 * The unit is the CALL SITE, not the individual execution: an agent inside an
 * iteration runs once per item, and listing those separately meant twenty rows
 * of "item 3 · workflow v1" that were all the same run. `callCount` is how many
 * times it ran there and every metric below is the total across them, so a
 * fan-out reads as one line of work with its real cost.
 *
 * Deliberately carries no input/output: the agent editor's "Recent calls" tab
 * answers "how hard did this agent work, and what did it cost" — the run's own
 * steps hold the data, one click away.
 */
export type AgentCallRow = {
  runId: string
  /** The graph node that ran it, or a `sub:<primary>:<n>` id for a sub-agent. */
  nodeId: string
  /** How many executions this row folds — >1 only for an iteration fan-out. */
  callCount: number
  /**
   * The 0-based iteration item indexes this row covers, ascending. Empty when
   * the agent didn't run inside an iteration. Truncated with the aggregated
   * metrics when a fan-out exceeds {@link AGENT_CALL_STEP_MAX}.
   */
  itemIndexes: number[]
  /** The group's worst status — one failed item makes the whole row failed. */
  status: string
  /** The first error across the group, when any call failed. */
  error: string | null
  /** How many of the `callCount` executions failed. */
  failedCount: number
  /** Earliest start, falling back to the run's creation time for a queued call. */
  startedAt: number | null
  /** Latest finish; null while any call is still running. */
  finishedAt: number | null
  /** Summed wall-clock ACROSS the calls, so a fan-out's total compute shows.
   *  Null when the recorder captured no timing at all. */
  durationMs: number | null
  workflowId: string | null
  workflowName: string | null
  versionNumber: number | null
  /** Provider-native model id the calls ran on (from the newest one's meta). */
  model: string | null
  /** The agent version resolved from the run manifest, when stamped. */
  agentVersion: number | null
  /** Rounds of the tool loop, summed across the calls. */
  turns: number
  inputTokens: number
  outputTokens: number
  /** Derived USD cost; null when no call ran on a priced model. */
  costUsd: number | null
  /** Per-tool call counts across every call and turn, most-called first. */
  toolCalls: { toolId: string; count: number }[]
  /** Any call stopped researching early — see AgentNodeMeta. */
  stoppedOnTokenBudget: boolean
  stoppedOnContextLimit: boolean
  /** Set when these calls were a SPAWNED sub-agent rather than a graph node. */
  subAgentName: string | null
}

/**
 * The graph node ids that point at an agent, across every published workflow
 * version.
 *
 * Steps recorded before `meta.agentId` existed (see AgentNodeMeta) carry no
 * agent reference at all, so their only link back is the node id in the version
 * they ran. Resolving that direction — agent → node ids — keeps the step query a
 * single indexed lookup instead of a scan-and-filter over run history.
 */
async function agentNodeIds(db: WfDb, agentId: string): Promise<string[]> {
  const rows = await db
    .select({ graph: wfWorkflowVersion.graph })
    .from(wfWorkflowVersion)
  const ids = new Set<string>()
  for (const row of rows) {
    // Untyped JSON column: a malformed graph must not break the listing.
    const graph = row.graph as WorkflowGraph | null
    if (!graph || !Array.isArray(graph.nodes)) continue
    for (const node of allNodes(graph)) {
      if (node.kind === 'agent' && node.config.agentId === agentId) {
        ids.add(node.id)
      }
    }
  }
  return [...ids]
}

/** Narrow a step's untyped `meta` to agent meta, or null for a non-agent step. */
function asAgentMeta(meta: unknown): AgentNodeMeta | null {
  if (
    meta &&
    typeof meta === 'object' &&
    Array.isArray((meta as { steps?: unknown }).steps)
  ) {
    return meta as AgentNodeMeta
  }
  return null
}

/** Tool ids called across a call's turns, counted and ordered most-called first. */
function countToolCalls(
  meta: AgentNodeMeta,
): { toolId: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const step of meta.steps ?? []) {
    for (const call of step.toolCalls ?? []) {
      if (!call.toolName) continue
      counts.set(call.toolName, (counts.get(call.toolName) ?? 0) + 1)
    }
  }
  return [...counts]
    .map(([toolId, count]) => ({ toolId, count }))
    .sort((a, b) => b.count - a.count || a.toolId.localeCompare(b.toolId))
}

/**
 * Fold one call site's steps into the row the editor shows: counts and money
 * SUM (a fan-out's real cost is all of it), timing spans min-start → max-finish
 * while `durationMs` stays the summed compute, and the status is the loudest
 * one in the group. Model/version come from the newest call — a re-run mid-loop
 * can't change them, and if it somehow did, the latest is the truth.
 */
function foldCalls(
  group: {
    runId: string
    nodeId: string
    callCount: number
    runCreatedAt: Date
    workflowId: string | null
    workflowName: string | null
    versionNumber: number | null
  },
  steps: {
    itemIndex: number
    status: string
    error: string | null
    meta: unknown
    startedAt: Date | null
    finishedAt: Date | null
  }[],
  priceMap: ModelPriceMap,
): AgentCallRow {
  let status = steps[0]?.status ?? 'completed'
  let error: string | null = null
  let failedCount = 0
  let startedAt: number | null = null
  let finishedAt: number | null = null
  let anyUnfinished = false
  let durationMs: number | null = null
  let turns = 0
  let inputTokens = 0
  let outputTokens = 0
  let costUsd: number | null = null
  let stoppedOnTokenBudget = false
  let stoppedOnContextLimit = false
  let model: string | null = null
  let agentVersion: number | null = null
  let subAgentName: string | null = null
  const itemIndexes: number[] = []
  const toolCalls = new Map<string, number>()

  // `steps` arrives newest-first, so the first meta seen is the newest one.
  for (const step of steps) {
    if ((STATUS_RANK[step.status] ?? 0) > (STATUS_RANK[status] ?? 0)) {
      status = step.status
    }
    if (step.status === 'failed') failedCount += 1
    if (error == null && step.error != null) error = step.error
    if (step.itemIndex >= 0) itemIndexes.push(step.itemIndex)

    const started = step.startedAt?.getTime() ?? null
    const finished = step.finishedAt?.getTime() ?? null
    if (started != null && (startedAt == null || started < startedAt)) {
      startedAt = started
    }
    if (finished == null) anyUnfinished = true
    else if (finishedAt == null || finished > finishedAt) finishedAt = finished
    if (started != null && finished != null) {
      durationMs = (durationMs ?? 0) + Math.max(0, finished - started)
    }

    const meta = asAgentMeta(step.meta)
    if (!meta) continue
    const stepInput = meta.totalUsage?.inputTokens ?? 0
    const stepOutput = meta.totalUsage?.outputTokens ?? 0
    turns += meta.steps?.length ?? 0
    inputTokens += stepInput
    outputTokens += stepOutput
    const stepCost = tokenCostUsd(
      stepInput,
      stepOutput,
      priceMap.get(meta.model),
    )
    // Null stays null only while NO call was priced: one unpriced model in a
    // fan-out shouldn't blank the whole row's cost.
    if (stepCost != null) costUsd = (costUsd ?? 0) + stepCost
    for (const { toolId, count } of countToolCalls(meta)) {
      toolCalls.set(toolId, (toolCalls.get(toolId) ?? 0) + count)
    }
    if (meta.stoppedOnTokenBudget === true) stoppedOnTokenBudget = true
    if (meta.stoppedOnContextLimit === true) stoppedOnContextLimit = true
    model ??= meta.model ?? null
    agentVersion ??= meta.agentVersion ?? null
    subAgentName ??= (meta as { subAgentName?: string }).subAgentName ?? null
  }

  return {
    runId: group.runId,
    nodeId: group.nodeId,
    callCount: group.callCount,
    itemIndexes: itemIndexes.sort((a, b) => a - b),
    status,
    error,
    failedCount,
    startedAt: startedAt ?? group.runCreatedAt.getTime(),
    finishedAt: anyUnfinished ? null : finishedAt,
    durationMs,
    workflowId: group.workflowId,
    workflowName: group.workflowName,
    versionNumber: group.versionNumber,
    model,
    agentVersion,
    turns,
    inputTokens,
    outputTokens,
    costUsd,
    toolCalls: [...toolCalls]
      .map(([toolId, count]) => ({ toolId, count }))
      .sort((a, b) => b.count - a.count || a.toolId.localeCompare(b.toolId)),
    stoppedOnTokenBudget,
    stoppedOnContextLimit,
    subAgentName,
  }
}

/**
 * Recent CALL SITES of ONE agent across all runs, newest first — one row per
 * (run, node), with every execution that happened there folded into it. Powers
 * the agent editor's "Recent calls" tab.
 *
 * A call is a `wf_run_step` with `nodeKind = 'agent'` that is attributable to
 * the agent either by its stamped `meta.agentId` (every call recorded since the
 * stamp landed, including spawned sub-agents, which have no graph node) or by
 * having run on a node that references the agent in some published version.
 *
 * Read in three phases, because `limit` has to bound ROWS-AS-SHOWN and the fold
 * is over data that only exists inside the untyped `meta` JSON: SQL picks the
 * newest candidate groups and counts each one exactly, the runs behind them are
 * resolved by primary key, then their steps are fetched and aggregated in JS.
 *
 * Phase 1 touches `wf_run_step` ALONE, which is the whole reason this isn't one
 * query with a join. Joined to `wf_run`, the planner drove the loop from
 * `wf_run` (via `wf_run_eval_created_idx`, since `is_eval = false` matches
 * nearly every run) and read every step of every run to evaluate the
 * `json_extract` — ~44k rows and 200-950ms to return a page of 20. Alone, the
 * step predicate is a `MULTI-INDEX OR` across `wf_run_step_agent_idx` and
 * `wf_run_step_node_idx`, which holds without `sqlite_stat1` — D1 carries no
 * ANALYZE stats, so a plan that only wins once the planner knows the table
 * shapes is a plan that never wins. Keep the joins out of phase 1.
 */
export async function listAgentCalls(
  db: WfDb,
  input: { agentId: string; limit?: number },
): Promise<AgentCallRow[]> {
  const limit = clampLimit(input.limit, {
    fallback: 20,
    max: AGENT_CALL_PAGE_MAX,
  })
  const nodeIds = await agentNodeIds(db, input.agentId)
  const byStampedAgentId = eq(
    sql`json_extract(${wfRunStep.meta}, '$.agentId')`,
    input.agentId,
  )

  // One page per parameter-budget chunk of node ids. This one can't just
  // concatenate chunks the way the plain id lookups do: the node-id list is an
  // OR arm of a query with a global `ORDER BY … LIMIT`, so each chunk returns
  // its own top-N. Take the full candidate window from every chunk, then merge —
  // the true top overall is guaranteed to be inside the union of the per-chunk
  // windows. The stamped-agentId arm rides along in every chunk and so matches
  // the same steps repeatedly, hence the de-dupe by group key.
  const nodeIdChunks = chunk(nodeIds)
  const attributions: SQL[] =
    nodeIdChunks.length > 0
      ? nodeIdChunks.flatMap((ids) => {
          const clause = or(byStampedAgentId, inArray(wfRunStep.nodeId, ids))
          return clause ? [clause] : []
        })
      : [byStampedAgentId]

  // Phase 1 — candidate (run, node) groups, each with its exact execution count,
  // read from `wf_run_step` alone so the indexes can be used (see the note on
  // this function). No join means no `wf_run` here, so eval runs are still in
  // and the ordering column the page really wants (`wfRun.createdAt`) isn't
  // available yet: both are settled in phase 2, over a window wide enough that
  // the re-sort can't change which rows make the page.
  const groupWindow = (matchesAgent: SQL) => {
    return (
      db
        .select({
          runId: wfRunStep.runId,
          nodeId: wfRunStep.nodeId,
          callCount: sql<number>`count(*)`,
          lastStartedAt: sql<number | null>`max(${wfRunStep.startedAt})`,
        })
        .from(wfRunStep)
        .where(and(eq(wfRunStep.nodeKind, 'agent'), matchesAgent))
        .groupBy(wfRunStep.runId, wfRunStep.nodeId)
        // A step the recorder entered without a measured start has a NULL
        // `started_at` and is the NEWEST thing there is, so it sorts first rather
        // than into SQLite's default NULL-lowest slot — otherwise an in-flight
        // call could fall off the end of the window.
        .orderBy(sql`max(${wfRunStep.startedAt}) desc nulls first`)
        .limit(GROUP_WINDOW_MAX)
    )
  }

  const windows = await Promise.all(attributions.map(groupWindow))
  type WindowRow = (typeof windows)[number][number]
  const byGroup = new Map<string, WindowRow>()
  for (const window of windows) {
    for (const row of window) {
      const key = groupKey(row.runId, row.nodeId)
      const seen = byGroup.get(key)
      // A chunk whose node-id arm misses this group still matches its STAMPED
      // steps, so its count can be short. The largest count is the true one.
      if (!seen || row.callCount > seen.callCount) byGroup.set(key, row)
    }
  }
  const candidates = [...byGroup.values()]
  if (candidates.length === 0) return []

  // Phase 2 — the runs behind those candidates, by primary key, for the real
  // ordering key and the workflow identity. This is also where eval runs are
  // dropped: their runs are simulated and can outnumber production traffic many
  // times over, so mixing them in would make the metrics say nothing about what
  // this agent actually costs — the eval report is where a simulated run belongs.
  // A run id with no row here (purged run) drops out with them.
  const runIds = [...new Set(candidates.map((c) => c.runId))]
  const runPages = await Promise.all(
    chunk(runIds).map((ids) => {
      return db
        .select({
          runId: wfRun.id,
          runCreatedAt: wfRun.createdAt,
          workflowId: wfWorkflowVersion.workflowId,
          workflowName: wfWorkflow.name,
          versionNumber: wfWorkflowVersion.versionNumber,
        })
        .from(wfRun)
        .innerJoin(
          wfWorkflowVersion,
          eq(wfRun.workflowVersionId, wfWorkflowVersion.id),
        )
        .innerJoin(wfWorkflow, eq(wfWorkflowVersion.workflowId, wfWorkflow.id))
        .where(and(inArray(wfRun.id, ids), eq(wfRun.isEval, false)))
    }),
  )
  const runById = new Map(runPages.flat().map((r) => [r.runId, r]))

  // Re-apply the ordering the page is specified in — newest run first, and
  // within a run the latest-started call — then take the top N. NULL
  // `lastStartedAt` sorts FIRST here for the same reason it does in SQL: an
  // untimed step is one still in flight.
  const groups = candidates
    .flatMap((c) => {
      const run = runById.get(c.runId)
      return run ? [{ ...c, ...run }] : []
    })
    .sort((a, b) => {
      const byRun = b.runCreatedAt.getTime() - a.runCreatedAt.getTime()
      if (byRun !== 0) return byRun
      if (a.lastStartedAt == null) return b.lastStartedAt == null ? 0 : -1
      if (b.lastStartedAt == null) return 1
      return b.lastStartedAt - a.lastStartedAt
    })
    .slice(0, limit)
  if (groups.length === 0) return []

  // Phase 3 — every step behind those groups. Matched as explicit (run, node)
  // pairs rather than two `inArray`s, so a run holding a big fan-out for some
  // OTHER agent node isn't dragged over the wire to be filtered away here.
  const pairs = groups.map((g) => {
    return and(eq(wfRunStep.runId, g.runId), eq(wfRunStep.nodeId, g.nodeId))
  })
  const stepPages = await Promise.all(
    chunk(pairs, PAIR_CHUNK_SIZE).map((pairChunk) => {
      return db
        .select({
          runId: wfRunStep.runId,
          nodeId: wfRunStep.nodeId,
          itemIndex: wfRunStep.itemIndex,
          status: wfRunStep.status,
          error: wfRunStep.error,
          meta: wfRunStep.meta,
          startedAt: wfRunStep.startedAt,
          finishedAt: wfRunStep.finishedAt,
        })
        .from(wfRunStep)
        .where(and(eq(wfRunStep.nodeKind, 'agent'), or(...pairChunk)))
        .orderBy(desc(wfRunStep.startedAt), wfRunStep.itemIndex)
        .limit(AGENT_CALL_STEP_MAX)
    }),
  )

  const stepsByGroup = new Map<string, (typeof stepPages)[number][number][]>()
  for (const page of stepPages) {
    for (const step of page) {
      const key = groupKey(step.runId, step.nodeId)
      const list = stepsByGroup.get(key)
      if (list) list.push(step)
      else stepsByGroup.set(key, [step])
    }
  }

  const priceMap = await loadModelPriceMap(db)

  return groups.map((group) => {
    const steps = stepsByGroup.get(groupKey(group.runId, group.nodeId)) ?? []
    return foldCalls(group, steps, priceMap)
  })
}
