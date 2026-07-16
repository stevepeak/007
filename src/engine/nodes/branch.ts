import { resolveBinding } from '../binding'
import type { BranchNode, BranchOperator } from '../graph'

// Deterministic yes/no routing. Unlike the Judge node (which asks a model), the
// Branch node evaluates a predicate over its input in plain code — no LLM, no
// I/O, fully reproducible. `result` drives which outgoing edge the scheduler
// follows; `reasoning` is a human-readable trace persisted for the inspector.

export type BranchNodeResult = {
  result: 'yes' | 'no'
  reasoning: string
}

export type ExecuteBranchNodeDeps = {
  node: BranchNode
  /** The prior node's output — tested when the node has no `source` ref. */
  input: unknown
  /** Live node-output cache, so a `source` ref resolves against an upstream
   * node's output exactly like agent/tool input bindings do. */
  nodeOutputs: Map<string, unknown>
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

// Coerce any value to a string for text comparisons without tripping the
// '[object Object]' foot-gun: objects/arrays serialize as JSON, scalars use
// their own string form, nullish becomes ''.
function scalarString(v: unknown): string {
  if (typeof v === 'string') {
    return v
  }
  if (
    typeof v === 'number' ||
    typeof v === 'boolean' ||
    typeof v === 'bigint'
  ) {
    return String(v)
  }
  // Objects, arrays, and anything else (function/symbol) serialize as JSON;
  // JSON.stringify yields `undefined` for those non-JSON types → treat as ''.
  return JSON.stringify(v) ?? ''
}

// Walk a dotted path into the input. '' returns the whole input. A miss (or a
// null/undefined along the way) yields `undefined`. Array indices work as
// numeric keys (e.g. "pages.0.text"). Shared with the Switch node so both route
// off the same path semantics.
export function resolvePath(input: unknown, path: string): unknown {
  if (!path) {
    return input
  }
  let cur: unknown = input
  for (const key of path.split('.')) {
    if (!isRecord(cur)) {
      return undefined
    }
    cur = cur[key]
  }
  return cur
}

// "Empty" spans the shapes an upstream node realistically produces: nullish,
// the empty string, an empty array, or an object with no own keys. `0` and
// `false` are NOT empty — they're present values.
function isEmptyValue(v: unknown): boolean {
  if (v == null) {
    return true
  }
  if (typeof v === 'string') {
    return v.length === 0
  }
  if (Array.isArray(v)) {
    return v.length === 0
  }
  if (typeof v === 'object') {
    return Object.keys(v).length === 0
  }
  return false
}

// Type-loose equality: if both sides parse as finite numbers, compare
// numerically; otherwise compare by string form. Lets an authored `"3"` match a
// numeric `3` without the author worrying about JSON types. Shared with the
// Switch node so its case matching mirrors Branch's `equals` operator.
export function looseEquals(a: unknown, b: unknown): boolean {
  const na = toNumber(a)
  const nb = toNumber(b)
  if (na != null && nb != null) {
    return na === nb
  }
  return scalarString(a) === scalarString(b)
}

function toNumber(v: unknown): number | null {
  if (typeof v === 'number') {
    return Number.isFinite(v) ? v : null
  }
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function evaluate(
  operator: BranchOperator,
  target: unknown,
  value: unknown,
): boolean {
  switch (operator) {
    case 'is_empty':
      return isEmptyValue(target)
    case 'is_not_empty':
      return !isEmptyValue(target)
    case 'equals':
      return looseEquals(target, value)
    case 'not_equals':
      return !looseEquals(target, value)
    case 'contains':
      return scalarString(target).includes(scalarString(value))
    case 'greater_than': {
      const t = toNumber(target)
      const v = toNumber(value)
      return t != null && v != null && t > v
    }
    case 'less_than': {
      const t = toNumber(target)
      const v = toNumber(value)
      return t != null && v != null && t < v
    }
    default:
      return false
  }
}

export function executeBranchNode(
  deps: ExecuteBranchNodeDeps,
): BranchNodeResult {
  const { node, input, nodeOutputs } = deps
  const { source, operator, value } = node.config
  // A `source` ref selects any upstream node's output (resolved like agent/tool
  // inputs); with none, fall back to the whole incoming input.
  const target = source
    ? resolveBinding(source, nodeOutputs, { nodeId: node.id, name: 'source' })
    : input
  const pass = evaluate(operator, target, value)

  const subject = source
    ? source.path
      ? `${source.nodeId}.${source.path}`
      : source.nodeId
    : 'input'
  const operand =
    operator === 'is_empty' || operator === 'is_not_empty'
      ? ''
      : ` ${JSON.stringify(value ?? null)}`
  return {
    result: pass ? 'yes' : 'no',
    reasoning: `${subject} ${operator}${operand} → ${pass ? 'yes' : 'no'}`,
  }
}
