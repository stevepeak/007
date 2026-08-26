import { z } from 'zod'

import { TRANSFORM_OUTPUT_SHAPES } from './graph-kinds'
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
  // Demote this node out of the answer-critical set, so the walk starts it
  // AFTER the nodes the Output depends on. It still runs, and still runs
  // concurrently — this only yields dispatch order. The engine already derives
  // "can this node influence the answer?" from the graph (see
  // `answerCriticalIds`), so this is the escape hatch for a side-effect node
  // that happens to sit inside the Output's ancestor cone.
  background: z.boolean().optional(),
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

// Which execution backend runs this workflow. A property of the WHOLE run (it
// picks the host process), so it lives on the trigger node beside `cron` rather
// than per-node — and being in the graph means it is versioned, exported, and
// comparable across evals for free.
//
//   • 'durable' — Cloudflare Workflows. Every node is wrapped in durable
//     `enter:`/`run:`/`record:` steps: the run survives eviction, retries replay
//     the step body, and a failed run can be resumed from its last good node.
//     Pay for it in journaling writes, a multi-step cold start before the first
//     node, and an opaque step boundary that a token stream cannot cross.
//
//   • 'inline' — the in-process engine hosted by the run's RunRoom Durable
//     Object. One `await` per node, no journal. Much lower latency and write
//     amplification, and the sink can stream, but there is no step-level retry
//     and **no resume**: a run that dies mid-walk is failed, not resumable.
//
// Long multi-stage batch work (document ingestion) wants 'durable'. Interactive
// work someone is waiting on (chat) wants 'inline'.
export const WF_ENGINES = ['durable', 'inline'] as const
export const wfEngineSchema = z.enum(WF_ENGINES)
export type WfEngine = z.infer<typeof wfEngineSchema>

// How ONE iteration item executes — the per-node peer of the trigger's `engine`,
// and the same vocabulary on purpose: an author who understands the run-level
// choice already understands this one.
//
//   • 'inline'  — the item's whole subgraph runs as a SINGLE unit: one `step.do`
//     on the durable engine, a plain await on the inline engine. Cheapest per
//     item, but the item is atomic — a failure at inner node 5 replays nodes 1-4
//     (side effects included), and the inner nodes' own `execution` policy
//     (timeout / retries / continueOnError) is never applied, because only the
//     orchestrator issues durable steps.
//   • 'durable' — each item runs as its OWN child workflow instance, so every
//     inner node gets a real durable step, its declared retry policy, and its
//     declared timeout. Costs one instance start per item.
//
// The trade is fan-out width against subgraph depth: 200 items over a one-node
// subgraph wants 'inline' (the per-item start would dominate); 10 items over an
// agent plus five nodes wants 'durable'. `collectGraphIssues` flags a graph whose
// shape disagrees with its choice, so the author is told rather than left to
// discover it when something fails halfway through.
export const ITERATION_ITEM_EXECUTIONS = ['inline', 'durable'] as const
export const iterationItemExecutionSchema = z.enum(ITERATION_ITEM_EXECUTIONS)
export type IterationItemExecution = z.infer<
  typeof iterationItemExecutionSchema
>

// How wide an iteration is ALLOWED to fan out — the bound the author declares
// (`config.maxItems`) and the ceilings that bound the declaration itself.
//
// An iteration runs its subgraph once per element of whatever its `source` ref
// resolves to, and that list is data: a bad extraction, a paginated source, or a
// model that returns three hundred entries turns one node into three hundred
// executions. Inline items each cost a `step.do` (subrequest + CPU budget);
// durable items each cost a whole workflow instance. Neither is a number an
// author should discover from a bill or a stuck run.
//
//   • `ITERATION_MAX_ITEMS_CEILING` — the most an author may declare, per item
//     execution mode. Inline is far lower because the whole fan-out shares ONE
//     instance's subrequest budget. Enforced at AUTHORING time only
//     (`collectGraphIssues`): a graph is never rejected for it, and the number
//     the fence actually enforces is the author's own.
//   • `ITERATION_MAX_ITEMS_DEFAULT` — what a fresh iteration node is seeded with
//     and what {@link backfillIterationLimits} writes into a legacy node at
//     publish, so "bounded" is the default state rather than an opt-in.
//   • `ITERATION_MAX_ITEMS_FALLBACK` — the bound applied at RUN time to a node
//     that has none. Only already-published versions can be in that state (the
//     publish backfill catches everything else), so it is deliberately permissive:
//     it exists to stop a runaway, not to retroactively fail a workflow that has
//     been looping over 300 rows every night for months.
export const ITERATION_MAX_ITEMS_CEILING: Record<
  IterationItemExecution,
  number
