import { isWfNodeKind, NODE_KIND_SEEDS, type NodeSeedDefaults } from '../../engine'

import type { EditorNodeData } from './node-renderers'

/** Defaults for freshly-dragged nodes — sourced from the host's models/tools. */
export type NodeDefaults = NodeSeedDefaults

/**
 * Default data for a freshly-dragged palette item, from the engine's
 * `NODE_KIND_SEEDS` table. Model/tool ids come from the host (first available),
 * so no provider is hardcoded. Returns null for a kind with no seed — the
 * template-owned bookends (trigger/output) — and for an unrecognized string,
 * which is possible because the kind arrives as a drag-and-drop payload.
 */
export function defaultDataForKind(
  kind: string,
  defaults?: NodeDefaults,
): EditorNodeData | null {
  if (!isWfNodeKind(kind)) return null
  const seed = NODE_KIND_SEEDS[kind]
  if (!seed) return null
  // Every fresh node starts silent; the inspector's "Inform user" control edits
  // it. Attached once here so no seed in the table need repeat it.
  return { ...seed({ toolId: defaults?.toolId || 'tool' }), informUser: { mode: 'off' } }
}
