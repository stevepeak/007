import { z } from 'zod'

import { analyzeJoinTopology, bothArmsJoinDecision } from './graph-topology'
import {
  ITERATION_ITEM_TRIGGER_KIND,
  MANUAL_TRIGGER_KIND,
  PERIODIC_TRIGGER_KIND,
} from './trigger-registry'

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

// Canonical node-kind list — owned by the SDK (no external @app/types dep).
export const WF_NODE_KINDS = [
  'trigger',
  'agent',
  'tool',
  'branch',
  'switch',
  'workflow',
  'feature-request',
  'race',
  'aggregate',
  'iteration',
  'note',
  'output',
] as const
export type WfNodeKind = (typeof WF_NODE_KINDS)[number]

// Node kinds that route via a conditional outgoing edge (`edge.condition`
// selects the live arm). The binary `branch` (predicate) emits 'yes'/'no'; the
// multi-way `switch` emits a case key or 'default'. The scheduler and cone/join
// validation treat both uniformly for routing.
export const DECISION_NODE_KINDS = ['branch', 'switch'] as const
export function isDecisionKind(kind: string): boolean {
  return (DECISION_NODE_KINDS as readonly string[]).includes(kind)
}

// Engine-managed bookend kinds — never an executable instruction. Trigger and
// Output are seeded/terminated by the driver loop; a portless Note has no
// incoming edges, so it never becomes ready. Used to narrow WorkflowNode to the
// executable set (see `ExecutableNode` in scheduler.ts).
export const BOOKEND_NODE_KINDS = ['trigger', 'output', 'note'] as const
export type BookendNodeKind = (typeof BOOKEND_NODE_KINDS)[number]
// Node-level guard (not just the kind string) so it narrows a WorkflowNode: the
// false branch excludes the bookend members, yielding the executable set.
export function isBookendKind<T extends { kind: string }>(
  node: T,
): node is T & { kind: BookendNodeKind } {
  return (
    node.kind === 'trigger' || node.kind === 'output' || node.kind === 'note'
  )
}

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
// rules below (single trigger, reachable outputs, legal joins). The editor
// persists drafts and versions through THIS so a work-in-progress with issues
// can still be saved — integrity problems surface non-blockingly via
// `collectGraphIssues` and the "Issues" panel instead of rejecting the save.
export const workflowGraphShapeSchema = z.object({
  version: z.literal(1),
  nodes: z.array(workflowNodeSchema).min(2),
  edges: z.array(workflowEdgeSchema),
})

// The strict runtime gate is a sequence of independent structural checks. Each
// is a named function taking the parsed shape + a minimal issue sink (decoupled
// from zod's RefinementCtx), split out of what was one ~250-line closure so each
// rule reads on its own. The author-time diagnostics in graph-issues.ts mirror
// these (with softer severity) and share the join/cone analysis via
// graph-topology.ts, so the reject-vs-warn pair can't drift.
type GraphShape = z.infer<typeof workflowGraphShapeSchema>
type GraphCheckCtx = {
  addIssue(issue: { code: 'custom'; message: string }): void
}

// Exactly one trigger, at least one output, unique ids, edges pointing at real
// nodes, and every Output reachable (it has an incoming edge, else it stalls).
function checkGraphShape(g: GraphShape, ctx: GraphCheckCtx): void {
  const triggers = g.nodes.filter((n) => n.kind === 'trigger')
  if (triggers.length !== 1) {
    ctx.addIssue({
      code: 'custom',
      message: `Graph must have exactly one trigger node (found ${triggers.length}).`,
    })
  }
  const outputs = g.nodes.filter((n) => n.kind === 'output')
  if (outputs.length === 0) {
    ctx.addIssue({
      code: 'custom',
      message: 'Graph must have at least one output node.',
    })
  }
  const ids = new Set(g.nodes.map((n) => n.id))
  if (ids.size !== g.nodes.length) {
    ctx.addIssue({ code: 'custom', message: 'Node ids must be unique.' })
  }
  for (const e of g.edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) {
      ctx.addIssue({
        code: 'custom',
        message: `Edge ${e.id} references missing node (${e.source} → ${e.target}).`,
      })
    }
  }
  for (const o of outputs) {
    if (!g.edges.some((e) => e.target === o.id)) {
      ctx.addIssue({
        code: 'custom',
        message: `Output node ${o.id} has no incoming edges.`,
      })
    }
  }
}

