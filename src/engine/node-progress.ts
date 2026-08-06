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
  vars: Record<string, unknown> | undefined,
): string {
  if (node.informUser.mode !== 'static') return ''
  const note = node.informUser.note.trim()
  if (!note) return ''
  return interpolateUserText(note, vars ?? {}).trim()
}

/**
 * Emit the node's user-facing progress line. No-op when the sink can't log or
 * the node has no author-provided progress note. `vars` is the interpolation bag
 * — usually the run's prompt variables, plus whatever built-ins the caller can
 * supply (see `runIteration`, which adds the item count).
 */
export function emitNodeProgress(
  sink: StreamSink | undefined,
  node: ProgressNode,
  vars: Record<string, unknown> | undefined,
): void {
  if (!sink?.log) return
  const message = nodeProgressMessage(node, vars)
  if (!message) return
  void sink.log({
    level: 'progress',
    message,
    nodeId: node.id,
    nodeKind: node.kind,
  })
}

/**
 * Emit the node's progress line at node START — the dispatch-time hook both
 * backends call. Iteration is the one exception and stays silent here: its note
 * is emitted later, from `runIteration`, once the list has been resolved and the
 * item count exists. Authors write `Processing ${n} recipes…` on an iteration,
 * and `n` simply isn't knowable at this point in the run. The exception lives
 * here rather than at the call sites because dispatch is generic over node kind
 * — a per-backend check would be two places to drift.
 */
export function emitNodeStartProgress(
  sink: StreamSink | undefined,
  node: ProgressNode,
  vars: Record<string, unknown> | undefined,
): void {
  if (node.kind === 'iteration') return
  emitNodeProgress(sink, node, vars)
}
