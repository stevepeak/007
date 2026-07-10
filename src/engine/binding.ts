import type { ArgBinding } from './graph'

// Shared resolution for node input bindings (tool `args`, agent `inputs`). A
// binding is either a literal value or a `ref` into a prior node's cached
// output, addressed by a dotted path. Kept in one place so tool and agent nodes
// resolve data identically.

// Walks a dotted path (e.g. "documents.0.id") through a value. Empty path
// returns the value as-is. Missing intermediate keys return undefined.
export function resolvePath(value: unknown, path: string): unknown {
  if (!path) {
    return value
  }
  const segments = path.split('.')
  let current: unknown = value
  for (const seg of segments) {
    if (current === null || current === undefined) {
      return undefined
    }
    if (Array.isArray(current)) {
      const idx = Number.parseInt(seg, 10)
      if (Number.isNaN(idx)) {
        return undefined
      }
      current = current[idx]
      continue
    }
    if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[seg]
      continue
    }
    return undefined
  }
  return current
}

// Resolves a single binding to a concrete value. `ctx` identifies the consuming
// node + input name for a clear error when a ref points at a node that has not
// produced an output (e.g. an unreachable branch arm or a mis-wired graph).
export function resolveBinding(
  binding: ArgBinding,
  nodeOutputs: Map<string, unknown>,
  ctx: { nodeId: string; name: string },
): unknown {
  if (binding.kind === 'literal') {
    return binding.value
  }
  const source = nodeOutputs.get(binding.nodeId)
  if (source === undefined) {
    throw new Error(
      `Node ${ctx.nodeId} input '${ctx.name}' references node ${binding.nodeId} which has no recorded output.`,
    )
  }
  return resolvePath(source, binding.path)
}