// Ref bindings must point at real nodes. Tool `args`, Workflow `inputs`, and a
// Branch's single `source` all share the ArgBinding shape. A binary decision
// (branch) may still leave one arm unconnected — it "fizzles out" at run time —
// so a missing yes/no edge is deliberately not flagged here.
function checkRefBindings(g: GraphShape, ctx: GraphCheckCtx): void {
  const ids = new Set(g.nodes.map((n) => n.id))
  for (const n of g.nodes) {
    const bindings =
      n.kind === 'tool'
        ? n.config.args
        : n.kind === 'workflow'
          ? n.config.inputs
          : null
    if (bindings) {
      const label = n.kind === 'tool' ? 'arg' : 'input'
      for (const [argName, binding] of Object.entries(bindings)) {
        if (binding.kind === 'ref' && !ids.has(binding.nodeId)) {
          ctx.addIssue({
            code: 'custom',
            message: `${n.kind === 'tool' ? 'Tool' : 'Workflow'} node ${n.id} ${label} '${argName}' references missing node ${binding.nodeId}.`,
          })
        }
      }
    }
    if (n.kind === 'branch') {
      const src = n.config.source
      if (src && !ids.has(src.nodeId)) {
        ctx.addIssue({
          code: 'custom',
          message: `Branch node ${n.id} source references missing node ${src.nodeId}.`,
        })
      }
    }
  }
}

// Switch nodes: unique, non-reserved case keys; an outgoing edge per case; a
// single 'default' fallback edge; and no outgoing edge whose condition matches
// neither a declared case nor 'default'.
function checkSwitchNodes(g: GraphShape, ctx: GraphCheckCtx): void {
  for (const n of g.nodes) {
    if (n.kind !== 'switch') continue
    const keys = n.config.cases.map((c) => c.key)
    const keySet = new Set(keys)
    if (keySet.size !== keys.length) {
      ctx.addIssue({
        code: 'custom',
        message: `Switch node ${n.id} has duplicate case keys.`,
      })
    }
    if (keySet.has(SWITCH_DEFAULT_CASE)) {
      ctx.addIssue({
        code: 'custom',
        message: `Switch node ${n.id} uses the reserved case key '${SWITCH_DEFAULT_CASE}'.`,
      })
    }
    const outs = g.edges.filter((e) => e.source === n.id)
    const conds = new Set(outs.map((e) => e.condition))
    for (const k of keySet) {
      if (!conds.has(k)) {
        ctx.addIssue({
          code: 'custom',
          message: `Switch node ${n.id} case '${k}' has no outgoing edge.`,
        })
      }
    }
    if (!conds.has(SWITCH_DEFAULT_CASE)) {
      ctx.addIssue({
        code: 'custom',
        message: `Switch node ${n.id} must have a '${SWITCH_DEFAULT_CASE}' (fallback) outgoing edge.`,
      })
    }
    for (const e of outs) {
      if (
        e.condition == null ||
        (!keySet.has(e.condition) && e.condition !== SWITCH_DEFAULT_CASE)
      ) {
        ctx.addIssue({
          code: 'custom',
          message: `Switch node ${n.id} edge ${e.id} condition '${e.condition ?? 'null'}' matches no declared case or '${SWITCH_DEFAULT_CASE}'.`,
        })
      }
    }
  }
}

// Iteration subgraph contract: it must start with an `iteration_item` trigger
// (its output is the current element) and may not nest another iteration
// (unsupported this version). The subgraph is otherwise validated at run time by
// its own Scheduler.
function checkIterationSubgraphs(g: GraphShape, ctx: GraphCheckCtx): void {
  for (const n of g.nodes) {
    if (n.kind !== 'iteration') continue
    const sub = n.config.subgraph
    const subTrigger = sub.nodes.find((sn) => sn.kind === 'trigger')
    if (
      subTrigger &&
      subTrigger.config.triggerKind !== ITERATION_ITEM_TRIGGER_KIND
    ) {
      ctx.addIssue({
        code: 'custom',
        message: `Iteration node ${n.id} subgraph must start with an '${ITERATION_ITEM_TRIGGER_KIND}' trigger.`,
      })
    }
    if (sub.nodes.some((sn) => sn.kind === 'iteration')) {
      ctx.addIssue({
        code: 'custom',
        message: `Iteration node ${n.id} cannot contain another iteration node (nested iteration is not supported).`,
      })
    }
  }
}

