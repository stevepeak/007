import {
  agentOutputJsonSchema,
  ancestorIds,
  ITERATION_ITEM_TRIGGER_KIND,
  predecessorIds,
  SWITCH_DEFAULT_CASE,
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

// The output shape a node produces (for the accessible-data tree). Pass-through
// nodes (branch/switch/feature-request) forward their input, so their
// shape is resolved recursively from their predecessor(s); `seen` guards against
// a malformed cycle.
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

  // Pass-through: branch/switch/feature-request emit exactly what they
  // received.
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

// The RAW output JSON Schema a node produces — like `nodeOutput` but preserving
// the full schema (incl. array `items`) so callers can reason about element
// shapes. Pass-through nodes resolve from their single predecessor.
function nodeOutputSchema(
  node: WorkflowNode,
  maps: IoMaps,
  graph: WorkflowGraph,
  byId: Map<string, WorkflowNode>,
  seen: Set<string>,
): JsonSchema | undefined {
  if (seen.has(node.id)) return undefined
  seen.add(node.id)
  if (node.kind === 'agent') {
    const output = maps.agentsById.get(node.config.agentId)?.output
    return output ? agentOutputJsonSchema(output) : undefined
  }
  if (node.kind === 'tool')
    return maps.toolsById.get(node.config.toolId)?.outputSchema
  if (node.kind === 'trigger') {
    return maps.triggersByKind.get(node.config.triggerKind)?.inputSchema
  }
  if (node.kind === 'workflow') {
    // The callee's output shape is unknown at author time — don't claim one.
    return undefined
  }
  if (node.kind === 'iteration') {
    // An iteration produces an array of per-item RESULTS. We don't infer the
    // result element shape, so surface it as an untyped array (still pickable as
    // a list by a downstream iteration).
    return { type: 'array' }
  }
  if (node.kind === 'output') return undefined
  const preds = predecessorIds(graph, node.id)
    .map((id) => byId.get(id))
    .filter((n): n is WorkflowNode => Boolean(n))
  // A race forwards the winning upstream's output; its inputs share one shape,
  // so resolve from the first predecessor even when several feed in.
  if (node.kind === 'race') {
    return preds.length >= 1
      ? nodeOutputSchema(preds[0], maps, graph, byId, seen)
      : undefined
  }
  if (node.kind === 'aggregate') {
    // A list of per-producer outputs; element shapes differ, so surface an
    // untyped array (still pickable as a list by a downstream iteration).
    return { type: 'array' }
  }
  return preds.length === 1
    ? nodeOutputSchema(preds[0], maps, graph, byId, seen)
    : undefined
}

/** An array-typed value reachable by a node — offered as a pickable iteration
 * source. `path` is the dotted path into the node's INPUT ('' = whole input);
 * `itemSchema` is the element shape, used to infer the loop's `Item`. */
export type ListOption = {
  nodeId: string
  nodeLabel: string
  path: string
  label: string
  itemSchema?: JsonSchema
}

// Walk a schema collecting array-typed fields (depth-bounded), emitting the
// dotted path and each array's element schema.
function collectArrays(
  schema: JsonSchema | undefined,
  parentPath: string,
  depth: number,
  emit: (path: string, itemSchema?: JsonSchema) => void,
): void {
  if (!schema || depth > 3) return
  if (schema.type === 'array') {
    emit(parentPath, schema.items as JsonSchema | undefined)
    return
  }
  if (schema.type === 'object') {
    const props = (schema.properties ?? {}) as Record<string, JsonSchema>
    for (const [key, s] of Object.entries(props)) {
      const path = parentPath ? `${parentPath}.${key}` : key
      collectArrays(s, path, depth + 1, emit)
    }
  }
}

// Every array an iteration node could iterate over: arrays inside its direct
// predecessors' outputs. `path` is expressed relative to the node's resolved
// input (prefixed with the source node id when there's more than one predecessor,
// matching the scheduler's multi-predecessor `{ [sourceId]: output }` shape).
export function accessibleLists(
  graph: WorkflowGraph,
  nodeId: string,
  maps: IoMaps,
): ListOption[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const preds = predecessorIds(graph, nodeId)
    .map((id) => byId.get(id))
    .filter((n): n is WorkflowNode => Boolean(n))
  const multi = preds.length > 1
  const out: ListOption[] = []
  for (const pred of preds) {
    const schema = nodeOutputSchema(pred, maps, graph, byId, new Set())
    collectArrays(schema, '', 0, (relPath, itemSchema) => {
      const path = multi
        ? relPath
          ? `${pred.id}.${relPath}`
          : pred.id
        : relPath
      out.push({
        nodeId: pred.id,
        nodeLabel: pred.label,
        path,
        label: relPath || 'whole output',
        itemSchema,
      })
    })
  }
  return out
}

/** One direct predecessor of an iteration node, with the FULL field tree of its
 * output (array fields carry `itemSchema`). Unlike `accessibleLists` — which
 * pre-flattens to just the array leaves for a dropdown — this preserves the
 * object structure so the list picker can render a drill-down tree identical to
 * the agent/tool/branch data picker, with arrays as the pickable leaves.
 * `wholeIsList` marks a predecessor whose whole output is itself the array. */
export type IterationListSource = {
  nodeId: string
  nodeLabel: string
  /** Several predecessors feed the node, so a list path is prefixed with the
   * source node id (matching the scheduler's `{ [sourceId]: output }` merge). */
  multi: boolean
  wholeIsList: boolean
  wholeItemSchema?: JsonSchema
  fields: DataField[]
}

export function iterationListSources(
  graph: WorkflowGraph,
  nodeId: string,
  maps: IoMaps,
): IterationListSource[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const preds = predecessorIds(graph, nodeId)
    .map((id) => byId.get(id))
    .filter((n): n is WorkflowNode => Boolean(n))
  const multi = preds.length > 1
  return preds.map((pred) => {
    const schema = nodeOutputSchema(pred, maps, graph, byId, new Set())
    const wholeIsList = schema?.type === 'array'
    return {
      nodeId: pred.id,
      nodeLabel: pred.label,
      multi,
      wholeIsList,
      wholeItemSchema: wholeIsList
        ? (schema?.items as JsonSchema | undefined)
        : undefined,
      fields: fieldsOf(schema, ''),
    }
  })
}

/** The `itemsPath` (a dotted path into the iteration node's resolved input) for
 * a list picked out of a predecessor's output. Mirrors `accessibleLists`' path
 * rule so the tree picker and the engine agree: a multi-predecessor input is
 * keyed by source node id, a single-predecessor input IS the output. */
export function iterationItemsPath(
  source: { multi: boolean; nodeId: string },
  fieldPath: string,
): string {
  if (!source.multi) return fieldPath
  return fieldPath ? `${source.nodeId}.${fieldPath}` : source.nodeId
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

// The decision a routing node records as its OWN output — distinct from the
// input it forwards downstream (which `nodeProvides` describes). A Branch records
// a yes/no result; a Switch records the winning case key. Returned so the Data
// tab can show the boolean/enum a decision node produces (visible in the run
// viewer as `recordedOutput`) rather than only its forwarded input. Non-decision
// nodes return null.
export function nodeDecisionOutput(node: WorkflowNode): AccessibleNode | null {
  const reasoning: DataField = {
    key: 'reasoning',
    label: 'reasoning',
    path: 'reasoning',
    type: 'string',
    description: 'Human-readable explanation of why this arm was chosen.',
  }
  if (node.kind === 'branch') {
    return {
      nodeId: node.id,
      label: node.label,
      kind: node.kind,
      wholeType: 'object',
      fields: [
        {
          key: 'result',
          label: 'result',
          path: 'result',
          type: '"yes" | "no"',
          description: 'Whether the predicate held — drives the yes/no edge.',
        },
        reasoning,
      ],
    }
  }
  if (node.kind === 'switch') {
    const keys = node.config.cases.map((c) => c.key)
    const type =
      keys.length > 0
        ? [...keys, SWITCH_DEFAULT_CASE].map((k) => JSON.stringify(k)).join(' | ')
        : 'string'
    return {
      nodeId: node.id,
      label: node.label,
      kind: node.kind,
      wholeType: 'object',
      fields: [
        {
          key: 'result',
          label: 'result',
          path: 'result',
          type,
          description: 'The matching case key — drives which edge is taken.',
        },
        reasoning,
      ],
    }
  }
  return null
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
