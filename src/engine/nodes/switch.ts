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
  /**
   * Deep-rehydrates blob-ref values (a large upstream value spilled to storage)
   * to their real content before matching. Applied to the subject AND to every
   * ref-valued case, since either side of the comparison can address a spilled
   * output — and a pointer compared against real text matches nothing, silently
   * sending every run down the default case.
   */
  rehydrate?: (value: unknown) => Promise<unknown>
}

export async function executeSwitchNode(
  deps: ExecuteSwitchNodeArgs,
): Promise<SwitchNodeResult> {
  const { node, input, nodeOutputs, rehydrate } = deps
  const { source, cases } = node.config
  const rawTarget = source
    ? resolveBinding(source, nodeOutputs, { nodeId: node.id, name: 'source' })
    : input
  const target = rehydrate ? await rehydrate(rawTarget) : rawTarget

  // Resolved up front rather than inside `find`, because the rehydrate is async
  // and `Array.prototype.find` would take the promise itself as truthy and
  // match the first case every time.
  const caseValues = await Promise.all(
    cases.map(async (c) => {
      const raw = resolveBinding(c.value, nodeOutputs, {
        nodeId: node.id,
        name: `case ${c.key}`,
      })
      return rehydrate ? await rehydrate(raw) : raw
    }),
  )
  const hitIndex = cases.findIndex((_, i) => looseEquals(target, caseValues[i]))
  const hit = hitIndex === -1 ? undefined : cases[hitIndex]
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
