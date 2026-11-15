import {
  connectorOfGroup,
  groupWildcardToolId,
  parseGroupWildcard,
  toolGroupOf,
} from '../../engine/connector-tool-id'
import type { ToolOption } from '../../server/protocol'

// The agent's tool selection as the picker edits it: three config lists read as
// one state per tool.
//
//   • `context`   — the model sees the tool's schema on every turn.
//   • `available` — the model sees only its name and loads it with
//                   `search_tools` when it needs it (`deferredToolIds`).
//   • `off`       — the agent cannot call it.
//
// A group attached whole — a connector (`mcp:<id>:*`) or a host group
// (`app:*`) — gives every one of its tools a DEFAULT state, which is also what
// tools added to it later get. Groups are keyed by `toolGroupOf`. A tool set
// to anything else is an explicit entry: its own id in `toolIds` (context or
// available), or in `disabledToolIds` (off). An entry equal to the default is
// dropped, so the config only ever records the exceptions.

export type ToolSelection = {
  toolIds: string[]
  deferredToolIds: string[]
  disabledToolIds: string[]
}

export type ToolState = 'context' | 'available' | 'off'

/** Drop every trace of `id` from all three lists. */
function strip(sel: ToolSelection, id: string): ToolSelection {
  return {
    toolIds: sel.toolIds.filter((i) => i !== id),
    deferredToolIds: sel.deferredToolIds.filter((i) => i !== id),
    disabledToolIds: sel.disabledToolIds.filter((i) => i !== id),
  }
}

/** What a group's tools get unless set one by one — `off` when it is not
 * attached whole. */
export function groupDefault(sel: ToolSelection, group: string): ToolState {
  const wildcard = groupWildcardToolId(group)
  if (!sel.toolIds.includes(wildcard)) return 'off'
  return sel.deferredToolIds.includes(wildcard) ? 'available' : 'context'
}

export function toolState(sel: ToolSelection, toolId: string): ToolState {
  if (sel.toolIds.includes(toolId)) {
    return sel.deferredToolIds.includes(toolId) ? 'available' : 'context'
  }
  if (sel.disabledToolIds.includes(toolId)) return 'off'
  const group = toolGroupOf(toolId)
  return group ? groupDefault(sel, group) : 'off'
}

/** Set one tool's state, recording it only where it differs from its
 * group's default. An ungrouped tool set `off` is removed. */
export function setToolState(
  sel: ToolSelection,
  toolId: string,
  state: ToolState,
): ToolSelection {
  const base = strip(sel, toolId)
  const group = toolGroupOf(toolId)
  const inherited = group ? groupDefault(base, group) : 'off'
  if (state === inherited) return base
  if (state === 'off') {
    return { ...base, disabledToolIds: [...base.disabledToolIds, toolId] }
  }
  return {
    ...base,
    toolIds: [...base.toolIds, toolId],
    deferredToolIds:
      state === 'available'
        ? [...base.deferredToolIds, toolId]
        : base.deferredToolIds,
  }
}

/**
 * Set what a group's tools get by default — including tools added to it
 * later. Tools set one by one keep their own state; any that now match the
 * default stop being exceptions.
 */
export function setGroupDefault(
  sel: ToolSelection,
  group: string,
  state: ToolState,
): ToolSelection {
  const wildcard = groupWildcardToolId(group)
  const at = sel.toolIds.indexOf(wildcard)
  let next = strip(sel, wildcard)
  if (state !== 'off') {
    const toolIds = [...next.toolIds]
    toolIds.splice(at === -1 ? toolIds.length : at, 0, wildcard)
    next = {
      ...next,
      toolIds,
      deferredToolIds:
        state === 'available'
          ? [...next.deferredToolIds, wildcard]
          : next.deferredToolIds,
    }
  }
  const exceptions = [...sel.toolIds, ...sel.disabledToolIds].filter((id) => {
    return id !== wildcard && toolGroupOf(id) === group
  })
  for (const id of exceptions) {
    if (toolState(sel, id) === state) next = strip(next, id)
  }
  return next
}

/** Remove a group entirely: the whole-group entry and every exception. */
export function detachGroup(sel: ToolSelection, group: string): ToolSelection {
  const keep = (id: string) => toolGroupOf(id) !== group
  return {
    toolIds: sel.toolIds.filter(keep),
    deferredToolIds: sel.deferredToolIds.filter(keep),
    disabledToolIds: sel.disabledToolIds.filter(keep),
  }
}

/** Groups this selection reaches — whole or through single tools — in the
 * order they were first added. */
export function attachedGroups(sel: ToolSelection): string[] {
  const ids = sel.toolIds
    .map((id) => parseGroupWildcard(id) ?? toolGroupOf(id))
    .filter((c): c is string => c != null)
  return [...new Set(ids)]
}

/** One group — a connector or a host group — and its tools. */
export type ToolGroup = {
  id: string
  label: string
  tools: ToolOption[]
}

/** Split tools into the ungrouped ones and one entry per group, keeping the
 * order they arrive in. */
export function groupTools(tools: readonly ToolOption[]): {
  plain: ToolOption[]
  groups: ToolGroup[]
} {
  const plain: ToolOption[] = []
  const groups = new Map<string, ToolGroup>()
  for (const t of tools) {
    const key = toolGroupOf(t.id)
    if (!key) {
      plain.push(t)
      continue
    }
    const group = groups.get(key) ?? {
      id: key,
      label: t.groupLabel ?? connectorOfGroup(key) ?? key,
      tools: [],
    }
    group.tools.push(t)
    groups.set(key, group)
  }
  return { plain, groups: [...groups.values()] }
}

/** A grouped tool's name without the `Label: ` prefix its group already
 * shows. */
export function nameInGroup(tool: ToolOption, group: ToolGroup): string {
  const prefix = `${group.label}: `
  return tool.name.startsWith(prefix) ? tool.name.slice(prefix.length) : tool.name
}