// Fan-in shapes the scheduler can actually run. Its readiness rule is
// all-incoming-edges-alive (`every`) for work nodes and any-incoming-edge-alive
// (`some`) for Output nodes; a branch's outgoing edges are alive only for the
// matching outcome. Two shapes break that silently — reject them at author time
// rather than stall / drop nodes at run time. Cone/decision analysis is shared
// with the author-time diagnostics (graph-topology.ts).
function checkJoinTopology(g: GraphShape, ctx: GraphCheckCtx): void {
  const topo = analyzeJoinTopology(g)
  for (const n of g.nodes) {
    const incoming = topo.incoming.get(n.id) ?? []
    if (incoming.length < 2) continue

    // A Race is a first-to-finish join (`some` readiness): every fan-in shape is
    // legal — parallel paths and both branch arms alike.
    if (n.kind === 'race') continue

    if (n.kind === 'output') {
      // Only mutually-exclusive branch arms may converge on one Output; two or
      // more always-live (unconditional) incoming edges are parallel paths, one
      // of which would be silently dropped.
      const unconditional = incoming.filter((e) => !topo.isConditional(e.source))
      if (unconditional.length >= 2) {
        ctx.addIssue({
          code: 'custom',
          message: `Output node ${n.id} merges ${unconditional.length} parallel paths; only mutually-exclusive branch arms may converge on one Output. Give each parallel path its own Output node.`,
        })
      }
    } else {
      // A work node fires only when ALL its incoming edges are alive; it stalls
      // when a single branch feeds BOTH its arms into this node (mutually
      // exclusive, so one arm's edge stays dead forever).
      const d = bothArmsJoinDecision(
        n.id,
        topo.ancestorCone(n.id),
        topo.decisionIds,
        g.edges,
      )
      if (d) {
        ctx.addIssue({
          code: 'custom',
          message: `Node ${n.id} joins both arms of branch ${d}; those paths are mutually exclusive and can never all complete, so the join would stall. Route each arm to its own Output, or converge only paths on the same branch arm.`,
        })
      }
    }
  }
}

// Top-level schema. `version: 1` is the future-evolution lever — new schema
// shapes ship as v2 and the executor branches on this. This is the strict
// runtime gate: the Scheduler parses through it, so a graph that fails here
// can't run. Author-time saving deliberately uses `workflowGraphShapeSchema`.
export const workflowGraphSchema = workflowGraphShapeSchema.superRefine(
  (g, ctx) => {
    checkGraphShape(g, ctx)
    checkRefBindings(g, ctx)
    checkSwitchNodes(g, ctx)
    checkIterationSubgraphs(g, ctx)
    checkJoinTopology(g, ctx)
  },
)

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

// The trigger a new workflow is seeded with (chosen in the creation flow).
export type NewWorkflowTrigger =
  | { mode: 'manual' }
  | { mode: 'periodic'; cron: string }
  // `eventLabel` is the event's human description, used as the trigger node's
  // display label so the internal `event` kind is never surfaced. Falls back to
  // a generic 'On event' when the caller has no description on hand.
  | { mode: 'event'; event: string; eventLabel?: string }

/**
 * Build the minimal valid starter graph for a new workflow: the chosen trigger
 * wired straight into an Output node. The editor takes over from here.
 */
export function buildStarterGraph(trigger: NewWorkflowTrigger): WorkflowGraph {
  const triggerId = crypto.randomUUID()
  const outputId = crypto.randomUUID()

  const config =
    trigger.mode === 'manual'
      ? { triggerKind: MANUAL_TRIGGER_KIND }
      : trigger.mode === 'periodic'
        ? { triggerKind: PERIODIC_TRIGGER_KIND, cron: trigger.cron }
        : { triggerKind: trigger.event }

  const label =
    trigger.mode === 'manual'
      ? 'Manual start'
      : trigger.mode === 'periodic'
        ? 'On schedule'
        : (trigger.eventLabel ?? 'On event')

  return {
    version: 1,
    nodes: [
      {
        id: triggerId,
        kind: 'trigger',
        label,
        position: { x: 0, y: 0 },
        config,
      },
      {
        id: outputId,
        kind: 'output',
        label: 'Output',
        position: { x: 320, y: 0 },
        config: {},
      },
    ],
    edges: [
      {
        id: crypto.randomUUID(),
        source: triggerId,
        target: outputId,
        condition: null,
      },
    ],
  }
}

/**
 * Build the minimal valid subgraph an iteration node is seeded with: an
 * `iteration_item` trigger (its output is the current list element) wired
 * straight into an Output node. In the editor these two render as the `Item` and
 * `Result` bookend nodes inside the iteration container; the author drops work
 * nodes between them. Positions are relative to the container's top-left, offset
 * below its header.
 */
