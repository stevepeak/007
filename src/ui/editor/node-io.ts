import {
  agentOutputJsonSchema,
  ancestorIds,
  ITERATION_ITEM_TRIGGER_KIND,
  predecessorIds,
  SWITCH_DEFAULT_CASE,
  type ArgBinding,
  type JsonSchema,
  type WorkflowGraph,
  type WorkflowNode,
} from '../../engine'
import type {
  ToolOption,
  TriggerEventOption,
  WfAgentSummary,
} from '../../server/protocol'

// Pure data-flow model for the editor: what a node *requires* (its mappable
// inputs), what a node *outputs* (a field tree), and — walking the graph
// backwards — what upstream data is *accessible* to a given node. No React here
// so it can be unit-tested and reused.

/** A field in a node's output, addressable by a dotted `path` from the root. */
export type DataField = {
  key: string
  label: string
  /** Dotted path into the producing node's output (e.g. "results.0.url"). */
  path: string
  /** JSON Schema `type` (string/number/object/array/…) or "unknown". */
  type: string
  description?: string
  /** Nested fields when `type` is `object`. */
  children?: DataField[]
  /** Element fields when `type` is `array` — the shape of each item. Shown in
   * the read-only data tree so an array's contents are visible; NOT offered in
   * the binding picker (a whole array binds as one leaf, since element indices
   * aren't known at author time). */
  items?: DataField[]
  /** Raw JSON Schema of one array element when `type` is `array`. Powers the
   * iteration list picker: selecting this field as the loop's list persists this
   * as the inferred `itemSchema` so the inner `Item` node can expose the
   * element's fields. */
  itemSchema?: JsonSchema
}

/** A single value a node needs supplied — an agent variable or tool argument. */
export type NodeInput = {
  key: string
  label: string
  required: boolean
  description?: string
  type?: string
  /** Allowed values when the input is a JSON Schema enum — the literal editor
   * offers these as a picker instead of a free-text box. */
  enum?: unknown[]
}

/** An upstream node and the shape of the data it makes available. */
export type AccessibleNode = {
  nodeId: string
  label: string
  kind: WorkflowNode['kind']
  /** Top-level fields of the node's output; empty when the shape is unknown. */
  fields: DataField[]
  /** How to describe the whole output ("object", "text", "passthrough", …). */
  wholeType: string
}

export type IoMaps = {
  toolsById: Map<string, ToolOption>
  agentsById: Map<string, WfAgentSummary>
  triggersByKind: Map<string, TriggerEventOption>
}

export function buildIoMaps(
  tools: ToolOption[],
  agents: WfAgentSummary[],
  triggers: TriggerEventOption[],
): IoMaps {
  return {
    toolsById: new Map(tools.map((t) => [t.id, t])),
    agentsById: new Map(agents.map((a) => [a.id, a])),
    triggersByKind: new Map(triggers.map((t) => [t.kind, t])),
  }
}

function schemaType(schema: JsonSchema | undefined): string {
  return typeof schema?.type === 'string' ? schema.type : 'unknown'
}

// The JSON-ish type of a literal binding's value — for a Passthrough's authored
// field tree. Nullish is opaque ('unknown'); everything else maps to its JSON
// container type so a `{ name: "…" }` literal reports `string`, matching a
// sibling agent that emits `{ name: string }`.
function jsonTypeOf(v: unknown): string {
  if (Array.isArray(v)) return 'array'
  if (v === null || v === undefined) return 'unknown'
  const t = typeof v
  return t === 'object' ? 'object' : t
}

// Find a field's declared type by its dotted `path` within a resolved field
// tree (depth-first). Used to type a Passthrough `ref` binding from the shape of
// the node it points at. Returns undefined when the path isn't a known field
// (e.g. an array-index path), so the caller falls back to 'unknown'.
function fieldTypeAtPath(
  fields: DataField[],
  path: string,
): string | undefined {
  for (const f of fields) {
    if (f.path === path) return f.type
    if (f.children) {
      const t = fieldTypeAtPath(f.children, path)
      if (t) return t
    }
  }
  return undefined
}