> = {
  inline: 100,
  durable: 1000,
}
export const ITERATION_MAX_ITEMS_DEFAULT: Record<
  IterationItemExecution,
  number
> = {
  inline: 100,
  durable: 500,
}
export const ITERATION_MAX_ITEMS_FALLBACK = 1000

// The same choice for a workflow-call node's callee. A separate alias rather
// than a shared one so each node kind's values can diverge later without a
// rename, and so the schema reads in the node's own vocabulary.
export const CALLEE_EXECUTIONS = ['inline', 'durable'] as const
export const calleeExecutionSchema = z.enum(CALLEE_EXECUTIONS)
export type CalleeExecution = z.infer<typeof calleeExecutionSchema>

// What the USER sees while a step runs — a single, mutually-exclusive choice, so
// the modes can't be held at once and there are no cross-field invariants to
// enforce by hand:
//   - off     — the step reports nothing.
//   - static  — a fixed author line (supports `${var}` tokens from run vars),
//               shown at step start.
//   - dynamic — AGENT ONLY: stream the agent's live activity. `reasoning` streams
//               the model's thinking; `tools` announces each tool it calls. Both
//               are display-only (they never change what the agent may call).
// The editor only offers `dynamic` for agents; other kinds get off / static.
export const informUserSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('off') }),
  z.object({ mode: z.literal('static'), note: z.string().default('') }),
  z.object({
    mode: z.literal('dynamic'),
    reasoning: z.boolean().default(false),
    tools: z.boolean().default(true),
  }),
])
export type InformUser = z.infer<typeof informUserSchema>

