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
  WfWorkflowListItem,
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
  /** Callees of Workflow nodes — carries each one's trigger kind. */
  workflowsById: Map<string, WfWorkflowListItem>
}

export function buildIoMaps(
  tools: ToolOption[],
  agents: WfAgentSummary[],
  triggers: TriggerEventOption[],
  workflows: WfWorkflowListItem[] = [],
): IoMaps {
  return {
    toolsById: new Map(tools.map((t) => [t.id, t])),
    agentsById: new Map(agents.map((a) => [a.id, a])),
    triggersByKind: new Map(triggers.map((t) => [t.kind, t])),
    workflowsById: new Map(workflows.map((w) => [w.id, w])),
  }
}

/**
 * The trigger payload a Workflow node's callee accepts, as JSON Schema — the
 * callee's own trigger `inputSchema`, looked up through the catalog. Undefined
 * when the callee is unpicked, unpublished, or its trigger kind isn't a
 * registered event (manual/periodic take no declared payload).
 */
function calleeInputSchema(
  workflowId: string,
  maps: IoMaps,
): JsonSchema | undefined {
  const kind = maps.workflowsById.get(workflowId)?.triggerKind
  if (!kind) return undefined
  return maps.triggersByKind.get(kind)?.inputSchema
}

/** Object-schema properties as bindable inputs. Shared by tool + workflow nodes. */
function inputsOfSchema(schema: JsonSchema | undefined): NodeInput[] {
  if (!schema || schema.type !== 'object') return []
  const props = (schema.properties ?? {}) as Record<string, JsonSchema>
  const required = new Set((schema.required as string[] | undefined) ?? [])
  return Object.entries(props).map(([key, s]) => ({
    key,
    label: key,
    required: required.has(key),
    description: typeof s.description === 'string' ? s.description : undefined,
    type: schemaType(s),
    enum: Array.isArray(s.enum) ? s.enum : undefined,
  }))
}

function schemaType(schema: JsonSchema | undefined): string {
  return typeof schema?.type === 'string' ? schema.type : 'unknown'
}

// ---------------------------------------------------------------------------
// Types, as the binding UI enforces them.
//
// An input declares a JSON type (a tool's Zod arg, a callee's trigger payload)
// and so does most upstream data, so the editor can refuse a mapping that the
// run would only reject later — when a `boolean` argument arrives as the string
// "false", or a number field is linked to a message array.
// ---------------------------------------------------------------------------

const JSON_TYPES = new Set([
  'string',
  'number',
  'boolean',
  'object',
  'array',
  'null',
])

/**
 * A declared type reduced to the JSON type it really is, or null when the type
 * is opaque — nothing was stated, or what was stated isn't a JSON type at all
 * ('unknown', 'passthrough', a callee's 'workflow', a Branch's `"yes" | "no"`).
 * `integer` is a `number`; an agent's `text` output is a `string`.
 */
export function normalizeJsonType(type: string | undefined): string | null {
  if (!type) return null
  if (type === 'integer') return 'number'
  if (type === 'text') return 'string'
  return JSON_TYPES.has(type) ? type : null
}

/**
 * Whether a value of `valueType` may be mapped into an input declared as
 * `inputType` — the rule behind the binding picker's filtering.
 *
 * Deliberately permissive about what it can't see: an opaque type matches
 * everything, because refusing the un-inspectable would hide most real mappings
 * (an agent's free-form output above all). The filter only bites when BOTH
 * sides state a JSON type and the two disagree.
 */
export function acceptsValueType(
  inputType: string | undefined,
  valueType: string | undefined,
): boolean {
  const want = normalizeJsonType(inputType)
  const got = normalizeJsonType(valueType)
  if (!want || !got) return true
  return want === got
}

/**
 * The literal is typed into one text box, but the input may declare a non-string
 * JSON type — so coerce the string to that type before storing it. A numeric
 * input (e.g. `keepCount`) is stored as `0` (number), not `"0"`; otherwise the
 * tool's Zod schema rejects it at run time. Unparseable input falls back to the
 * raw string, so the schema still surfaces a clear validation error — but the
 * editor prefers to block that case up front; see `literalIssue`.
 */