// The element shape of an array schema, as display-only `items` fields. Objects
// expand to their properties; a scalar/opaque element becomes a single `[ ]`
// leaf so the reader still sees the element's type. Paths carry a `[]` segment
// to signal "each element" — they are for display only (the binding picker never
// offers them, since a real index isn't known at author time).
function itemFieldsOf(
  itemSchema: JsonSchema | undefined,
  arrayPath: string,
): DataField[] | undefined {
  if (!itemSchema) return undefined
  const elemPath = `${arrayPath}[]`
  if (itemSchema.type === 'object') return fieldsOf(itemSchema, elemPath)
  return [
    {
      key: '[]',
      label: '[ ]',
      path: elemPath,
      type: schemaType(itemSchema),
      description:
        typeof itemSchema.description === 'string'
          ? itemSchema.description
          : undefined,
    },
  ]
}

// Walks a JSON Schema `object` into a field tree. Nested objects recurse; arrays
// surface as a single bindable leaf (bind the whole array, or type a manual index
// path) but carry their element shape in `items` so the read-only tree can show
// what each element contains.
function fieldsOf(
  schema: JsonSchema | undefined,
  parentPath: string,
): DataField[] {
  if (!schema || schema.type !== 'object') return []
  const props = (schema.properties ?? {}) as Record<string, JsonSchema>
  return Object.entries(props).map(([key, s]) => {
    const path = parentPath ? `${parentPath}.${key}` : key
    return {
      key,
      label: key,
      path,
      type: schemaType(s),
      description:
        typeof s.description === 'string' ? s.description : undefined,
      children: s.type === 'object' ? fieldsOf(s, path) : undefined,
      items:
        s.type === 'array'
          ? itemFieldsOf(s.items as JsonSchema | undefined, path)
          : undefined,
      itemSchema:
        s.type === 'array' ? (s.items as JsonSchema | undefined) : undefined,
    }
  })
}

// The inputs a node needs supplied via bindings.
export function nodeRequires(node: WorkflowNode, maps: IoMaps): NodeInput[] {
  if (node.kind === 'agent') {
    const agent = maps.agentsById.get(node.config.agentId)
    return (agent?.inputVariables ?? []).map((v) => ({
      key: v,
      label: v,
      required: true,
      type: 'string',
    }))
  }
  if (node.kind === 'tool') {
    const schema = maps.toolsById.get(node.config.toolId)?.inputSchema
    if (!schema || schema.type !== 'object') return []
    const props = (schema.properties ?? {}) as Record<string, JsonSchema>
    const required = new Set((schema.required as string[] | undefined) ?? [])
    return Object.entries(props).map(([key, s]) => ({
      key,
      label: key,
      required: required.has(key),
      description:
        typeof s.description === 'string' ? s.description : undefined,
      type: schemaType(s),
      enum: Array.isArray(s.enum) ? s.enum : undefined,
    }))
  }
  return []
}

// The required inputs a node has left unbound — an agent prompt variable or a
// required tool argument with no literal/ref mapping. Drives the "missing
// required data link" issues. Non-agent/tool nodes have no bindable inputs.
export function missingRequiredInputs(
  node: WorkflowNode,
  maps: IoMaps,
): string[] {
  const bindings =
    node.kind === 'agent'
      ? (node.config.inputs ?? {})
      : node.kind === 'tool'
        ? (node.config.args ?? {})
        : null
  if (!bindings) return []
  return nodeRequires(node, maps)
    .filter((input) => input.required && !bindings[input.key])
    .map((input) => input.key)
}

// Re-roots a field tree under a `prefix` path segment — used when a node has
// several predecessors and downstream sees `{ [sourceNodeId]: output }`.
function repath(fields: DataField[], prefix: string): DataField[] {
  return fields.map((f) => ({
    ...f,
    path: `${prefix}.${f.path}`,
    children: f.children ? repath(f.children, prefix) : undefined,
    items: f.items ? repath(f.items, prefix) : undefined,
  }))
}

