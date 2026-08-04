import { interpolateUserText } from './prompt-variables'
import type { StreamSink } from './stream-sink'

// The coarse, USER-FACING "what's happening" line a node emits at start — the
// first-class progress feed. Shared by both backends (inline `executor.ts` and
// the Cloudflare `graph-workflow-dispatch.ts`) so they can never disagree on
// what the user sees. Distinct from the dev-only `node-start` bookend, which
// carries the raw label/kind for the run viewer's structure.

type ProgressNode = {
  id: string
  kind: string
  progressNote?: string
  config?: Record<string, unknown>
}

/**
 * The node's user-facing progress message: the author's `progressNote`
 * (interpolated from run variables), or an empty string when none is set.
 * Nodes are silent in the user feed by DEFAULT — there is no derived-title
 * fallback ("Agent: …"), so a step only surfaces a line when the author gave it
 * one. An agent with `exposeThinking` on streams its reasoning/tool notes
 * instead, which SUPERSEDES the static note (mirroring the disabled note input
 * in the editor), so it too returns empty. Pure — shared by the live emitter
 * below and the editor's simulate preview.
 */
export function nodeProgressMessage(
  node: ProgressNode,
  promptVariables: Record<string, string | undefined> | undefined,
): string {
  const note = node.progressNote?.trim()
  if (!note) return ''
  if (node.kind === 'agent' && node.config?.exposeThinking === true) return ''
  return interpolateUserText(note, promptVariables ?? {}).trim()
}

/**
 * Emit the node's user-facing progress line at start. No-op when the sink can't
 * log or the node has no author-provided progress note.
 */
export function emitNodeStartProgress(
  sink: StreamSink | undefined,
  node: ProgressNode,
  promptVariables: Record<string, string | undefined> | undefined,
): void {
  if (!sink?.log) return
  const message = nodeProgressMessage(node, promptVariables)
  if (!message) return
  void sink.log({
    level: 'progress',
    message,
    nodeId: node.id,
    nodeKind: node.kind,
  })
}
