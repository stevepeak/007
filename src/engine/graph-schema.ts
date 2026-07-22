import { z } from 'zod'

import { PERIODIC_TRIGGER_KIND } from './trigger-registry'

// Discriminated union for nodes. Each kind carries `id` + `position` (editor
// state) + `label` (display) and a kind-specific `config` blob. The Trigger
// and Output nodes are engine-managed bookends; Agent/Tool/Branch carry the
// real work (Branch routes via a deterministic predicate). This schema is
// provider-agnostic — `modelId` is resolved by the host-supplied model factory
// and `toolIds`/`triggerKind` by host registries.

const positionSchema = z.object({
  x: z.number(),
  y: z.number(),
})

// Provider-agnostic per-node execution policy. The engine defines the SHAPE;
// the runtime backend (e.g. Cloudflare Workflows) maps it to its own step
// config — this schema deliberately carries NO Cloudflare types. Omitted, or
// any omitted field, falls back to the backend's per-kind defaults.
export const nodeExecutionSchema = z.object({
  // Best-effort node. If it still fails after any retries, the backend records
  // the failure but continues the run with a `null` output instead of aborting
  // — downstream `ref`s to this node resolve to null. Ignored for decision
  // nodes (branch/switch): a routing decision has no safe default.
  continueOnError: z.boolean().optional(),
  // Wall-clock budget for ONE attempt, in milliseconds.
  timeoutMs: z.number().int().positive().optional(),
  // Retry policy for a failed attempt. `limit` is the number of retries AFTER
  // the first attempt (0 = no retry).
  retries: z
    .object({
      limit: z.number().int().min(0).max(10),
      delayMs: z.number().int().min(0).optional(),
      backoff: z.enum(['constant', 'linear', 'exponential']).optional(),
    })
    .optional(),
})
export type NodeExecution = z.infer<typeof nodeExecutionSchema>

const baseNode = z.object({
  id: z.string().min(1),
  // Editor-only — does not affect execution.
  position: positionSchema,
  label: z.string().min(1),
  // Optional per-node retry/timeout/best-effort policy. Provider-agnostic; the
  // runtime backend maps it to its own step config. Meaningless on the trigger/
  // output/note bookends, but harmless there (they never run as steps).
  execution: nodeExecutionSchema.optional(),
})

const triggerNodeSchema = baseNode.extend({
  kind: z.literal('trigger'),
  config: z
    .object({
      // How the workflow starts. The built-ins 'manual' and 'periodic' are
      // always valid; any other value is a host-declared *event* kind,
      // validated against the trigger registry at execution time.
      triggerKind: z.string().min(1),
      // Cron schedule — required (and only meaningful) when the trigger kind is
      // the built-in 'periodic'.
      cron: z.string().min(1).optional(),
    })
    .refine(
      (c) => c.triggerKind !== PERIODIC_TRIGGER_KIND || Boolean(c.cron),
      'A periodic trigger needs a cron schedule.',
    ),
})

// Ref binding: a tool/agent input value sourced from a prior node's output.
// `path` is a dotted JSON path inside that node's output (e.g. "documents.0.id").
// Empty string means "the whole output".
export const refBindingSchema = z.object({
  kind: z.literal('ref'),
  nodeId: z.string().min(1),
  path: z.string().default(''),
})
export type RefBinding = z.infer<typeof refBindingSchema>

const literalBindingSchema = z.object({
  kind: z.literal('literal'),
  value: z.unknown(),
})

export const argBindingSchema = z.discriminatedUnion('kind', [
  literalBindingSchema,
  refBindingSchema,
])
export type ArgBinding = z.infer<typeof argBindingSchema>

// An agent's "expected output" contract, versioned with the rest of its config.
//   • text    — the tool-calling loop's final text (`{ text }`).
//   • boolean — a YES/NO decision (`{ answer: boolean, reason: string }` via
//               generateObject).
//   • object  — a structured object matching a JSON Schema the author writes as
//               a Zod schema (`source`, compiled to `schema`).
export const agentOutputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text') }),
  z.object({ kind: z.literal('boolean') }),
  z.object({
    kind: z.literal('object'),
    // The author's raw type source — round-trips back into the editor.
    source: z.string().default(''),
    // Compiled JSON Schema fed to `generateObject`.
    schema: z.record(z.string(), z.unknown()),
  }),
])
export type AgentOutput = z.infer<typeof agentOutputSchema>