// The recorded-decision output of a routing node — what a Branch/Switch
// produces now that it no longer forwards its input. A Branch reports a yes/no
// `result`; a Switch reports the winning case key (typed as the union of its
// declared case keys plus `default`). Both carry a `reasoning` string.
function decisionOutputFields(node: WorkflowNode): DataField[] {
  const reasoning: DataField = {
    key: 'reasoning',
    label: 'reasoning',
    path: 'reasoning',
    type: 'string',
    description: 'Human-readable explanation of why this arm was chosen.',
  }
  if (node.kind === 'switch') {
    const keys = node.config.cases.map((c) => c.key)
    const type =
      keys.length > 0
        ? [...keys, SWITCH_DEFAULT_CASE].map((k) => JSON.stringify(k)).join(' | ')
        : 'string'
    return [
      {
        key: 'result',
        label: 'result',
        path: 'result',
        type,
        description: 'The matching case key — drives which edge is taken.',
      },
      reasoning,
    ]
  }
  return [
    {
      key: 'result',
      label: 'result',
      path: 'result',
      type: '"yes" | "no"',
      description: 'Whether the predicate held — drives the yes/no edge.',
    },
    reasoning,
  ]
}

// The output shape a node produces (for the accessible-data tree). Branch/switch
// emit their decision (`{ result, reasoning }`), not their input — nodes no
// longer forward data, so downstream reads a routing node's boolean/enum, and
// reaches pre-routing data by ref-ing the producer directly. The remaining
// pass-through kind (feature-request, an unbuilt placeholder) still resolves its
// shape from its predecessor(s); `seen` guards against a malformed cycle.
function nodeOutput(
  node: WorkflowNode,
  maps: IoMaps,
  graph: WorkflowGraph,
  byId: Map<string, WorkflowNode>,
  seen: Set<string>,
): { fields: DataField[]; type: string } {
  if (seen.has(node.id)) return { fields: [], type: 'unknown' }
  seen.add(node.id)

  if (node.kind === 'agent') {
    const output = maps.agentsById.get(node.config.agentId)?.output
    if (!output) return { fields: [], type: 'unknown' }
    return {
      fields: fieldsOf(agentOutputJsonSchema(output), ''),
      type: output.kind,
    }
  }
  if (node.kind === 'tool') {
    const schema = maps.toolsById.get(node.config.toolId)?.outputSchema
    // Reflect the schema's real container type (object/array/…) instead of
    // always claiming "object" — a tool that returns an array or scalar was
    // being mislabeled.
    return { fields: fieldsOf(schema, ''), type: schema ? schemaType(schema) : 'unknown' }
  }
  if (node.kind === 'trigger') {
    const schema = maps.triggersByKind.get(node.config.triggerKind)?.inputSchema
    // The iteration `Item` trigger emits one list element; its shape is injected
    // into the maps (from the parent iteration's inferred `itemSchema`).
    if (node.config.triggerKind === ITERATION_ITEM_TRIGGER_KIND) {
      const t = typeof schema?.type === 'string' ? schema.type : 'item'
      return { fields: fieldsOf(schema, ''), type: schema ? t : 'item' }
    }
    // Only host-declared events carry a payload shape; manual/periodic don't.
    return { fields: fieldsOf(schema, ''), type: schema ? 'event' : 'trigger' }
  }
  if (node.kind === 'output') return { fields: [], type: 'none' }
  if (node.kind === 'workflow') {
    // A workflow node emits the CALLEE's output, whose shape isn't known here
    // (it's the other workflow's Output value). Surface it as one opaque leaf
    // rather than guessing — and never fall through to the pass-through branch,
    // which would wrongly show this node's INPUT shape as its output.
    return { fields: [], type: 'workflow' }
  }
  if (node.kind === 'iteration') {
    // A collection of per-item results. The element shape isn't known at author
    // time, so surface the whole array as one bindable leaf rather than guessing.
    return { fields: [], type: 'array' }
  }
  if (node.kind === 'race') {
    // A race passes the winning upstream's output through untouched. Its inputs
    // all share one shape, so downstream sees that single shape — resolve from
    // the first predecessor rather than the multi-keyed object a fan-in yields.
    const preds = predecessorIds(graph, node.id)
      .map((id) => byId.get(id))
      .filter((n): n is WorkflowNode => Boolean(n))
    return preds.length >= 1
      ? nodeOutput(preds[0], maps, graph, byId, seen)
      : { fields: [], type: 'passthrough' }
  }
  if (node.kind === 'aggregate') {
    // A wait-for-all join: collects each producer's output into an ordered list.
    // The element shapes vary by producer, so surface the whole array as one
    // bindable leaf (like iteration) rather than inventing a uniform element
    // shape — a downstream iteration can still pick it as its list.
    return { fields: [], type: 'array' }
  }
  if (node.kind === 'branch' || node.kind === 'switch') {
    // Routing nodes emit their decision, not a forwarded input.
    return { fields: decisionOutputFields(node), type: 'object' }
  }
  if (node.kind === 'passthrough') {
    // A Passthrough emits an AUTHORED shape, not its predecessor's: `value`
    // forwards one binding UNWRAPPED, `fields` builds an object keyed by the
    // author's names. Resolve each binding's type from the node it points at so
    // downstream pickers can bind into it and the race shape-match check
    // (`raceInputShapeCount`) sees the shape this arm really contributes. With
    // neither set it's a pure identity — fall through to the shared pass-through
    // resolution below so it reports its predecessor's shape.
    const bindingType = (binding: ArgBinding): string => {
      if (binding.kind === 'literal') return jsonTypeOf(binding.value)
      const src = byId.get(binding.nodeId)
      if (!src) return 'unknown'
      const out = nodeOutput(src, maps, graph, byId, new Set(seen))
      return binding.path
        ? (fieldTypeAtPath(out.fields, binding.path) ?? 'unknown')
        : out.type
    }
    const { value, fields } = node.config
    if (value) return { fields: [], type: bindingType(value) }
    const entries = Object.entries(fields ?? {})
    if (entries.length > 0) {
      return {
        fields: entries.map(([key, binding]) => ({
          key,
          label: key,
          path: key,
          type: bindingType(binding),
        })),
        type: 'object',
      }
    }
    // identity → fall through to the pass-through resolution below.
  }

  // Pass-through: feature-request (an unbuilt placeholder) and an unconfigured
  // Passthrough emit exactly what they received.
  const preds = predecessorIds(graph, node.id)
    .map((id) => byId.get(id))
    .filter((n): n is WorkflowNode => Boolean(n))
  if (preds.length === 1) {
    return nodeOutput(preds[0], maps, graph, byId, seen)
  }
  if (preds.length > 1) {
    // Multiple predecessors → downstream sees an object keyed by source node id.
    const fields = preds.map((p) => {
      const out = nodeOutput(p, maps, graph, byId, new Set(seen))
      return {
        key: p.id,
        label: p.label,
        path: p.id,
        type: 'object',
        children: repath(out.fields, p.id),
      }
    })
    return { fields, type: 'object' }
  }
  return { fields: [], type: 'passthrough' }
}