export function buildIterationSubgraph(): WorkflowGraph {
  const triggerId = crypto.randomUUID()
  const outputId = crypto.randomUUID()
  return {
    version: 1,
    nodes: [
      {
        id: triggerId,
        kind: 'trigger',
        label: 'Item',
        position: { x: 24, y: 72 },
        config: { triggerKind: ITERATION_ITEM_TRIGGER_KIND },
      },
      {
        id: outputId,
        kind: 'output',
        label: 'Result',
        position: { x: 300, y: 72 },
        config: {},
      },
    ],
    edges: [
      {
        id: crypto.randomUUID(),
        source: triggerId,
        target: outputId,
        condition: null,
      },
    ],
  }
}

// `${token}` interpolation contract, shared by prompt variable inference and the
// agent node's runtime substitution. A variable name is `\w+`.
export const PROMPT_VARIABLE_RE = /\$\{(\w+)\}/g

/** Distinct `${token}` variable names referenced in a prompt body, in order. */
export function inferPromptVariables(body: string): string[] {
  const seen = new Set<string>()
  for (const m of body.matchAll(PROMPT_VARIABLE_RE)) {
    seen.add(m[1])
  }
  return [...seen]
}

/**
 * Substitute `${token}` variables in a prompt body against `vars`. Unknown
 * tokens are left intact so the author sees them at runtime rather than
 * silently producing empty strings. Shares `PROMPT_VARIABLE_RE` with
 * `inferPromptVariables` so inference and substitution can never drift.
 */
export function substitutePromptVariables(
  body: string,
  vars: Record<string, string | undefined>,
): string {
  return body.replaceAll(PROMPT_VARIABLE_RE, (match, key: string) => {
    return vars[key] ?? match
  })
}

// Frozen-at-run-start resolution of every floating reference in a workflow to
// the exact published version it ran against. Stored on `wf_run.manifest` so a
// run is fully reproducible even as its leaf agents drift. Entries are
// self-describing (carry `config`) so a run needs no live agent rows to replay.
export type WfAgentManifestEntry = {
  kind: 'agent'
  /** The stable `wf_agent.id` an agent node references. */
  id: string
  /**
   * The pin this entry was resolved for: `null` for nodes that float to
   * latest, or the exact version number a node pinned. A single run can hold
   * several entries for the same `id` when different nodes pin the same agent
   * differently — the pin is part of the lookup key.
   */
  pinnedVersion: number | null
  versionId: string
  versionNumber: number
  name: string
  config: AgentConfig
}

// A called workflow resolved to the exact published version it ran against, with
// its graph frozen in so the sub-run replays even as the callee drifts. Its
// graph may itself reference agents / further workflows; run-start resolution is
// transitive, so every reachable entry lands in the same flat manifest.
export type WfWorkflowManifestEntry = {
  kind: 'workflow'
  /** The stable `wf_workflow.id` a workflow node references. */
  id: string
  versionId: string
  versionNumber: number
  name: string
  /** The frozen published graph, executed inline as a subgraph at run time. */
  graph: WorkflowGraph
}

export type WfRunManifestEntry = WfAgentManifestEntry | WfWorkflowManifestEntry

/**
 * Look up the resolved agent entry for an `agentId` + version pin in a run
 * manifest. `version` is the node's pin: `null`/undefined matches the
 * float-to-latest entry, a number matches the entry frozen for that pin.
 */
export function agentFromManifest(
  manifest: readonly WfRunManifestEntry[],
  agentId: string,
  version: number | null = null,
): WfAgentManifestEntry | undefined {
  return manifest.find(
    (e): e is WfAgentManifestEntry =>
      e.kind === 'agent' &&
      e.id === agentId &&
      // Manifests frozen before pinning existed have no `pinnedVersion`; treat
      // a missing value as `null` (float-to-latest) so old runs still resolve.
      (e.pinnedVersion ?? null) === (version ?? null),
  )
}

/** Look up the resolved workflow entry for a `workflowId` in a run manifest. */
export function workflowFromManifest(
  manifest: readonly WfRunManifestEntry[],
  workflowId: string,
): WfWorkflowManifestEntry | undefined {
  return manifest.find(
    (e): e is WfWorkflowManifestEntry =>
      e.kind === 'workflow' && e.id === workflowId,
  )
}