// The versioned configuration of a reusable **agent** (a `wf_agent`). Workflow
// agent nodes don't carry this — they point at an agent by id and the run
// manifest freezes the resolved config. Name/icon/color are display metadata on
// the entity, not part of the versioned behavior.
export const agentConfigSchema = z.object({
  // Model id passed to the host `getModel(modelId)` factory.
  modelId: z.string().min(1),
  // Inline system prompt (authored in the TipTap editor). `${name}` tokens are
  // interpolated at execution time from the run's `promptVariables`.
  prompt: z.string().min(1),
  // Tool registry keys. Each id must resolve in the host tool registry.
  toolIds: z.array(z.string()).default([]),
  // How many turns (rounds of tool-calling) the agent may take before it must
  // give a final answer.
  maxTurns: z.number().int().min(1).max(20).default(5),
  // When true, per-step thinking text is forwarded to the run's StreamSink (the
  // RunRoom DO) so the user can watch the agent work.
  exposeThinking: z.boolean().default(false),
  // What the agent is expected to produce.
  output: agentOutputSchema.default({ kind: 'text' }),
})
export type AgentConfig = z.infer<typeof agentConfigSchema>

// A named, pre-configured starting point for a new agent, offered in the "New
// agent" flow. Host-defined (templates reference host tools by id) but a pure
// data shape (no React), so it lives here where both the host and the UI can
// import it. `modelId` is optional — the UI fills in the host's default model.
export type AgentTemplate = {
  key: string
  name: string
  description: string
  icon?: string
  color?: string
  config: Omit<AgentConfig, 'modelId'> & { modelId?: string }
}

const agentNodeSchema = baseNode.extend({
  kind: z.literal('agent'),
  // An agent node is a pure pointer at a pre-developed `wf_agent`. The node
  // floats to the agent's latest published version, resolved into the run
  // manifest at run start. Empty while an author hasn't picked one in a draft.
  config: z.object({
    agentId: z.string().default(''),
    // Which published version this node runs against. `null` (the default)
    // floats to the agent's latest published version — the historical
    // behavior; a number pins the node to that exact version number, frozen
    // into the run manifest at run start regardless of later publishes.
    version: z.number().int().positive().nullable().default(null),
    // Maps the referenced agent's prompt `${variables}` to bindings (a literal
    // or a `ref` into an upstream node's output). Resolved at run time into the
    // node's promptVariables; a bound var overrides the run-level value.
    inputs: z.record(z.string(), argBindingSchema).default({}),
    // Vision inputs: bindings that resolve to images appended to the agent's
    // message as image parts. Each resolves to a WfBlobRef (read via the host
    // `resolveImageRef`) or an already-formed `{ url, mediaType }`. The binding
    // key is a label only. Empty for text-only agents.
    imageInputs: z.record(z.string(), argBindingSchema).default({}),
  }),
})

const toolNodeSchema = baseNode.extend({
  kind: z.literal('tool'),
  config: z.object({
    toolId: z.string().min(1),
    args: z.record(z.string(), argBindingSchema).default({}),
  }),
})

// Operators for the deterministic Branch predicate. `is_empty`/`is_not_empty`
// ignore `value`; the rest compare the resolved value against it. Numeric
// comparisons coerce both sides to numbers; equality is type-loose (compares
// by string form) so an authored `"3"` matches a numeric `3`.
export const BRANCH_OPERATORS = [
  'is_empty',
  'is_not_empty',
  'equals',
  'not_equals',
  'contains',
  'greater_than',
  'less_than',
] as const
export type BranchOperator = (typeof BRANCH_OPERATORS)[number]