// Return a maps copy whose iteration `Item` trigger resolves to `itemSchema`, so
// nodes inside a loop see the element's fields. No-op without a schema.
export function withIterationItemSchema(
  maps: IoMaps,
  itemSchema: JsonSchema | undefined,
): IoMaps {
  if (!itemSchema) return maps
  const triggersByKind = new Map(maps.triggersByKind)
  triggersByKind.set(ITERATION_ITEM_TRIGGER_KIND, {
    kind: ITERATION_ITEM_TRIGGER_KIND,
    description: 'Current item',
    fields: [],
    inputSchema: itemSchema,
  })
  return { ...maps, triggersByKind }
}

// A stable signature of a node's output shape (its `wholeType` + normalized
// field tree), for comparing whether two nodes emit the same shape. Returns null
// when the shape can't be inferred (unknown / passthrough / opaque), so callers
// skip un-comparable inputs rather than flagging a false mismatch.
function shapeSignature(out: { fields: DataField[]; type: string }): string | null {
  const OPAQUE = new Set(['unknown', 'passthrough', 'workflow'])
  if (OPAQUE.has(out.type) && out.fields.length === 0) return null
  const norm = (fields: DataField[]): string =>
    fields
      .map((f) => `${f.key}:${f.type}${f.children ? `{${norm(f.children)}}` : ''}`)
      .sort()
      .join(',')
  return `${out.type}|${norm(out.fields)}`
}

