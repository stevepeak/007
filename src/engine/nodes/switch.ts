import { SWITCH_DEFAULT_CASE, type SwitchNode } from '../graph'

import { looseEquals, resolvePath } from './branch'

// Multi-way deterministic routing — the code sibling of the binary Branch.
// Selects the value at `path` and picks the FIRST case whose `value`
// loosely-equals it (same type-loose compare as Branch's `equals`); if none
// match, routes to the reserved `default` arm. `result` is the winning case key
// (or 'default'), which the scheduler matches against outgoing `edge.condition`.
// Like Branch it passes its input straight through as its output and does no
// I/O, so it's fully reproducible.

export type SwitchNodeResult = {
  /** The winning case key, or `'default'` when nothing matched. */
  result: string
  /** Human-readable trace persisted for the inspector. */
  reasoning: string
}

export type ExecuteSwitchNodeDeps = {
  node: SwitchNode
  /** The prior node's output — the value the cases are matched against. */
  input: unknown
}

export function executeSwitchNode(
  deps: ExecuteSwitchNodeDeps,
): SwitchNodeResult {
  const { node, input } = deps
  const { path, cases } = node.config
  const target = resolvePath(input, path)

  const hit = cases.find((c) => looseEquals(target, c.value))
  const result = hit ? hit.key : SWITCH_DEFAULT_CASE
  const subject = path || 'input'
  const detail = hit
    ? `matched case '${hit.key}'`
    : `no case matched → '${SWITCH_DEFAULT_CASE}'`
  return {
    result,
    reasoning: `${subject} = ${JSON.stringify(target ?? null)} → ${detail}`,
  }
}
