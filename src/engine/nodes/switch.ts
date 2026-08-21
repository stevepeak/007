import { resolveBinding } from '../binding'
import { SWITCH_DEFAULT_CASE, type SwitchNode } from '../graph'

import { looseEquals } from './branch'

// Multi-way deterministic routing — the code sibling of the binary Branch.
// Selects the value its `source` ref addresses (or the whole incoming input
// when unbound) and picks the FIRST case whose value loosely-equals it (same
// type-loose compare as Branch's `equals`); if none match, routes to the
// reserved `default` arm. A case's value is itself a binding, so a case is
// either a literal the author typed or another upstream value the input must
// equal. `result` is the winning case key (or 'default'), which the scheduler
// matches against outgoing `edge.condition`. Like Branch it does no I/O, so
// it's fully reproducible.

export type SwitchNodeResult = {
  /** The winning case key, or `'default'` when nothing matched. */
  result: string
  /** Human-readable trace persisted for the inspector. */
  reasoning: string
}

export type ExecuteSwitchNodeArgs = {
  node: SwitchNode
  /** The prior node's output — matched when the node has no `source` ref. */
  input: unknown
  /** Live node-output cache, so `source` and any ref-valued case resolve
   * against an upstream node's output exactly like agent/tool bindings do. */
  nodeOutputs: Map<string, unknown>
}

export function executeSwitchNode(
  deps: ExecuteSwitchNodeArgs,
): SwitchNodeResult {
  const { node, input, nodeOutputs } = deps
  const { source, cases } = node.config
  const target = source
    ? resolveBinding(source, nodeOutputs, { nodeId: node.id, name: 'source' })
    : input

  const hit = cases.find((c) =>
    looseEquals(
      target,
      resolveBinding(c.value, nodeOutputs, {
        nodeId: node.id,
        name: `case ${c.key}`,
      }),
    ),
  )
  const result = hit ? hit.key : SWITCH_DEFAULT_CASE
  const subject = source
    ? source.path
      ? `${source.nodeId}.${source.path}`
      : source.nodeId
    : 'input'
  const detail = hit
    ? `matched case '${hit.key}'`
    : `no case matched → '${SWITCH_DEFAULT_CASE}'`
  return {
    result,
    reasoning: `${subject} = ${JSON.stringify(target ?? null)} → ${detail}`,
  }
}
