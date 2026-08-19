import type { ToolContextField, ToolOption } from '../../server/protocol'

// Which ambient run scope an agent playground run has to collect before it can
// go. Pure functions, kept out of the panel so the rule is testable on its own —
// it decides whether the Run button is disabled, which is the kind of thing that
// should never depend on render order.
//
// The rule: only LIVE tools count. A simulated tool never reaches the host's
// `buildRunDeps`, so its declared scope is irrelevant to the run — asking for a
// client uuid to fake a search would be friction with no failure to prevent.
// Flipping a tool to live is what summons its requirement.

/**
 * The context keys the given tools require, restricted to those set to run live.
 * Order follows the tools' own declaration order, de-duplicated.
 */
export function requiredContextKeys(
  tools: readonly ToolOption[],
  live: ReadonlySet<string>,
): string[] {
  const keys: string[] = []
  for (const tool of tools) {
    if (!live.has(tool.id)) continue
    for (const key of tool.requiresContext ?? []) {
      if (!keys.includes(key)) keys.push(key)
    }
  }
  return keys
}

/**
 * The host-declared fields for those keys, in the host's own order. A key the
 * host doesn't declare is dropped rather than rendered as a mystery input — the
 * tool registry and the field list are versioned independently, and a stale
 * declaration shouldn't be able to wedge the Run button on a field nobody can
 * fill.
 */
export function contextFieldsFor(
  fields: readonly ToolContextField[],
  keys: readonly string[],
): ToolContextField[] {
  return fields.filter((f) => keys.includes(f.key))
}

/** The required fields still blank. Whitespace is not a value. */
export function missingContext(
  fields: readonly ToolContextField[],
  values: Record<string, string>,
): ToolContextField[] {
  return fields.filter((f) => (values[f.key] ?? '').trim().length === 0)
}

/** The filled entries, trimmed — what actually goes on the wire. */
export function filledContext(
  fields: readonly ToolContextField[],
  values: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of fields) {
    const v = (values[f.key] ?? '').trim()
    if (v) out[f.key] = v
  }
  return out
}

/**
 * The labels of the context a single tool needs, for the chip on its row —
 * "needs Client". Unknown keys fall back to the raw key so a mis-declared tool
 * is visible rather than silent.
 */
export function contextLabelsFor(
  tool: ToolOption,
  fields: readonly ToolContextField[],
): string[] {
  return (tool.requiresContext ?? []).map(
    (key) => fields.find((f) => f.key === key)?.label ?? key,
  )
}