// A Race passes its winning upstream's output through untouched, so the consumer
// sees ONE shape only if every input produces the same shape. This returns the
// distinct, inferable input shapes feeding a race node — >1 means the author has
// wired mismatched producers together. Un-inferable inputs are skipped (we can't
// prove them mismatched). Empty/one entry → no problem to report.
export function raceInputShapeCount(
  graph: WorkflowGraph,
  nodeId: string,
  maps: IoMaps,
): number {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const signatures = new Set<string>()
  for (const predId of predecessorIds(graph, nodeId)) {
    const pred = byId.get(predId)
    if (!pred) continue
    const sig = shapeSignature(nodeOutput(pred, maps, graph, byId, new Set()))
    if (sig != null) signatures.add(sig)
  }
  return signatures.size
}

// Whether a node's resolved output would satisfy runtime `coerceToMessages` —
// i.e. it carries a top-level `messages` array (the chat trigger's payload, or
// anything that forwards it unchanged). Detected the same way `nodeOutput`
// surfaces a trigger's `messages: array` field.
function carriesThread(out: { fields: DataField[] }): boolean {
  return out.fields.some((f) => f.key === 'messages' && f.type === 'array')
}

/**
 * How the prior conversation reaches an agent node. Two things decide it, and
 * they're deliberately separate:
 *  1. the AGENT declares whether it works on a thread at all
 *     (`AgentConfig.acceptsConversation`) — that's what makes the node's
 *     `conversation` input exist;
 *  2. the NODE says WHERE that thread comes from (`config.conversation`) — the
 *     only thing that feeds history at run time (see `engine/nodes/agent.ts`).
 *
 *  - `linked`: the agent accepts a conversation and the node links a source.
 *  - `unlinked`: accepts, not linked, but a message source (a chat trigger's
 *    `messages`) is reachable on the primary path — the author almost certainly
 *    means to link it, so this drives an editor warning. Unlinked at run time,
 *    the agent answers only the current turn with no prior context.
 *  - `idle`: accepts, not linked, and no source is reachable — the input is
 *    offered but there's nothing obvious to point it at yet.
 *  - `unsupported`: the node links a conversation but the agent does NOT declare
 *    that it accepts one (e.g. the toggle was turned off after wiring, or the
 *    agent has no published version yet) — a blocking editor issue.
 *  - `none`: the agent takes a single input value — no conversation input.
 */
export type ThreadStatus =
  | { status: 'linked'; sourceId: string; sourceLabel: string }
  | { status: 'unlinked'; sourceId: string; sourceLabel: string }
  | { status: 'unsupported'; sourceId: string; sourceLabel: string }
  | { status: 'idle' }
  | { status: 'none' }

/**
 * Whether the agent a node points at declares that it takes a chat thread. Read
 * from the agent's LATEST PUBLISHED config (like `inputVariables`), so toggling
 * it on an agent draft only reaches workflow editors once the agent is published.
 */
export function agentAcceptsConversation(
  node: WorkflowNode,
  maps: IoMaps,
): boolean {
  if (node.kind !== 'agent') return false
  return maps.agentsById.get(node.config.agentId)?.acceptsConversation ?? false
}

export function agentThreadSource(
  graph: WorkflowGraph,
  nodeId: string,
  maps: IoMaps,
): ThreadStatus {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const node = byId.get(nodeId)
  if (!node || node.kind !== 'agent') return { status: 'none' }
  const accepts = agentAcceptsConversation(node, maps)

  // An explicit `conversation` binding is the linked message source — reported
  // even when the agent doesn't declare a conversation, so a stale link is
  // visible (and clearable) rather than silently ignored.
  const bound = node.config.conversation
  if (bound) {
    const src = bound.kind === 'ref' ? byId.get(bound.nodeId) : undefined
    return {
      status: accepts ? 'linked' : 'unsupported',
      sourceId: src?.id ?? '',
      sourceLabel: src?.label ?? (bound.kind === 'literal' ? 'literal' : '—'),
    }
  }

  // The agent takes a single input value — there is no conversation to wire.
  if (!accepts) return { status: 'none' }

  // Accepts but unlinked — is a message source reachable on the primary path? If
  // so, the author almost certainly wants it linked; surface it (→ warning) with
  // that source so the fix ("link to <source>") is obvious.
  const src = reachableMessageSource(graph, node.id, byId, maps)
  return src
    ? { status: 'unlinked', sourceId: src.id, sourceLabel: src.label }
    : { status: 'idle' }
}

