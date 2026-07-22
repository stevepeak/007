import type { RecordStepArgs } from '../engine/run-recorder'
import type { ExecutableNode } from '../engine/scheduler'
import type { RunLogEntry } from '../engine/stream-sink'
import { createWfDb } from '../storage/client'
import { replaceNodeLogs, type WfRunLogRow } from '../storage/data'

import type { GraphWorkflowEnv } from './graph-workflow'
import type { RunCtx } from './graph-workflow-dispatch-run-ctx'
import { stepDo } from './graph-workflow-dispatch-step'
import { DEFAULT_STEP_OPTS } from './graph-workflow-dispatch-step-opts'

// Human label for a node in the log feed ("Structure the document",
// "Embed section"), falling back to the kind when a node has no label.
function nodeLabel(node: ExecutableNode): string {
  return (node as { label?: string }).label?.trim() || node.kind
}

// Build the two bookend entries for a node's feed. `node-start` is
// broadcast live from the `enter:` step and persisted (with the body's
// entries) in the `record:` step; `node-end` closes it out.
export function startEntryOf(
  node: ExecutableNode,
  seq: number,
  ts: number,
): RunLogEntry {
  return {
    ts,
    level: 'node-start',
    nodeId: node.id,
    nodeKind: node.kind,
    sequence: seq,
    message: `▶ ${nodeLabel(node)}`,
  }
}
function endEntryOf(
  node: ExecutableNode,
  seq: number,
  ts: number,
  failed: boolean,
  detail?: string,
): RunLogEntry {
  return {
    ts,
    level: failed ? 'error' : 'node-end',
    nodeId: node.id,
    nodeKind: node.kind,
    sequence: seq,
    message: failed
      ? `✕ ${nodeLabel(node)} failed${detail ? `: ${detail}` : ''}`
      : `✓ ${nodeLabel(node)}`,
  }
}

// Persist a node's full feed (bookends + body) in one idempotent write,
// and stream its closing line live. Shared by the success + failure
// paths so every node — even a failed one — leaves a readable feed.
async function persistLogs<TDeps, E extends GraphWorkflowEnv>(
  ctx: RunCtx<TDeps, E>,
  node: ExecutableNode,
  seq: number,
  startEntry: RunLogEntry,
  bodyLogs: RunLogEntry[],
  endEntry: RunLogEntry,
): Promise<void> {
  const entries: WfRunLogRow[] = [startEntry, ...bodyLogs, endEntry].map(
    (e) => ({
      nodeId: e.nodeId ?? node.id,
      nodeKind: e.nodeKind ?? node.kind,
      sequence: e.sequence ?? seq,
      level: e.level,
      message: e.message,
      meta: e.meta ?? null,
      ts: e.ts ?? Date.now(),
    }),
  )
  await replaceNodeLogs(createWfDb(ctx.env.DB), {
    runId: ctx.p.workflowRunId,
    nodeId: node.id,
    entries,
  })
  await ctx.room.appendLog(endEntry)
}

// Flip a node's (run_id, node_id) row to its terminal status and rewrite its
// full feed, in one idempotent `record:` step. Factored out of the success and
// failure arms so both open the SAME step key and persist through the same
// path; only the recorded status/payload and the closing feed line differ.
export async function recordTerminal<TDeps, E extends GraphWorkflowEnv>(
  ctx: RunCtx<TDeps, E>,
  node: ExecutableNode,
  seq: number,
  input: unknown,
  startEntry: RunLogEntry,
  outcome:
    | { status: 'failed'; error: string }
    | {
        status: 'completed'
        output: unknown
        meta: unknown
        branchResult: RecordStepArgs['branchResult']
        bodyLogs: RunLogEntry[]
      },
): Promise<void> {
  await stepDo(ctx.step, `record:${node.id}`, DEFAULT_STEP_OPTS, async () => {
    if (outcome.status === 'failed') {
      await ctx.recordOne({
        nodeId: node.id,
        nodeKind: node.kind,
        sequence: seq,
        input,
        status: 'failed',
        error: outcome.error,
      })
      await persistLogs(
        ctx,
        node,
        seq,
        startEntry,
        [],
        endEntryOf(node, seq, Date.now(), true, outcome.error),
      )
    } else {
      await ctx.recordOne({
        nodeId: node.id,
        nodeKind: node.kind,
        sequence: seq,
        input,
        status: 'completed',
        output: outcome.output,
        meta: outcome.meta,
        branchResult: outcome.branchResult,
      })
      await persistLogs(
        ctx,
        node,
        seq,
        startEntry,
        outcome.bodyLogs,
        endEntryOf(node, seq, Date.now(), false),
      )
    }
    return null
  })
}
