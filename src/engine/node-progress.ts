import type { InformUser } from './graph-schema'
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
  informUser: InformUser
}

/**
 * The node's user-facing progress message: the author's static note
 * (interpolated from run variables), or an empty string for any other mode.
 * Nodes are silent in the user feed by DEFAULT — there is no derived-title
 * fallback ("Agent: …"), so a step only surfaces a line in `static` mode.
 * `dynamic` streams reasoning/tool notes instead (and, being a distinct mode,
 * carries no static note to emit); `off` says nothing. Pure — shared by the live
 * emitter below and the editor's simulate preview.
 */
export function nodeProgressMessage(
  node: ProgressNode,
  promptVariables: Record<string, string | undefined> | undefined,
): string {
  if (node.informUser.mode !== 'static') return ''
  const note = node.informUser.note.trim()
  if (!note) return ''
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
