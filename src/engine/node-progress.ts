import { nodeSpanLabel } from './node-label'
import { interpolateUserText } from './prompt-variables'
import type { WfRunManifestEntry } from './run-manifest'
import type { StreamSink } from './stream-sink'

// The coarse, USER-FACING "what's happening" line every node emits at start —
// the first-class progress feed. Shared by both backends (inline `executor.ts`
// and the Cloudflare `graph-workflow-dispatch.ts`) so they can never disagree on
// what the user sees. Distinct from the dev-only `node-start` bookend, which
// carries the raw label/kind for the run viewer's structure.

type ProgressNode = {
  id: string
  kind: string
  label?: string
  progressNote?: string
  config?: unknown
}

/**
 * The node's user-facing progress message: the author's `progressNote`
 * (interpolated from run variables) when set, otherwise a derived title from
 * `nodeSpanLabel` (`Agent: Legal Researcher`, `Tool: Knowledge Base Search`).
 * Pure — shared by the live emitter below and the editor's simulate preview.
 */
export function nodeProgressMessage(
  node: ProgressNode,
  promptVariables: Record<string, string | undefined> | undefined,
  manifest: readonly WfRunManifestEntry[] | undefined,
): string {
  const note = node.progressNote?.trim()
  return note
    ? interpolateUserText(note, promptVariables ?? {}).trim()
    : nodeSpanLabel(node, manifest ?? [])
}

/**
 * Emit the node's user-facing progress line at start. No-op when the sink can't
 * log or the resolved message is empty.
 */
export function emitNodeStartProgress(
  sink: StreamSink | undefined,
  node: ProgressNode,
  promptVariables: Record<string, string | undefined> | undefined,
  manifest: readonly WfRunManifestEntry[] | undefined,
): void {
  if (!sink?.log) return
  const message = nodeProgressMessage(node, promptVariables, manifest)
  if (!message) return
  void sink.log({
    level: 'progress',
    message,
    nodeId: node.id,
    nodeKind: node.kind,
  })
}