// The nearest message-carrying node on an agent's single-predecessor path: the
// direct predecessor if it carries `{ messages }` (resolving through race/
// passthrough transparency via `nodeOutput`), else one hop up when a reshaping
// node sits between the source and the agent. Undefined for a fan-in (a join
// hides `messages` behind a source-keyed object) or when no source is near.
function reachableMessageSource(
  graph: WorkflowGraph,
  nodeId: string,
  byId: Map<string, WorkflowNode>,
  maps: IoMaps,
): { id: string; label: string } | undefined {
  const preds = predecessorIds(graph, nodeId)
  if (preds.length !== 1) return undefined
  const pred = byId.get(preds[0])
  if (!pred) return undefined
  if (carriesThread(nodeOutput(pred, maps, graph, byId, new Set()))) {
    return { id: pred.id, label: pred.label }
  }
  const grandIds = predecessorIds(graph, pred.id)
  if (grandIds.length === 1) {
    const grand = byId.get(grandIds[0])
    if (grand && carriesThread(nodeOutput(grand, maps, graph, byId, new Set()))) {
      return { id: grand.id, label: grand.label }
    }
  }
  return undefined
}

// Coarse type compatibility, matching the granularity the field model produces
// (string/number/object/array). A text agent's WHOLE output is typed 'text' but
// is structurally a string, so it satisfies a `string` contract; JSON integers
// satisfy a `number` contract.
function coarseCompatible(want: string, got: string): boolean {
  if (want === got) return true
  if (want === 'string') return got === 'text'
  if (want === 'number') return got === 'integer'
  return false
}

// Depth-first lookup of a field by its dotted `path` (returns the field itself,
// not just its type — so callers can descend into its children).
function findField(fields: DataField[], path: string): DataField | undefined {
  for (const f of fields) {
    if (f.path === path) return f
    if (f.children) {
      const g = findField(f.children, path)
      if (g) return g
    }
  }
  return undefined
}

// The active trigger's declared output contract (JSON Schema), or undefined when
// the graph's trigger declares none. Exactly one trigger is expected; the first
// is used if a malformed graph has more.
function triggerOutputContract(
  graph: WorkflowGraph,
  maps: IoMaps,
): JsonSchema | undefined {
  const trigger = graph.nodes.find((n) => n.kind === 'trigger')
  if (trigger?.kind !== 'trigger') return undefined
  return maps.triggersByKind.get(trigger.config.triggerKind)?.outputContract
}

// A bound value, resolved for the contract check: its coarse type and (for an
// object) its top-level fields.
type BoundValue = { type: string; fields: DataField[] }

// Does a bound value satisfy one JSON-Schema contract? Coarse (string/object/
// array/number) — not a deep structural equivalence. A `{ text }` object
// contract accepts a value carrying a `text` field; a `string` contract accepts
// a bare string. An `anyOf` (union) is satisfied when ANY branch is — so a
// contract of "string OR { text }" accepts both binding the `text` field
// directly and binding the whole `{ text }` output.
function satisfiesContract(contract: JsonSchema, bound: BoundValue): boolean {
  const anyOf = (contract as { anyOf?: JsonSchema[] }).anyOf
  if (Array.isArray(anyOf)) {
    return anyOf.some((c) => satisfiesContract(c, bound))
  }
  const t = typeof contract.type === 'string' ? contract.type : 'unknown'
  if (t === 'object') {
    const props = (contract.properties ?? {}) as Record<string, JsonSchema>
    const required = new Set<string>(
      Array.isArray(contract.required)
        ? (contract.required as string[])
        : Object.keys(props),
    )
    return Object.entries(props).every(([key, sub]) => {
      if (!required.has(key)) return true
      const want = typeof sub.type === 'string' ? sub.type : 'unknown'
      const field = bound.fields.find((f) => f.key === key)
      return field ? coarseCompatible(want, field.type) : false
    })
  }
  return coarseCompatible(t, bound.type)
}