export function coerceLiteral(raw: string, type?: string): unknown {
  switch (normalizeJsonType(type)) {
    case 'number': {
      const n = Number(raw)
      return raw.trim() !== '' && !Number.isNaN(n) ? n : raw
    }
    case 'boolean': {
      if (raw === 'true') return true
      if (raw === 'false') return false
      return raw
    }
    case 'object':
    case 'array': {
      try {
        return JSON.parse(raw)
      } catch {
        return raw
      }
    }
    default:
      return raw
  }
}

/**
 * Why a typed literal can't be committed yet, or null when it is well-formed.
 * Drives the Set button's disabled state, so a value that the input's schema
 * would certainly reject can't be stored in the first place. Empty input is not
 * an issue here — an empty box is simply not ready, which the caller handles.
 */
export function literalIssue(raw: string, type?: string): string | null {
  if (raw.trim() === '') return null
  if (type === 'integer' && !Number.isSafeInteger(Number(raw))) {
    return 'Enter a whole number'
  }
  switch (normalizeJsonType(type)) {
    case 'number':
      return Number.isNaN(Number(raw)) ? 'Enter a number' : null
    case 'object':
    case 'array': {
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        return 'Enter valid JSON'
      }
      if (normalizeJsonType(type) === 'array') {
        return Array.isArray(parsed) ? null : 'Enter a JSON array'
      }
      return parsed !== null &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed)
        ? null
        : 'Enter a JSON object'
    }
    default:
      return null
  }
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
//
// Exhaustive on purpose: the `satisfies never` makes a new node kind a compile
// error here rather than silently reporting "no inputs", which would leave the
// inspector showing an empty binding list for a node that needs data.
export function nodeRequires(node: WorkflowNode, maps: IoMaps): NodeInput[] {
  switch (node.kind) {
    case 'agent': {
      const agent = maps.agentsById.get(node.config.agentId)
      // Untyped on purpose: a `${variable}` is interpolated into the prompt, and
      // `interpolateUserText` renders whatever it is given — a number, a boolean,
      // a whole object as JSON. Declaring 'string' here would make the binding
      // picker hide every non-string field from a mapping that works fine.
      return (agent?.inputVariables ?? []).map((v) => ({
        key: v,
        label: v,
        required: true,
        type: 'unknown',
      }))
    }
    case 'tool':
      return inputsOfSchema(maps.toolsById.get(node.config.toolId)?.inputSchema)
    case 'workflow':
      // What the CALLEE's trigger takes. Binding none of these is legal and
      // common — `buildCalleeTriggerInput` then passes this node's upstream
      // output straight through — so the callee's own `required` is reported
      // as-is and `missingRequiredInputs` decides when it actually bites.
      return inputsOfSchema(calleeInputSchema(node.config.workflowId, maps))
    // Kinds with nothing to bind. Transform and Passthrough DO carry bindings,
    // but theirs are author-declared (`inputs`/`fields`) rather than a schema
    // the node must satisfy, so they are edited in their own inspector panels
    // and never appear as required inputs.
    case 'trigger':
    case 'branch':
    case 'switch':
    case 'feature-request':
    case 'passthrough':
    case 'transform':
    case 'race':
    case 'aggregate':
    case 'iteration':
    case 'note':
    case 'output':
      return []
    default:
      node satisfies never
      return []
  }
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
        : node.kind === 'workflow'
          ? (node.config.inputs ?? {})
          : null
  if (!bindings) return []
  // A Workflow node with NOTHING bound is the passthrough form: the callee
  // receives this node's upstream output unchanged, which is a deliberate
  // authoring choice and not a missing link. Bind one field and the node
  // switches to building an object — from then on the callee's required fields
  // really are missing if unbound.
  if (node.kind === 'workflow' && Object.keys(bindings).length === 0) return []
  return nodeRequires(node, maps)
    .filter((input) => input.required && bindings[input.key] == null)
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
        ? [...keys, SWITCH_DEFAULT_CASE]
            .map((k) => JSON.stringify(k))
            .join(' | ')
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
// The field tree for a `conversation`-shaped transform result: AI-SDK
// `UIMessage[]`. Written out rather than derived because the AI SDK ships types,
// not a JSON Schema, and the read-only data tree only needs the parts an author
// would reference.
function conversationOutput(): { fields: DataField[]; items: DataField[] } {
  const items: DataField[] = [
    {
      key: 'role',
      label: 'role',
      path: 'role',
      type: 'string',
      description: '"user", "assistant" or "system".',
    },
    {
      key: 'parts',
      label: 'parts',
      path: 'parts',
      type: 'array',
      description: 'Message content — text parts carry `text`.',
    },
  ]
  return { fields: [], items }
}

// Pass-through resolution: a node that emits exactly what it received. Shared by
// feature-request (an unbuilt placeholder), an unconfigured identity Passthrough,
// and Note (which has no predecessors, so this reports nothing).
function passThroughOutput(
  node: WorkflowNode,
  maps: IoMaps,
  graph: WorkflowGraph,
  byId: Map<string, WorkflowNode>,
  seen: Set<string>,
): { fields: DataField[]; type: string } {
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

// What a node makes available to everything downstream of it.
//
// Exhaustive on purpose. This dispatch decides what the binding picker offers,
// and the old if-chain had no closing `else`: a node kind it didn't recognize
// fell through to the pass-through branch and advertised its PREDECESSOR's
// shape as its own — not an empty picker, but a confidently wrong one. The
// `satisfies never` turns that into a compile error.
function nodeOutput(
  node: WorkflowNode,
  maps: IoMaps,
  graph: WorkflowGraph,
  byId: Map<string, WorkflowNode>,
  seen: Set<string>,
): { fields: DataField[]; type: string } {
  if (seen.has(node.id)) return { fields: [], type: 'unknown' }
  seen.add(node.id)

  switch (node.kind) {
    case 'agent': {
      const output = maps.agentsById.get(node.config.agentId)?.output
      if (!output) return { fields: [], type: 'unknown' }
      return {
        fields: fieldsOf(agentOutputJsonSchema(output), ''),
        type: output.kind,
      }
    }

    case 'tool': {
      const schema = maps.toolsById.get(node.config.toolId)?.outputSchema
      // Reflect the schema's real container type (object/array/…) instead of
      // always claiming "object" — a tool that returns an array or scalar was
      // being mislabeled.
      return {
        fields: fieldsOf(schema, ''),
        type: schema ? schemaType(schema) : 'unknown',
      }
    }

    case 'trigger': {
      const schema = maps.triggersByKind.get(
        node.config.triggerKind,
      )?.inputSchema
      // The iteration `Item` trigger emits one list element; its shape is injected
      // into the maps (from the parent iteration's inferred `itemSchema`).
      if (node.config.triggerKind === ITERATION_ITEM_TRIGGER_KIND) {
        const t = typeof schema?.type === 'string' ? schema.type : 'item'
        return { fields: fieldsOf(schema, ''), type: schema ? t : 'item' }
      }
      // Only host-declared events carry a payload shape; manual/periodic don't.
      return {
        fields: fieldsOf(schema, ''),
        type: schema ? 'event' : 'trigger',
      }
    }

    case 'output':
      return { fields: [], type: 'none' }

    case 'workflow':
      // A workflow node emits the CALLEE's output, whose shape isn't known here
      // (it's the other workflow's Output value). Surface it as one opaque leaf
      // rather than guessing — and never fall through to the pass-through branch,
      // which would wrongly show this node's INPUT shape as its output.
      return { fields: [], type: 'workflow' }

    case 'iteration':
      // A collection of per-item results. The element shape isn't known at author
      // time, so surface the whole array as one bindable leaf rather than guessing.
      return { fields: [], type: 'array' }

    case 'race': {
      // A race passes the winning upstream's output through untouched. Its inputs
      // all share one shape, so downstream sees that single shape — resolve from
      // the first predecessor rather than the multi-keyed object a fan-in yields.
      const preds = predecessorIds(graph, node.id)
        .map((id) => byId.get(id))
        .filter((n): n is WorkflowNode => Boolean(n))
      return preds.length > 0
        ? nodeOutput(preds[0], maps, graph, byId, seen)
        : { fields: [], type: 'passthrough' }
    }

    case 'aggregate':
      // A wait-for-all join: collects each producer's output into an ordered list.
      // The element shapes vary by producer, so surface the whole array as one
      // bindable leaf (like iteration) rather than inventing a uniform element
      // shape — a downstream iteration can still pick it as its list.
      return { fields: [], type: 'array' }

    case 'branch':
    case 'switch':
      // Routing nodes emit their decision, not a forwarded input.
      return { fields: decisionOutputFields(node), type: 'object' }

    case 'transform':
      // A Transform emits whatever its expression returns, which nothing can know
      // statically — so the ONLY honest answer is the shape the author declared.
      // Declared, we can describe the elements and the picker works normally;
      // undeclared, report `unknown` so the whole value binds as one leaf rather
      // than advertising fields that may not exist. (Falling through to the
      // pass-through resolution would be actively wrong: it would report the
      // predecessor's shape, which is precisely the shape a transform exists to
      // discard.)
      if (node.config.outputShape === 'conversation') {
        return { ...conversationOutput(), type: 'array' }
      }
      return { fields: [], type: 'unknown' }

    case 'passthrough': {
      // A Passthrough emits an AUTHORED shape, not its predecessor's: `value`
      // forwards one binding UNWRAPPED, `fields` builds an object keyed by the
      // author's names. Resolve each binding's type from the node it points at so
      // downstream pickers can bind into it and the race shape-match check
      // (`raceInputShapeCount`) sees the shape this arm really contributes. With
      // neither set it's a pure identity — fall back to the shared pass-through
      // resolution so it reports its predecessor's shape.
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
      return passThroughOutput(node, maps, graph, byId, seen)
    }

    case 'feature-request':
    case 'note':
      return passThroughOutput(node, maps, graph, byId, seen)

    default:
      node satisfies never
      return { fields: [], type: 'unknown' }
  }
}

/**
 * The shape of the value a Transform's expression will actually receive.
 *
 * Mirrors what `executeTransformNode` does at run time — an explicit `source`
 * binding wins, and with none the node reads its incoming edge — so the outline
 * the author is shown matches the data they will get. Narrows to the bound path
 * (`messages` rather than the whole tool result) because that, not the producer's
 * full output, is what `$` refers to inside the expression.
 *
 * Returns `null` when there is nothing to describe: no binding and no single
 * predecessor to fall back on.
 */
export function transformSourceShape(
  node: WorkflowNode,
  graph: WorkflowGraph,
  maps: IoMaps,
): { label: string; fields: DataField[]; type: string } | null {
  if (node.kind !== 'transform') return null
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const binding = node.config.source

  // A literal source is its own answer — the author typed the value, so there is
  // no upstream shape to look up.
  if (binding?.kind === 'literal') {
    return {
      label: 'a literal value you typed',
      fields: [],
      type: jsonTypeOf(binding.value),
    }
  }

  const producerId = binding?.nodeId ?? singlePredecessorId(graph, node.id)
  if (!producerId) return null
  const producer = byId.get(producerId)
  if (!producer) return null

  const out = nodeOutput(producer, maps, graph, byId, new Set())
  const path = binding?.path ?? ''
  const label = `${producer.label} · ${path || 'whole output'}`
  if (!path) return { label, fields: out.fields, type: out.type }

  const field = findField(out.fields, path)
  if (!field) return { label, fields: [], type: 'unknown' }
  // For an array it is the ELEMENT shape the expression maps over, which
  // `items` holds; `children` is empty on arrays.
  return {
    label,
    fields:
      field.type === 'array' ? (field.items ?? []) : (field.children ?? []),
    type: field.type,
  }
}

/** The lone incoming node, or null when there are zero or several. */
function singlePredecessorId(
  graph: WorkflowGraph,
  nodeId: string,
): string | null {
  const preds = predecessorIds(graph, nodeId)
  return preds.length === 1 ? preds[0] : null
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
function shapeSignature(out: {
  fields: DataField[]
  type: string
}): string | null {
  const OPAQUE = new Set(['unknown', 'passthrough', 'workflow'])
  if (OPAQUE.has(out.type) && out.fields.length === 0) return null
  const norm = (fields: DataField[]): string =>
    fields
      .map(
        (f) => `${f.key}:${f.type}${f.children ? `{${norm(f.children)}}` : ''}`,
      )
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
 * Whether the agent a node points at works on a chat thread. Read from the
 * agent's LATEST PUBLISHED config (like `inputVariables`), so switching the kind
 * on a draft only reaches workflow editors once the agent is published.
 */
export function agentAcceptsConversation(
  node: WorkflowNode,
  maps: IoMaps,
): boolean {
  if (node.kind !== 'agent') return false
  return maps.agentsById.get(node.config.agentId)?.inputKind === 'conversation'
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
    if (
      grand &&
      carriesThread(nodeOutput(grand, maps, graph, byId, new Set()))
    ) {
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
export function findField(
  fields: DataField[],
  path: string,
): DataField | undefined {
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
    const keys = Object.keys(contract.properties ?? {})
    return keys.length > 0 ? `a { ${keys.join(', ')} } value` : 'an object'
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
