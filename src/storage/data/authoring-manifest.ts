import { and, eq } from 'drizzle-orm'

import {
  agentConfigSchema,
  type WfRunManifestEntry,
  type WorkflowGraph,
} from '../../engine/graph'
import type { WfDb } from '../client'
import { wfAgent, wfAgentVersion, wfWorkflow } from '../schema'

import { latestAgentVersion } from './authoring-agents'
import {
  agentPinsInGraph,
  MAX_WORKFLOW_DEPTH,
  workflowIdsInGraph,
} from './authoring-graph'
import { latestVersion } from './authoring-workflows'

// ---------------------------------------------------------------------------
// Run manifest resolution
// ---------------------------------------------------------------------------

/** A specific published version by its number (for pinned agent references). */
async function agentVersionByNumber(
  db: WfDb,
  agentId: string,
  versionNumber: number,
) {
  const rows = await db
    .select()
    .from(wfAgentVersion)
    .where(
      and(
        eq(wfAgentVersion.agentId, agentId),
        eq(wfAgentVersion.versionNumber, versionNumber),
      ),
    )
    .limit(1)
  return rows[0]
}

/**
 * Resolve every floating reference reachable from a graph — its agents AND the
 * workflows it calls, transitively — to their latest published versions, and
 * flatten them into one manifest frozen into `wf_run.manifest` at run start.
 * A called workflow's graph is frozen in whole (it runs inline as a subgraph);
 * its own agents and sub-workflows are resolved into the SAME flat manifest, so
 * nested nodes find their entries. Reference cycles (A calls B calls A) are a
 * hard error — inline execution would otherwise recurse forever.
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
    for (const { agentId, version: pin } of agentPinsInGraph(g)) {
      const key = `${agentId}@${pin ?? 'latest'}`
      if (seenAgentPins.has(key)) {
        continue
      }
      seenAgentPins.add(key)
      // `null` pin floats to latest; a number resolves that exact version. A
      // pin pointing at a version that no longer exists resolves to nothing —
      // the node then fails at run time with a clear "not in manifest" error.
      const version =
        pin == null
          ? await latestAgentVersion(db, agentId)
          : await agentVersionByNumber(db, agentId, pin)
      if (!version) {
        continue
      }
      const agent = (
        await db
          .select({ name: wfAgent.name })
          .from(wfAgent)
          .where(eq(wfAgent.id, agentId))
          .limit(1)
      )[0]
      entries.push({
        kind: 'agent',
        id: agentId,
        pinnedVersion: pin,
        versionId: version.id,
        versionNumber: version.versionNumber,
        name: agent?.name ?? '',
        config: agentConfigSchema.parse(version.config),
      })
    }
    for (const workflowId of workflowIdsInGraph(g)) {
      if (stack.includes(workflowId)) {
        throw new Error(
          `Workflow reference cycle: ${[...stack, workflowId].join(' → ')}.`,
        )
      }
      if (seenWorkflows.has(workflowId)) {
        continue
      }
      seenWorkflows.add(workflowId)
      const version = await latestVersion(db, workflowId)
      if (!version) {
        continue
      }
      const workflow = (
        await db
          .select({ name: wfWorkflow.name })
          .from(wfWorkflow)
          .where(eq(wfWorkflow.id, workflowId))
          .limit(1)
      )[0]
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
  }

  await resolveInto(graph, [])
  return entries
}