// A short human description of what a contract accepts, for the error message.
function describeContract(contract: JsonSchema): string {
  const anyOf = (contract as { anyOf?: JsonSchema[] }).anyOf
  if (Array.isArray(anyOf)) {
    return [...new Set(anyOf.map(describeContract))].join(' or ')
  }
  const t = typeof contract.type === 'string' ? contract.type : 'a value'
  if (t === 'object') {
    const keys = Object.keys((contract.properties ?? {}) as object)
    return keys.length ? `a { ${keys.join(', ')} } value` : 'an object'
  }
  return t === 'string' ? 'text' : t
}

// Author-time check that an Output node's bound value satisfies the active
// trigger's output contract. Returns a human message when it doesn't, or
// undefined when it does (or there's nothing to check: no contract declared, no
// source bound yet — the unbound case is a distinct, more pointed error raised in
// `collectGraphIssues`).
export function outputContractIssue(
  graph: WorkflowGraph,
  output: Extract<WorkflowNode, { kind: 'output' }>,
  maps: IoMaps,
): string | undefined {
  const contract = triggerOutputContract(graph, maps)
  if (!contract) return undefined
  const source = output.config.source
  if (!source) return undefined // unbound → handled by collectGraphIssues
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const src = byId.get(source.nodeId)
  if (!src) return undefined // dangling ref → handled by the strict schema gate
  const out = nodeOutput(src, maps, graph, byId, new Set())
  // Narrow to the value AT the bound path: the whole output, or the sub-field.
  const bound: BoundValue = source.path
    ? (() => {
        const f = findField(out.fields, source.path)
        return { fields: f?.children ?? [], type: f?.type ?? 'unknown' }
      })()
    : out
  if (satisfiesContract(contract, bound)) return undefined
  const where = `${src.label} · ${source.path || 'whole output'}`
  return `The Output must send ${describeContract(contract)}, but “${where}” is ${bound.type}.`
}

// The output shape the node itself produces — what it makes available to nodes
// downstream of it. Mirrors one entry of `accessibleData`, but for the node in
// hand (e.g. a Trigger, which has no upstream but still *provides* its payload).
export function nodeProvides(
  graph: WorkflowGraph,
  nodeId: string,
  maps: IoMaps,
): AccessibleNode | null {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const node = byId.get(nodeId)
  if (!node) return null
  const out = nodeOutput(node, maps, graph, byId, new Set())
  return {
    nodeId: node.id,
    label: node.label,
    kind: node.kind,
    fields: out.fields,
    wholeType: out.type,
  }
}

// Every node structurally upstream of `nodeId`, nearest-first, with its output
// shape resolved — the tree of data the node can map from.
export function accessibleData(
  graph: WorkflowGraph,
  nodeId: string,
  maps: IoMaps,
): AccessibleNode[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const result: AccessibleNode[] = []
  // The iteration `Item` trigger starts its subgraph, so it has no ancestors —
  // but it *is* the data source inside the loop. Surface its own (element) output
  // so selecting it shows the current item's fields instead of "no upstream nodes".
  const self = byId.get(nodeId)
  if (
    self?.kind === 'trigger' &&
    self.config.triggerKind === ITERATION_ITEM_TRIGGER_KIND
  ) {
    const out = nodeOutput(self, maps, graph, byId, new Set())
    result.push({
      nodeId: self.id,
      label: self.label,
      kind: self.kind,
      fields: out.fields,
      wholeType: out.type,
    })
  }
  for (const id of ancestorIds(graph, nodeId)) {
    const node = byId.get(id)
    if (!node) continue
    const out = nodeOutput(node, maps, graph, byId, new Set())
    result.push({
      nodeId: node.id,
      label: node.label,
      kind: node.kind,
      fields: out.fields,
      wholeType: out.type,
    })
  }
  return result
}
