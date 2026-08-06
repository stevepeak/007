import { and, desc, eq, inArray, or, sql, type SQL } from 'drizzle-orm'

import type { WorkflowGraph } from '../../engine/graph'
import type { AgentNodeMeta } from '../../engine/nodes/agent'
import type { WfDb } from '../client'
import { tokenCostUsd } from '../cost'
import {
  wfRun,
  wfRunStep,
  wfWorkflow,
  wfWorkflowVersion,
} from '../schema'

import { allNodes } from './authoring-graph'
import { loadModelPriceMap } from './runs-cost'
import { clampLimit } from './shared'

// ---------------------------------------------------------------------------
// One agent's recent calls, with per-call metrics
// ---------------------------------------------------------------------------

const AGENT_CALL_PAGE_MAX = 100

/**
 * One recorded execution of an agent, reduced to its METRICS. Deliberately
 * carries no input/output: the agent editor's "recent calls" section answers
 * "how hard did this agent work, and what did it cost" — anyone who wants the
 * data itself jumps to the run.
 */
export type AgentCallRow = {
  runId: string
  /** The graph node that ran it, or a `sub:<primary>:<n>` id for a sub-agent. */
  nodeId: string
  /** 0-based item index when the call ran inside an iteration; null otherwise. */
  itemIndex: number | null
  status: string
  error: string | null
  startedAt: number | null
  finishedAt: number | null
  /** The agent's own wall-clock, null when the recorder captured no timing. */
  durationMs: number | null
  workflowId: string | null
  workflowName: string | null
  versionNumber: number | null
  /** Provider-native model id the call ran on (from the step meta). */
  model: string | null
  /** The agent version resolved from the run manifest, when stamped. */
  agentVersion: number | null
  /** Rounds of the tool loop — `meta.steps.length`. */
  turns: number
  inputTokens: number
  outputTokens: number
  /** Derived USD cost; null when the model carries no catalog price. */
  costUsd: number | null
  /** Per-tool call counts across every turn, most-called first. */
  toolCalls: { toolId: string; count: number }[]
  /** The agent stopped researching early — see AgentNodeMeta. */
  stoppedOnTokenBudget: boolean
  stoppedOnContextLimit: boolean
  /** Set when this call was a SPAWNED sub-agent rather than a graph node. */
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
function countToolCalls(meta: AgentNodeMeta): { toolId: string; count: number }[] {
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
 * Recent executions of ONE agent across all runs, newest first, each reduced to
 * its metrics (turns, tokens, cost, per-tool call counts). Powers the agent
 * editor's "recent calls" section.
 *
 * A call is a `wf_run_step` with `nodeKind = 'agent'` that is attributable to
 * the agent either by its stamped `meta.agentId` (every call recorded since the
 * stamp landed, including spawned sub-agents, which have no graph node) or by
 * having run on a node that references the agent in some published version.
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
  const attribution: SQL[] = [
    eq(sql`json_extract(${wfRunStep.meta}, '$.agentId')`, input.agentId),
  ]
  if (nodeIds.length > 0) {
    attribution.push(inArray(wfRunStep.nodeId, nodeIds))
  }
  const matchesAgent = or(...attribution)
  if (!matchesAgent) return []

  // Real runs only. An eval's runs are simulated and can outnumber production
  // traffic many times over, so mixing them in would make the metrics say
  // nothing about what this agent actually costs — the eval report is where a
  // simulated run belongs.
  const conds: SQL[] = [
    eq(wfRunStep.nodeKind, 'agent'),
    matchesAgent,
    eq(wfRun.isEval, false),
  ]

  const rows = await db
    .select({
      runId: wfRunStep.runId,
      nodeId: wfRunStep.nodeId,
      itemIndex: wfRunStep.itemIndex,
      status: wfRunStep.status,
      error: wfRunStep.error,
      meta: wfRunStep.meta,
      startedAt: wfRunStep.startedAt,
      finishedAt: wfRunStep.finishedAt,
      runCreatedAt: wfRun.createdAt,
      workflowId: wfWorkflowVersion.workflowId,
      workflowName: wfWorkflow.name,
      versionNumber: wfWorkflowVersion.versionNumber,
    })
    .from(wfRunStep)
    .innerJoin(wfRun, eq(wfRunStep.runId, wfRun.id))
    .innerJoin(
      wfWorkflowVersion,
      eq(wfRun.workflowVersionId, wfWorkflowVersion.id),
    )
    .innerJoin(wfWorkflow, eq(wfWorkflowVersion.workflowId, wfWorkflow.id))
    .where(and(...conds))
    // A queued/running step has no `startedAt` yet, so order by the run's own
    // creation time — a live call still sorts to the top where it belongs.
    .orderBy(desc(wfRun.createdAt), desc(wfRunStep.startedAt))
    .limit(limit)

  const priceMap = await loadModelPriceMap(db)

  return rows.map((r) => {
    const meta = asAgentMeta(r.meta)
    const inputTokens = meta?.totalUsage?.inputTokens ?? 0
    const outputTokens = meta?.totalUsage?.outputTokens ?? 0
    const started = r.startedAt?.getTime() ?? null
    const finished = r.finishedAt?.getTime() ?? null
    return {
      runId: r.runId,
      nodeId: r.nodeId,
      itemIndex: r.itemIndex >= 0 ? r.itemIndex : null,
      status: r.status,
      error: r.error,
      startedAt: started ?? r.runCreatedAt.getTime(),
      finishedAt: finished,
      durationMs:
        started != null && finished != null
          ? Math.max(0, finished - started)
          : null,
      workflowId: r.workflowId,
      workflowName: r.workflowName,
      versionNumber: r.versionNumber,
      model: meta?.model ?? null,
      agentVersion: meta?.agentVersion ?? null,
      turns: meta?.steps?.length ?? 0,
      inputTokens,
      outputTokens,
      costUsd: meta
        ? tokenCostUsd(inputTokens, outputTokens, priceMap.get(meta.model))
        : null,
      toolCalls: meta ? countToolCalls(meta) : [],
      stoppedOnTokenBudget: meta?.stoppedOnTokenBudget === true,
      stoppedOnContextLimit: meta?.stoppedOnContextLimit === true,
      subAgentName:
        (meta as { subAgentName?: string } | null)?.subAgentName ?? null,
    }
  })
}
