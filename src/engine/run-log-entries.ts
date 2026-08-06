import type { ExecutableNode } from './scheduler'
import type { RunLogEntry } from './stream-sink'

// The two bookend entries that open and close a node's feed ("▶ Structure the
// document" … "✓ Structure the document"). They live in the engine rather than
// in a backend because BOTH backends emit them and the run viewer's notion of
// "which node is active" is derived from them — a `node-start` with no matching
// `node-end`. A backend that skipped them would render as a run where nothing is
// happening.

/** Human label for a node in the log feed, falling back to its kind. */
export function nodeLabel(node: ExecutableNode): string {
  return (node as { label?: string }).label?.trim() || node.kind
}

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

export function endEntryOf(
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