const branchNodeSchema = baseNode.extend({
  kind: z.literal('branch'),
  // Deterministic yes/no routing: a predicate over an upstream value, run in
  // code with no model. `source` is a `ref` binding into an upstream node's
  // output (the same data-picker agent/tool inputs use); undefined tests the
  // whole incoming input. `operator` + `value` form the test. The `yes` edge is
  // taken when the predicate holds, `no` otherwise.
  config: z.object({
    source: refBindingSchema.optional(),
    operator: z.enum(BRANCH_OPERATORS).default('is_not_empty'),
    // Operand for equals/not_equals/contains/greater_than/less_than; ignored by
    // is_empty/is_not_empty.
    value: z.unknown().optional(),
  }),
})

// Reserved case key for a Switch node's fallback edge — taken when no case
// matches. Not usable as a user-defined case key.
export const SWITCH_DEFAULT_CASE = 'default' as const

const switchNodeSchema = baseNode.extend({
  kind: z.literal('switch'),
  // Multi-way deterministic routing: the code sibling of the binary Branch.
  // Selects the value at `path` (dotted, '' = whole input) and picks the FIRST
  // case whose `value` loosely-equals it (same type-loose compare as Branch's
  // `equals`); if none match, the reserved `default` edge is taken. Each case
  // `key` labels one outgoing edge (`edge.condition === key`), plus one edge
  // with `condition === 'default'`.
  config: z.object({
    path: z.string().default(''),
    cases: z
      .array(
        z.object({
          key: z.string().min(1),
          value: z.unknown(),
        }),
      )
      .default([]),
  }),
})

// A Workflow node calls ANOTHER workflow and awaits its result. Like an agent
// node, it is a pure pointer at a reusable entity by id: it floats to that
// workflow's latest published version, frozen into the run manifest at run start
// (`WfWorkflowManifestEntry`) so a run replays against an exact graph even as the
// callee drifts. At run time the frozen graph runs inline as a subgraph (the same
// `executeSubgraph` path iteration uses); its Output value becomes this node's
// output. Reference cycles (A→B→A) are rejected at manifest resolution, not here
// — the graph alone can't see the callee's graph.
const workflowCallNodeSchema = baseNode.extend({
  kind: z.literal('workflow'),
  config: z.object({
    // The called workflow's stable `wf_workflow.id`. Empty while an author hasn't
    // picked one in a draft.
    workflowId: z.string().default(''),
    // Optional trigger-input mapping. Empty → the node's upstream input is passed
    // straight through as the called workflow's trigger output (like an iteration
    // item). Non-empty → each key/binding (a literal or a `ref` into an upstream
    // node's output) builds one field of a trigger-input object.
    inputs: z.record(z.string(), argBindingSchema).default({}),
  }),
})

const featureRequestNodeSchema = baseNode.extend({
  kind: z.literal('feature-request'),
  config: z.object({
    // Free-text description of the capability the author wishes this node did.
    // The node is a pure pass-through placeholder — this field just captures
    // the idea so it isn't lost while the feature is unbuilt.
    description: z.string().default(''),
  }),
})

// A Race is a first-to-finish join. Where every other work node fires only once
// ALL its predecessors complete (the scheduler's `every` rule), a Race fires as
// soon as the FIRST of its upstream nodes completes (an `any`/`some` rule — the
// same readiness the Output bookend uses). Connect several parallel producers of
// the same-shaped result into one Race; whichever finishes first wins and its
// output flows through untouched. The remaining upstreams keep running — a
// durable step can't be cancelled mid-flight — but their results are ignored by
// the Race (it has already fired). It carries no config: the value it emits is
// the winning upstream's output, so downstream nodes see one value, not the
// multi-keyed object a normal multi-parent join produces. Among upstreams that
// happen to complete in the same scheduler batch, the first in graph declaration
// order wins, matching the Output node's deterministic, replay-safe tie-break.
const raceNodeSchema = baseNode.extend({
  kind: z.literal('race'),
  config: z.object({}).default({}),
})