const baseNode = z.object({
  id: z.string().min(1),
  // Editor-only — does not affect execution.
  position: positionSchema,
  label: z.string().min(1),
  // What the user sees while this step runs — off / static / dynamic (see
  // `informUserSchema`). Every node kind inherits it, though bookends
  // (trigger/output/note) never run, and only agents offer `dynamic`.
  informUser: informUserSchema.default({ mode: 'off' }),
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
      // Which backend executes this workflow — see `wfEngineSchema`. Optional
      // rather than defaulted: absent means 'durable' (see `DEFAULT_WF_ENGINE`),
      // so graphs authored before the choice existed keep their behaviour and
      // don't churn their stored JSON — the field appears only once an author
      // actually picks one.
      engine: wfEngineSchema.optional(),
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

// Agent domain config — the versioned behavior of a reusable agent
// (agentOutputSchema, subAgentTargetSchema, subAgentsConfigSchema,
// agentConfigSchema and their types). It's a distinct concern from this node/edge
// graph model (an agent *node* just points at an agent by id), so it lives in its
// own module and is re-exported here for existing `./graph` / `./graph-schema`
// importers.
export * from './agent-config-schema'

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
    // Maps the referenced agent's `${variables}` — across BOTH its system prompt
    // and its user message — to bindings (a literal, or a `ref` into an upstream
    // node's output). Resolved at run time into the node's promptVariables; a
    // bound var overrides the run-level value. A `ref` with an empty path binds
    // the WHOLE upstream output, which `resolveNodeInputs` JSON-stringifies —
    // that is how an author deliberately passes a full result through.
    //
    // These bindings are the only route from the graph into the model. There is
    // no implicit channel: an unbound `${var}` reaches the prompt as the literal
    // token, which the workflow editor raises as a blocking issue.
    inputs: z.record(z.string(), argBindingSchema).default({}),
    // The conversation fed to a `conversation`-kind agent as its message history
    // — a binding (typically a `ref` into the chat trigger's `messages`) that
    // resolves to a UIMessage[]. It is the ONLY source of message history, and
    // for such an agent it is REQUIRED: the engine throws when it is missing
    // rather than answering with no context (see `buildAgentMessages`). Unused
    // by `task` agents, which run on their rendered user message alone.
    conversation: argBindingSchema.optional(),
    // Whether/what this placement streams to the user (dynamic mode) lives on the
    // node's `informUser` field (see `informUserSchema`), NOT in this config, so
    // the same agent can stream in one workflow and stay quiet in another.
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

// The operators that test the value alone. They ignore `config.value`, so the
// editor hides its input and the executor leaves it out of the trace — one list
// here rather than an `op === 'is_empty' || op === 'is_not_empty'` repeated at
// every site that has to know.
export const VALUELESS_BRANCH_OPERATORS: readonly BranchOperator[] = [
  'is_empty',
  'is_not_empty',
]

export function branchOperatorTakesValue(operator: BranchOperator): boolean {
  return !VALUELESS_BRANCH_OPERATORS.includes(operator)
}

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
// matches. Not usable as a user-defined case key. It reads as 'else' because
// that is the word the author sees on the inspector row and on the canvas edge,
// and a routing key the engine matches on should not be spelled one way in code
// and another on screen.
export const SWITCH_DEFAULT_CASE = 'else' as const

/**
 * The next case key for a Switch: 'A', 'B', … 'Z', 'AA', 'AB', … skipping any
 * key already in use. Case keys are edge labels, so they must be stable — a
 * removed case must NOT re-letter the ones after it, or every downstream edge
 * would silently re-point. Minting the next UNUSED letter (rather than indexing
 * by position) is what keeps that true, and it means the author never has to
 * invent a key at all.
 */
export function nextSwitchCaseKey(existing: readonly string[]): string {
  const taken = new Set<string>([...existing, SWITCH_DEFAULT_CASE])
  for (let i = 0; ; i++) {
    const key = spreadsheetLetters(i)
    if (!taken.has(key)) {
      return key
    }
  }
}

/**
 * What an arm is CALLED on screen: the author's name for it when they gave one,
 * otherwise the minted letter. Routing still runs on the key — this is only how
 * the outgoing edge reads, so a graph stays legible ('image') instead of
 * alphabetised ('A'). The `else` fallback has no case row to name, so it always
 * reads as itself.
 */
export function switchArmName(
  cases: readonly { key: string; label?: string }[],
  key: string | null | undefined,
): string {
  if (key == null) return ''
  const named = cases.find((c) => c.key === key)?.label?.trim()
  return named || key
}

// 0 → 'A', 25 → 'Z', 26 → 'AA' — the spreadsheet-column alphabet, bijective
// base-26 so there is no zero-width gap between 'Z' and 'AA'.
function spreadsheetLetters(index: number): string {
  let n = index + 1
  let out = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    out = String.fromCharCode(65 + rem) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

const switchNodeSchema = baseNode.extend({
  kind: z.literal('switch'),
  // Multi-way deterministic routing: the code sibling of the binary Branch.
  // `source` is a `ref` binding into an upstream node's output (the same data
  // picker Branch/Output use); undefined tests the whole incoming input. The
  // selected value is compared against each case in order and the FIRST whose
  // `value` loosely-equals it wins (same type-loose compare as Branch's
  // `equals`); if none match, the reserved `default` edge is taken.
  //
  // A case's `value` is a full binding, so a case is either a literal the
  // author typed or another upstream value the input must equal. Its `key` is
  // the routing identity (`edge.condition === key`) — the editor mints stable
  // letters (A, B, C…) so the author never invents one — plus one edge with
  // `condition === 'else'`.
  //
  // `label` is the author's own name for that arm ('image', 'refund'…), shown
  // on the outgoing edge in place of the letter. It is PURELY cosmetic:
  // renaming an arm must never re-point an edge, which is exactly why the key
  // and the name are two fields rather than one editable key.
  config: z.object({
    source: refBindingSchema.optional(),
    cases: z
      .array(
        z.object({
          key: z.string().min(1),
          label: z.string().optional(),
          value: argBindingSchema,
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
    // How the callee executes — the workflow-node peer of an iteration's
    // `itemExecution`, and the same trade in a different shape:
    //
    //   • 'inline'  — the callee's whole graph runs inside THIS node's single
    //     durable step. Cheapest, but the callee is atomic: a failure in its
    //     fifth node replays its first four (side effects included), and its
    //     nodes' own `execution` policy never applies.
    //   • 'durable' — the callee runs as its own child workflow instance with
    //     its own `wf_run`, so every one of its nodes gets a real durable step,
    //     its declared retries, and its declared timeout. Costs one instance
    //     start, and the parent parks on `waitForEvent` while it runs (a waiting
    //     instance is free — it doesn't count against the concurrency cap).
    //
    // A small callee stays 'inline'; a real pipeline wants 'durable'.
    calleeExecution: calleeExecutionSchema.default('inline'),
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

// A Passthrough is an identity/reshape node: it produces a value in a shape the
// author controls, without an LLM or a tool. Its whole reason to exist is
// converging branch arms — a Branch does NOT forward its input (it emits
// `{ result, reasoning }`), and a Race blindly forwards whichever arm won, so an
// arm that merely "already has the data" needs a node that re-surfaces that data
// in the SAME shape the sibling arm produces. Drop a Passthrough on that arm,
// point it at the upstream value, and both arms feed the Race an identical shape.
//
// Three deterministic modes, checked in this order:
//   • `value` set    → output is that single binding resolved, UNWRAPPED (use
//                      when the sibling arm emits a bare value — string, array).
//   • `fields` set   → output is an object, one key per binding resolved (use to
//                      match a `{ name }` / `{ kind }` shape: `fields.name` = a
//                      ref into the upstream that holds the name).
//   • neither        → output is the incoming input, untouched (pure identity,
//                      like feature-request).
// `value` and `fields` are mutually exclusive — setting both is an authoring
// error, not a silent precedence pick.
const passthroughNodeSchema = baseNode.extend({
  kind: z.literal('passthrough'),
  config: z
    .object({
      // Single-value mode. A `ref` into an upstream node's output (the same data
      // picker agent/tool/branch inputs use) or a `literal`; resolved and emitted
      // as-is, with no object wrapper.
      value: argBindingSchema.optional(),
      // Object-build mode. Each key becomes one field of the emitted object, its
      // value the resolved binding — so `{ name: <ref producer.name> }` yields
      // `{ name: "…" }`, letting this arm match a sibling agent's `{ name }`.
      fields: z.record(z.string(), argBindingSchema).optional(),
    })
    .default({})
    .refine(
      (c) => !(c.value && c.fields && Object.keys(c.fields).length > 0),
      'A passthrough node sets either `value` or `fields`, not both.',
    ),
})

// A Transform is a deterministic reshape step: it runs a JSONata expression over
// an upstream value and emits the result. It exists because the binding language
// can only ADDRESS data, never rework it — `resolvePath` walks dotted keys and
// positional indices, so "map every row to a different shape" has no expression
// anywhere in the graph. That gap bites hardest at a node boundary where two
// contracts disagree: a tool that returns database records feeding an agent that
// wants AI-SDK messages.
//
// JSONata rather than JavaScript, and not by preference: nodes execute inside
// workerd, which forbids code generation from strings, so `eval`/`new Function`
// throw `EvalError` at runtime. JSONata is a tree-walking interpreter over data
// with no host-language escape hatch, which makes it both the option that RUNS
// and the option that is safe to hand an author.
const transformNodeSchema = baseNode.extend({
  kind: z.literal('transform'),
  config: z
    .object({
      // The value the expression runs over, addressed as `$`. A `ref` into any
      // upstream node's output (the same picker every other input uses). Unset
      // → the incoming edge's value, matching passthrough's identity fallback,
      // so a one-parent reshape needs no binding at all.
      source: argBindingSchema.optional(),
      // Additional upstream values, exposed to the expression as `$name`. Lets
      // one transform combine several producers without a join node.
      inputs: z.record(z.string(), argBindingSchema).default({}),
      // The JSONata expression. Compiled (and so syntax-checked) at author time
      // by the editor, and again here on every run.
      expression: z.string().default(''),
      // Optional shape assertion on the RESULT. See `TRANSFORM_OUTPUT_SHAPES`
      // in nodes/transform.ts for why this is worth declaring.
      outputShape: z.enum(TRANSFORM_OUTPUT_SHAPES).optional(),
    })
    .default({ inputs: {}, expression: '' }),
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
  // The Output node terminates a run and names the value the caller receives.
  // `source` is an explicit `ref` into ANY upstream node's output (the same data
  // picker agent/tool/branch inputs use), resolved against the run's global
  // node-output map — NOT read off the incoming edge. This makes "what the user
  // sees" explicit and typed rather than "whatever node happened to be wired in".
  // Optional so a never-picked Output (undefined → an author-time error) is
  // distinct from a real selection; `.default({})` keeps historical `{}` configs
  // parsing. The incoming edge is retained purely for readiness/routing: it gates
  // WHEN the Output fires (so one Output per branch arm still works; the scheduler
  // picks the live arm), while `source` names the VALUE. Multiple Outputs in one
  // graph remain legal.
  config: z.object({ source: refBindingSchema.optional() }).default({}),
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
    // How many items may be in flight at once. The knob keeps its meaning under
    // BOTH item executions, but what it bounds differs:
    //
    //   • inline  — a real resource bound. Every item shares the parent
    //     instance's subrequest and CPU budget, so this is what stops one list
    //     from exhausting it.
    //   • durable — each item is its own instance with its own budget and the
    //     parent merely parks, so this bounds nothing local. It throttles what
    //     the ITEMS hit: model provider rate limits, D1, whatever the subgraph
    //     calls. An author who set 4 meant "don't hammer things", and that is
    //     still the useful reading — so durable windows rather than spawning
    //     all N at once (NEW-174).
    //
    // Either way it is `runIteration`'s worker pool that enforces it; the
    // durable backend supplies a `runItem` that spawns a child and parks on its
    // report, and inherits the pool rather than reimplementing the semantics.
    concurrency: z.number().int().min(1).max(20).default(4),
    // What a failed item does to the rest. When on, the failure DRAINS the loop:
    // no further items start, items already running are awaited, and only then
    // does the node fail. Under durable items a child instance could instead be
    // terminated outright — deliberately not done. A child killed mid-write
    // leaves a half-written recipe and nothing can un-write it, and draining
    // matches how the top-level walk already handles a failed node
    // (`stopDispatch` + `drainInflight`). See iteration-durable-semantics.test.ts.
    stopOnError: z.boolean().default(false),
    // Whether each item is atomic or gets per-node durability — see
    // `iterationItemExecutionSchema`. Defaulted (not optional) because unlike the
    // trigger's `engine` there is no legacy shape to preserve: every existing
    // graph already behaves as 'inline', so writing the default into stored JSON
    // records what those graphs were always doing.
    itemExecution: iterationItemExecutionSchema.default('inline'),
    // The most items this loop may fan out over. Optional — and, unlike
    // `itemExecution`, NOT defaulted — because "never set" has to stay
    // distinguishable from a deliberate number: it is what the Issues panel
    // flags at authoring time and what the run-time fence answers with the
    // permissive `ITERATION_MAX_ITEMS_FALLBACK` instead of the author's bound.
    // Defaulting it here would write a bound into every legacy graph the moment
    // it was read, erasing both. Not capped by the schema either: an over-ceiling
    // value must still SAVE (the editor's whole contract) and is surfaced as an
    // authoring error rather than a parse failure.
    maxItems: z.number().int().min(1).optional(),
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
  passthroughNodeSchema,
  transformNodeSchema,
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
export type PassthroughNode = z.infer<typeof passthroughNodeSchema>
export type TransformNode = z.infer<typeof transformNodeSchema>
export type RaceNode = z.infer<typeof raceNodeSchema>
export type AggregateNode = z.infer<typeof aggregateNodeSchema>
export type NoteNode = z.infer<typeof noteNodeSchema>
export type OutputNode = z.infer<typeof outputNodeSchema>
export interface IterationNode {
  id: string
  position: { x: number; y: number }
  label: string
  informUser: InformUser
  execution?: NodeExecution
  kind: 'iteration'
  config: {
    source?: RefBinding
    concurrency: number
    stopOnError: boolean
    itemExecution: IterationItemExecution
    maxItems?: number
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
  | PassthroughNode
  | TransformNode
  | RaceNode
  | AggregateNode
  | IterationNode
  | NoteNode
  | OutputNode

// Edges connect node outputs to node inputs. `condition` is only meaningful
// when `source` is a decision node (branch → 'yes'|'no'; switch → a case
// key or 'else'); `null` on every non-decision edge. Kept a free string so
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
// Back-compat: map a stored node's LEGACY inform-user fields (`progressNote` +
// the agent node's `exposeThinking`/`enableReasoning`/`enableTools`) onto the new
// single `informUser` field before the schema parse strips them. A node that
// already carries `informUser` is left untouched; a fresh graph never hits any
// branch but the last. Runs per node (nested iteration subgraphs recurse through
// this same schema), so one mapper covers the whole tree.
// Those legacy names no longer exist in any current schema — don't go looking for
// them in `agentConfigSchema`. This reads RAW stored JSON before the parse, which
// is exactly why it still works after they were deleted from the schema.
function migrateInformUser(raw: unknown): unknown {
  if (raw == null || typeof raw !== 'object') return raw
  const node = raw as Record<string, unknown>
  if (node.informUser != null) return node
  const config = (node.config ?? {}) as Record<string, unknown>
  let informUser: InformUser
  if (node.kind === 'agent' && config.exposeThinking === true) {
    informUser = {
      mode: 'dynamic',
      reasoning: config.enableReasoning === true,
      tools: config.enableTools !== false, // legacy default was on
    }
  } else if (typeof node.progressNote === 'string') {
    informUser = { mode: 'static', note: node.progressNote }
  } else {
    informUser = { mode: 'off' }
  }
  return { ...node, informUser }
}

export const workflowGraphShapeSchema = z.object({
  version: z.literal(1),
  nodes: z.array(z.preprocess(migrateInformUser, workflowNodeSchema)).min(2),
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