// An Aggregate is a wait-for-all fan-in join — the collect-into-a-list sibling
// of the first-to-finish Race. It fires under the ordinary work-node rule (once
// EVERY predecessor completes), then emits an ordered array with ONE element per
// incoming producer, in edge-declaration order (the same deterministic,
// replay-safe order the scheduler uses everywhere). Where a normal multi-parent
// join hands downstream the `{ [sourceId]: output }` object (keyed, unordered to
// the author), an Aggregate hands them a plain list a sibling can iterate over —
// wire several parallel producers of similar results into one Aggregate and the
// next node loops the collected results. Producer outputs are collected whole
// (never flattened), so each element is exactly one producer's output; the shapes
// need not match. It carries no config: the value is fully determined by which
// producers feed in.
const aggregateNodeSchema = baseNode.extend({
  kind: z.literal('aggregate'),
  config: z.object({}).default({}),
})

// A Note is a pure canvas annotation — a sticky note holding Markdown. It has no
// ports and is never connected by an edge, so the scheduler (which only ever
// schedules nodes whose incoming edges are all live) never sees it: it has zero
// effect on execution. It exists solely so authors can leave notes on the graph.
const noteNodeSchema = baseNode.extend({
  kind: z.literal('note'),
  config: z.object({
    // Markdown body of the sticky note.
    text: z.string().default(''),
    // Editor-only sticky-note dimensions (px), persisted across save/reload so a
    // resized note keeps its size. The engine ignores them.
    width: z.number().optional(),
    height: z.number().optional(),
  }),
})

const outputNodeSchema = baseNode.extend({
  kind: z.literal('output'),
  // The Output node is a pure terminator. It carries no config of its own —
  // its value is the output of whichever upstream node actually executed and
  // connected into it. Multiple Outputs in one graph are legal (one per branch
  // arm); a single Output with multiple incoming edges also works (the
  // scheduler picks the live one). An empty `{}` keeps the union shape
  // consistent with the other node kinds.
  config: z.object({}).default({}),
})

// An Iteration node fans out over a list: it runs its embedded `subgraph` once
// per element of the array its `source` ref points at (a `ref` into any upstream
// node's output, resolved against the run's global outputs — nodes don't forward
// data, so the list is named at its producer). Items run in parallel up
// to `concurrency`, and `stopOnError` chooses whether one item's failure aborts
// the rest (true) or is collected while the others finish (false). The node's
// output is an ordered array of per-item results — a collection downstream nodes
// consume as one value. The subgraph is a self-contained workflow whose trigger
// is the reserved `iteration_item` kind (its output IS the current element); the
// subgraph is stored shape-only (so a work-in-progress subgraph still saves) and
// strictly validated at run time when the per-item Scheduler parses it.
// The iteration subgraph schema, declared with an EXPLICIT type. `z.lazy` defers
// the read of `workflowGraphShapeSchema` (declared below) to parse time, breaking
// the module-load cycle graph→node→iteration→graph. The explicit annotation is
// load-bearing at the type level too: it terminates the type recursion here, so
// TypeScript can resolve `workflowGraphShapeSchema` to a concrete type instead of
// collapsing the whole schema — and everything that reads it — to `any`.
const iterationSubgraphSchema: z.ZodType<WorkflowGraph> = z.lazy(
  () => workflowGraphShapeSchema,
)

const iterationNodeSchema = baseNode.extend({
  kind: z.literal('iteration'),
  config: z.object({
    // Which list to iterate: a `ref` binding into ANY upstream node's output
    // (the same data picker agent/tool/branch inputs use), resolved against the
    // run's global node-output map. Optional so "never picked" (undefined → an
    // author-time error) is distinct from a real selection. Nodes no longer
    // forward data, so the list is named at its producer directly rather than
    // read out of a merged input — e.g. an iteration behind a Branch refs the
    // upstream tool that made the list, not the (boolean-only) Branch.
    source: refBindingSchema.optional(),
    concurrency: z.number().int().min(1).max(20).default(4),
    stopOnError: z.boolean().default(false),
    // Editor-only container dimensions for the group box on the canvas — the
    // engine ignores them, but they must live on the schema (not be stripped) so
    // a resized block persists across save/reload.
    width: z.number().optional(),
    height: z.number().optional(),
    // Editor-only: JSON Schema of ONE list element, inferred when the author
    // picks the list. Lets the inner `Item` node expose the element's fields for
    // binding. The engine ignores it (the real item comes from the list at run
    // time); persisted so the inferred shape survives reload.
    itemSchema: z.record(z.string(), z.unknown()).optional(),
    subgraph: iterationSubgraphSchema,
  }),
})

export const workflowNodeSchema = z.discriminatedUnion('kind', [
  triggerNodeSchema,
  agentNodeSchema,
  toolNodeSchema,
  branchNodeSchema,
  switchNodeSchema,
  workflowCallNodeSchema,
  featureRequestNodeSchema,
  raceNodeSchema,
  aggregateNodeSchema,
  iterationNodeSchema,
  noteNodeSchema,
  outputNodeSchema,
])

// The iteration node's schema is recursive (its `subgraph` is a whole
// WorkflowGraph), so `z.infer<typeof workflowNodeSchema>` would make TypeScript
// bail the *entire* union to `unknown`. Instead we infer each non-recursive node
// individually, hand-write `IterationNode` to mirror its schema's parsed output,
// and compose the union by hand — none of which forces `z.infer` through the
// recursion. The runtime `workflowNodeSchema` above still includes iteration for
// parsing/validation.
export type TriggerNode = z.infer<typeof triggerNodeSchema>
export type AgentNode = z.infer<typeof agentNodeSchema>
export type ToolNode = z.infer<typeof toolNodeSchema>
export type BranchNode = z.infer<typeof branchNodeSchema>
export type SwitchNode = z.infer<typeof switchNodeSchema>
export type WorkflowCallNode = z.infer<typeof workflowCallNodeSchema>
export type FeatureRequestNode = z.infer<typeof featureRequestNodeSchema>
export type RaceNode = z.infer<typeof raceNodeSchema>
export type AggregateNode = z.infer<typeof aggregateNodeSchema>
export type NoteNode = z.infer<typeof noteNodeSchema>
export type OutputNode = z.infer<typeof outputNodeSchema>
export interface IterationNode {
  id: string
  position: { x: number; y: number }
  label: string
  execution?: NodeExecution
  kind: 'iteration'
  config: {
    source?: RefBinding
    concurrency: number
    stopOnError: boolean
    width?: number
    height?: number
    itemSchema?: Record<string, unknown>
    subgraph: WorkflowGraph
  }
}

export type WorkflowNode =
  | TriggerNode
  | AgentNode
  | ToolNode
  | BranchNode
  | SwitchNode
  | WorkflowCallNode
  | FeatureRequestNode
  | RaceNode
  | AggregateNode
  | IterationNode
  | NoteNode
  | OutputNode

// Edges connect node outputs to node inputs. `condition` is only meaningful
// when `source` is a decision node (branch → 'yes'|'no'; switch → a case
// key or 'default'); `null` on every non-decision edge. Kept a free string so
// switch case keys fit; validation constrains the allowed values per source
// kind.
export const workflowEdgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  condition: z.string().min(1).nullable().default(null),
})
export type WorkflowEdge = z.infer<typeof workflowEdgeSchema>

// Shape-only schema: validates that nodes/edges are structurally well-formed
// (right kinds, config shapes, id/position present) but NOT the graph-integrity
// rules in graph-validation.ts (single trigger, reachable outputs, legal joins).
// The editor persists drafts and versions through THIS so a work-in-progress
// with issues can still be saved — integrity problems surface non-blockingly via
// `collectGraphIssues` and the "Issues" panel instead of rejecting the save.
export const workflowGraphShapeSchema = z.object({
  version: z.literal(1),
  nodes: z.array(workflowNodeSchema).min(2),
  edges: z.array(workflowEdgeSchema),
})

// Written out explicitly rather than `z.infer<typeof workflowGraphSchema>`
// because the iteration node's `subgraph` field makes the schema recursive
// (graph → node → iteration → graph); an inferred alias would circularly
// reference itself through a conditional type. This hand-written shape is the
// recursion anchor the iteration node's `z.ZodType<WorkflowGraph>` cast pins to.
export interface WorkflowGraph {
  version: 1
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
}
