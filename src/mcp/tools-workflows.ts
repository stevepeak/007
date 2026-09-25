import { z } from 'zod'

import {
  argBindingSchema,
  informUserSchema,
  nodeExecutionSchema,
  workflowGraphShapeSchema,
  type ArgBinding,
  type WorkflowEdge,
  type WorkflowGraph,
  type WorkflowNode,
} from '../engine/graph'
import { buildStarterGraph, type NewWorkflowTrigger } from '../engine/graph-builders'
import type { GraphIssue } from '../engine/graph-issues'
// Imported from the module rather than the `./graph` barrel on purpose: the seed
// table sits ABOVE graph-schema (it needs `buildIterationSubgraph`), which is why
// it is not re-exported there — see its own header.
import { NODE_KIND_SEEDS } from '../engine/node-kind-seeds'
import {
  MANUAL_TRIGGER_KIND,
  PERIODIC_TRIGGER_KIND,
  type TriggerEventOption,
} from '../engine/trigger-registry'
import type {
  RetryRunMode,
  WfDataClient,
  WfGraphValidation,
  WfWorkflowDetail,
} from '../server/protocol'

import { optString, reqString, type WfMcpTool } from './tools'

// The workflow write path. Same neighborhood as `tools-agents.ts`, one line
// drawn differently: **workflows can be published from here, agents cannot.**
//
// An agent version floats into every workflow that references it, so a publish
// there changes what every one of those workflows does at once. A workflow
// version changes one thing — what its own trigger runs next — and the ways
// that went wrong in practice (ART-146) were not "a model published something a
// person would not have" but two gaps a person fell through as well:
//
//   1. A published graph whose Tool-node args no longer matched the tool's
//      schema. Nothing checked, so it ran and failed on the first customer.
//      → `publish_workflow` refuses while `validate_workflow_graph` reports an
//        error, and every draft write returns the same lint.
//   2. A second author publishing from a stale draft and silently undoing the
//      first author's fix. One draft row per workflow; last write wins.
//      → `publish_workflow` requires `baseVersionNumber`, the version the
//        caller READ, and refuses if a newer one exists.
//
// Drafts are patched with named ops rather than re-sent whole. A real graph is
// twenty-plus nodes with positions; a model that re-sends it will drop a field
// somewhere, and `update_agent_draft`'s "send the WHOLE config back" warning is
// already load-bearing for an object a tenth the size. `update_workflow_draft`
// still exists for the structural rewrite an op list can't express — and for the
// one case where replacing the whole graph is the SAFE option, `fromVersion`,
// where the replacement is read server-side off an immutable version.
//
// ── Deliberately NOT here (workflows & runs) ──────────────────────────────────
//
//   • `publish_workflow` takes no `graph`. `saveVersion` accepts one, so a
//     write-and-publish in a single call is possible — and it would remove the
//     step where the draft can be read back and linted before it goes live.
//     Draft-then-publish is two calls on purpose, and the `baseVersionNumber`
//     gate only means something because the caller had to READ a version to
//     know it. (The `aiSummary` half of that gap is closed: `summarize` is on
//     by default, so an MCP-published version is never left unlabelled.)
//
//   • `delete_all_runs`. An irreversible purge of every run, step, log and eval
//     result in the workspace. The console gates it behind a modifier-hold AND a
//     press-and-hold precisely because there is no undo; a tool call has no
//     equivalent of either. Nothing an agent is asked to do needs it.
//
//   • `get_run_status`. A poller's optimisation — two fields off one indexed row.
//     `get_run` answers the same question with the trace attached, and a second
//     tool whose only advantage is being cheaper for a loop nothing here runs
//     would cost every session a description to say "like get_run but less".
//
//   • `list_run_trigger_kinds`. A filter-dropdown feed. `list_trigger_events`
//     now names every kind a workflow can be STARTED by, which is the authoring
//     question; "which kinds appear in run history" is a narrower one that
//     `list_runs` answers by returning the kind on every row.
//
//   • Undo/redo, canvas layout and Simulate. Client-side only — no protocol
//     method exists, so there is nothing to mirror. A node's `position` is
//     writable through the ops, but it is editor-only and never affects
//     execution; `add_node` places one sensibly and the editor's auto-layout
//     tidies it properly.

/** Issues beyond this are counted, not listed — a broken graph has hundreds. */
const MAX_ISSUES = 40

/**
 * The kinds an author can actually add, derived from the seed table.
 *
 * `NODE_KIND_SEEDS` maps every kind to how it starts life, and a `null` entry
 * means "the template owns this one" — trigger and output are bookends seeded
 * with the graph itself. Deriving the list rather than restating it is the same
 * rule `EVAL_CHECK_TYPES` exists for: a new node kind is a compile error in the
 * seed table, so it cannot be added to the engine and forgotten here.
 */
const ADDABLE_KINDS = (
  Object.keys(NODE_KIND_SEEDS) as (keyof typeof NODE_KIND_SEEDS)[]
).filter((k) => NODE_KIND_SEEDS[k] != null)

/**
 * Where a fresh node lands on the canvas.
 *
 * Position is editor-only and never affects execution, but a node stacked exactly
 * on another is invisible to whoever opens the graph next — so new nodes are
 * placed below everything already there. The editor's auto-layout tidies it
 * properly; this only has to avoid hiding the thing it just added.
 */
function freshPosition(graph: WorkflowGraph): { x: number; y: number } {
  const lowest = graph.nodes.reduce((y, n) => Math.max(y, n.position.y), 0)
  return { x: 0, y: lowest + 140 }
}

// ---------------------------------------------------------------------------
// Patch ops
// ---------------------------------------------------------------------------

const OPS = [
  'add_node',
  'set_tool_arg',
  'remove_tool_arg',
  'set_node_label',
  'merge_node_config',
  'set_inform_user',
  'set_node_execution',
  'add_edge',
  'remove_edge',
  'remove_node',
] as const
type OpName = (typeof OPS)[number]

/**
 * One flat op shape with every field optional, validated per-op at run time.
 * A discriminated union would be the natural type, but it emits `anyOf`/`oneOf`
 * in JSON Schema, and strict-mode MCP clients silently drop those — see the
 * conventions note at the top of `tools.ts`.
 */
const opSchema = z.object({
  op: z.enum(OPS).describe('Which change to make. See the tool description.'),
  nodeId: z
    .string()
    .nullish()
    .describe(
      'Target node id (set_tool_arg, remove_tool_arg, set_node_label, merge_node_config, remove_node).',
    ),
  arg: z
    .string()
    .nullish()
    .describe('Tool argument name (set_tool_arg, remove_tool_arg).'),
  binding: z
    .record(z.string(), z.unknown())
    .nullish()
    .describe(
      'set_tool_arg: the new binding — { kind: "literal", value } with value in the type the tool declares (a real boolean/number, not text), or { kind: "ref", nodeId, path } to read an upstream node’s output (path "" = whole output, dotted for a field).',
    ),
  label: z.string().nullish().describe('set_node_label: the new label.'),
  config: z
    .record(z.string(), z.unknown())
    .nullish()
    .describe(
      'merge_node_config: keys merged shallowly into the node’s config (top-level keys replaced, others kept). The result must still be a valid config for the node’s kind.',
    ),
  edgeId: z.string().nullish().describe('remove_edge: the edge id.'),
  source: z.string().nullish().describe('add_edge / remove_edge: source node id.'),
  target: z.string().nullish().describe('add_edge / remove_edge: target node id.'),
  condition: z
    .string()
    .nullish()
    .describe(
      'add_edge: the arm this edge follows — a branch’s "yes"/"no" or a switch case key. Omit for an unconditional edge.',
    ),
  kind: z
    .string()
    .nullish()
    .describe(
      `add_node: the node kind to add — one of ${ADDABLE_KINDS.join(', ')}. It starts life with its kind's default config (usually incomplete on purpose, so the graph lints as "not configured yet" rather than looking finished).`,
    ),
  informUser: z
    .record(z.string(), z.unknown())
    .nullish()
    .describe(
      'set_inform_user: what the CUSTOMER sees while this step runs. { "mode": "off" } | { "mode": "static", "note": "…" } | { "mode": "dynamic", "reasoning": bool, "tools": bool } (dynamic is agent nodes only). This is display, never behaviour.',
    ),
  execution: z
    .record(z.string(), z.unknown())
    .nullish()
    .describe(
      'set_node_execution: retry/timeout policy — { continueOnError?, timeoutMs?, background?, retries?: { limit, delayMs?, backoff? } }. Pass {} to clear it back to the engine default.',
    ),
  subgraphOf: z
    .string()
    .nullish()
    .describe(
      'add_node: the id of an `iteration` node, to add this node INSIDE its per-item subgraph rather than at the top level.',
    ),
})
type PatchOp = z.infer<typeof opSchema>

type Applied = { op: OpName; nodeId?: string; summary: string }

/** Find a node at the top level or inside any iteration subgraph. */
function findNode(graph: WorkflowGraph, id: string): WorkflowNode | undefined {
  return findOwner(graph, id)?.node
}

/**
 * The node AND the graph that holds it — which is the part the edge ops need.
 *
 * `findNode` could already reach into an iteration subgraph, so an inner node
 * could be configured and relabelled; but `add_edge` / `remove_edge` /
 * `remove_node` each looked only at `graph.nodes` / `graph.edges`, so the same
 * node could not be deleted or rewired. Half-reachable is the worst of the three
 * options: it reads as supported and fails on the second call.
 *
 * Edges live on the graph that owns both endpoints, so returning the owner is
 * what lets one implementation serve the top level and every subgraph.
 */
function findOwner(
  graph: WorkflowGraph,
  id: string,
): { graph: WorkflowGraph; node: WorkflowNode } | undefined {
  for (const n of graph.nodes) {
    if (n.id === id) return { graph, node: n }
    if (n.kind === 'iteration') {
      const inner = findOwner(n.config.subgraph, id)
      if (inner) return inner
    }
  }
  return undefined
}

/** Every graph in the tree — the top level plus each iteration subgraph. */
function allGraphs(graph: WorkflowGraph): WorkflowGraph[] {
  const out = [graph]
  for (const n of graph.nodes) {
    if (n.kind === 'iteration') out.push(...allGraphs(n.config.subgraph))
  }
  return out
}

function need(op: PatchOp, key: 'nodeId' | 'arg' | 'label' | 'source' | 'target'): string {
  const v = op[key]
  if (typeof v !== 'string' || !v) {
    throw new Error(`${op.op} needs \`${key}\`.`)
  }
  return v
}

/** Apply one op to a graph IN PLACE (the caller works on a clone). */
export function applyPatchOp(graph: WorkflowGraph, op: PatchOp): Applied {
  switch (op.op) {
    case 'add_node': {
      const kind = optString(op.kind)
      const seed = kind
        ? NODE_KIND_SEEDS[kind as keyof typeof NODE_KIND_SEEDS]
        : undefined
      if (!kind || seed == null) {
        throw new Error(
          `${op.op}: \`kind\` must be one of ${ADDABLE_KINDS.join(', ')}${
            kind === 'trigger' || kind === 'output'
              ? ` — a ${kind} node is a bookend seeded with the graph and cannot be added`
              : ''
          }.`,
        )
      }
      // Which graph it lands in: the top level, or one iteration's per-item
      // subgraph. Named by the ITERATION node rather than by the subgraph,
      // because the subgraph has no id of its own to address.
      let target = graph
      const subgraphOf = optString(op.subgraphOf)
      if (subgraphOf) {
        const owner = findNode(graph, subgraphOf)
        if (!owner) throw new Error(`${op.op}: no node ${subgraphOf}.`)
        if (owner.kind !== 'iteration') {
          throw new Error(
            `${op.op}: \`subgraphOf\` must name an iteration node; ${subgraphOf} is a ${owner.kind} node.`,
          )
        }
        target = owner.config.subgraph
      }
      // Seeded from the engine's own table, so a fresh node here is identical to
      // one dropped on the canvas — including the deliberately-incomplete configs
      // (an agent with no agentId, a Text node with an empty body) that make the
      // graph lint as "not configured yet" instead of looking finished.
      const seeded = seed({ toolId: optString(op.arg) ?? '' })
      const node = {
        ...seeded,
        id: crypto.randomUUID(),
        position: freshPosition(target),
        informUser: { mode: 'off' as const },
        ...(optString(op.label) ? { label: optString(op.label) } : {}),
      } as WorkflowNode
      target.nodes.push(node)
      return {
        op: op.op,
        nodeId: node.id,
        summary: `added ${node.kind} "${node.label}" (${node.id})${
          subgraphOf ? ` inside iteration ${subgraphOf}` : ''
        } — no edges yet, and its config still needs filling in`,
      }
    }
    case 'set_inform_user': {
      const nodeId = need(op, 'nodeId')
      const node = findNode(graph, nodeId)
      if (!node) throw new Error(`${op.op}: no node ${nodeId}.`)
      // `informUser` is a SIBLING of `config`, not a key inside it, so
      // `merge_node_config` could never reach it — which left every
      // customer-visible progress note unauthorable from here.
      const parsed = informUserSchema.safeParse(op.informUser)
      if (!parsed.success) {
        throw new Error(
          `${op.op}: \`informUser\` must be { mode: "off" } | { mode: "static", note } | { mode: "dynamic", reasoning?, tools? } — ${parsed.error.issues[0]?.message ?? 'invalid'}.`,
        )
      }
      if (parsed.data.mode === 'dynamic' && node.kind !== 'agent') {
        throw new Error(
          `${op.op}: "dynamic" streams a model's live activity, so it only applies to agent nodes; ${nodeId} is a ${node.kind} node. Use "static" with a note.`,
        )
      }
      node.informUser = parsed.data
      return {
        op: op.op,
        nodeId,
        summary: `${node.label}: the user now sees ${
          parsed.data.mode === 'off'
            ? 'nothing for this step'
            : parsed.data.mode === 'static'
              ? `"${parsed.data.note}"`
              : 'the agent’s live activity'
        }`,
      }
    }
    case 'set_node_execution': {
      const nodeId = need(op, 'nodeId')
      const node = findNode(graph, nodeId)
      if (!node) throw new Error(`${op.op}: no node ${nodeId}.`)
      // Also a sibling of `config`. An empty object CLEARS the policy rather
      // than storing a meaningless one — the field is optional, and absent is
      // what "use the engine default" looks like.
      if (op.execution && Object.keys(op.execution).length === 0) {
        delete node.execution
        return {
          op: op.op,
          nodeId,
          summary: `${node.label}: execution policy cleared (engine defaults)`,
        }
      }
      const parsed = nodeExecutionSchema.safeParse(op.execution)
      if (!parsed.success) {
        throw new Error(
          `${op.op}: \`execution\` must be { continueOnError?, timeoutMs?, background?, retries?: { limit, delayMs?, backoff? } } — ${parsed.error.issues[0]?.message ?? 'invalid'}. Pass {} to clear it.`,
        )
      }
      node.execution = parsed.data
      return {
        op: op.op,
        nodeId,
        summary: `${node.label}: execution ${Object.keys(parsed.data).join(', ')}`,
      }
    }
    case 'set_tool_arg': {
      const nodeId = need(op, 'nodeId')
      const arg = need(op, 'arg')
      const node = findNode(graph, nodeId)
      if (!node) throw new Error(`${op.op}: no node ${nodeId}.`)
      if (node.kind !== 'tool') {
        throw new Error(`${op.op}: node ${nodeId} is a ${node.kind} node, not a tool node.`)
      }
      const parsed = argBindingSchema.safeParse(op.binding)
      if (!parsed.success) {
        throw new Error(
          `${op.op}: \`binding\` must be { kind: "literal", value } or { kind: "ref", nodeId, path } — ${parsed.error.issues[0]?.message ?? 'invalid'}.`,
        )
      }
      const binding: ArgBinding = parsed.data
      if (binding.kind === 'ref' && !findNode(graph, binding.nodeId)) {
        throw new Error(`${op.op}: ref points at missing node ${binding.nodeId}.`)
      }
      const before = node.config.args[arg]
      node.config.args[arg] = binding
      return {
        op: op.op,
        nodeId,
        summary: `${node.label}: ${arg} ${before ? 'changed' : 'added'} → ${describeBinding(binding)}`,
      }
    }
    case 'remove_tool_arg': {
      const nodeId = need(op, 'nodeId')
      const arg = need(op, 'arg')
      const node = findNode(graph, nodeId)
      if (!node) throw new Error(`${op.op}: no node ${nodeId}.`)
      if (node.kind !== 'tool') {
        throw new Error(`${op.op}: node ${nodeId} is a ${node.kind} node, not a tool node.`)
      }
      if (!Object.hasOwn(node.config.args, arg)) {
        throw new Error(`${op.op}: ${node.label} has no arg "${arg}" (has: ${Object.keys(node.config.args).join(', ') || 'none'}).`)
      }
      delete node.config.args[arg]
      return { op: op.op, nodeId, summary: `${node.label}: removed arg ${arg}` }
    }
    case 'set_node_label': {
      const nodeId = need(op, 'nodeId')
      const label = need(op, 'label')
      const node = findNode(graph, nodeId)
      if (!node) throw new Error(`${op.op}: no node ${nodeId}.`)
      const before = node.label
      node.label = label
      return { op: op.op, nodeId, summary: `"${before}" → "${label}"` }
    }
    case 'merge_node_config': {
      const nodeId = need(op, 'nodeId')
      const node = findNode(graph, nodeId)
      if (!node) throw new Error(`${op.op}: no node ${nodeId}.`)
      if (!op.config || Object.keys(op.config).length === 0) {
        throw new Error(`${op.op} needs a non-empty \`config\`.`)
      }
      Object.assign(node.config as Record<string, unknown>, op.config)
      return {
        op: op.op,
        nodeId,
        summary: `${node.label}: set ${Object.keys(op.config).join(', ')}`,
      }
    }
    case 'add_edge': {
      const source = need(op, 'source')
      const target = need(op, 'target')
      const from = findOwner(graph, source)
      const to = findOwner(graph, target)
      for (const [id, found] of [
        [source, from],
        [target, to],
      ] as const) {
        if (!found) throw new Error(`${op.op}: no node ${id}.`)
      }
      // An edge belongs to the graph holding BOTH ends. An iteration subgraph is
      // a closed scope — the engine runs it once per item — so a cross-boundary
      // edge has no meaning and would be dropped silently on validation.
      if (from!.graph !== to!.graph) {
        throw new Error(
          `${op.op}: ${source} and ${target} are in different graphs (an iteration subgraph is a closed scope). Feed an iteration from ONE node via its \`source\` ref instead of wiring across the boundary.`,
        )
      }
      const owner = from!.graph
      const condition = optString(op.condition) ?? null
      const dup = owner.edges.find(
        (e) => e.source === source && e.target === target && e.condition === condition,
      )
      if (dup) throw new Error(`${op.op}: that edge already exists (${dup.id}).`)
      const edge: WorkflowEdge = { id: crypto.randomUUID(), source, target, condition }
      owner.edges.push(edge)
      return {
        op: op.op,
        summary: `edge ${edge.id}: ${source} → ${target}${condition ? ` [${condition}]` : ''}${owner === graph ? '' : ' (inside an iteration subgraph)'}`,
      }
    }
    case 'remove_edge': {
      const edgeId = optString(op.edgeId)
      if (!edgeId && !(op.source && op.target)) {
        throw new Error(`${op.op} needs \`edgeId\`, or \`source\` + \`target\`.`)
      }
      // Every graph in the tree, so an edge inside an iteration subgraph is
      // reachable — `findOwner` already let its nodes be configured, and being
      // able to configure a node you cannot unwire is the worse half of a
      // half-implemented feature.
      const matched: { owner: WorkflowGraph; edge: WorkflowEdge }[] = []
      for (const owner of allGraphs(graph)) {
        for (const e of owner.edges) {
          const hit = edgeId
            ? e.id === edgeId
            : e.source === op.source && e.target === op.target
          if (hit) matched.push({ owner, edge: e })
        }
      }
      if (matched.length === 0) throw new Error(`${op.op}: no such edge.`)
      for (const owner of new Set(matched.map((m) => m.owner))) {
        const gone = new Set(
          matched.filter((m) => m.owner === owner).map((m) => m.edge.id),
        )
        owner.edges = owner.edges.filter((e) => !gone.has(e.id))
      }
      return {
        op: op.op,
        summary: `removed ${matched.map(({ edge: e }) => `${e.source} → ${e.target}${e.condition ? ` [${e.condition}]` : ''}`).join(', ')}`,
      }
    }
    case 'remove_node': {
      const nodeId = need(op, 'nodeId')
      const found = findOwner(graph, nodeId)
      if (!found) throw new Error(`${op.op}: no node ${nodeId}.`)
      const { graph: owner, node } = found
      owner.nodes = owner.nodes.filter((n) => n.id !== nodeId)
      const edges = owner.edges.filter(
        (e) => e.source === nodeId || e.target === nodeId,
      )
      owner.edges = owner.edges.filter(
        (e) => e.source !== nodeId && e.target !== nodeId,
      )
      return {
        op: op.op,
        nodeId,
        summary: `removed ${node.kind} "${node.label}"${owner === graph ? '' : ' from an iteration subgraph'} and ${edges.length} connected edge${edges.length === 1 ? '' : 's'}`,
      }
    }
    default:
      op.op satisfies never
      throw new Error(`Unknown op ${String(op.op)}.`)
  }
}

function describeBinding(b: ArgBinding): string {
  if (b.kind === 'literal') return `literal ${JSON.stringify(b.value)}`
  return `ref ${b.nodeId}${b.path ? `.${b.path}` : ' (whole output)'}`
}

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

/**
 * What differs between two graphs, by id. Positions are ignored — a node that
 * only moved did not change what runs. Same purpose as `changedKeys` for agents:
 * a write that dropped something must say so in the reply, not in a run later.
 */
export function graphDelta(
  before: WorkflowGraph | null | undefined,
  after: WorkflowGraph,
): {
  nodesAdded: string[]
  nodesRemoved: string[]
  nodesChanged: string[]
  edgesAdded: number
  edgesRemoved: number
} {
  const flat = (n: WorkflowNode) => {
    return JSON.stringify({
      kind: n.kind,
      label: n.label,
      config: n.config,
      informUser: n.informUser,
    })
  }
  const a = new Map((before?.nodes ?? []).map((n) => [n.id, flat(n)]))
  const b = new Map(after.nodes.map((n) => [n.id, flat(n)]))
  const name = (id: string) => {
    const n = after.nodes.find((x) => x.id === id) ?? before?.nodes.find((x) => x.id === id)
    return n ? `${n.label} (${id})` : id
  }
  const edgeKey = (e: WorkflowEdge) => `${e.source}>${e.target}>${e.condition ?? ''}`
  const ea = new Set((before?.edges ?? []).map(edgeKey))
  const eb = new Set(after.edges.map(edgeKey))
  return {
    nodesAdded: [...b.keys()].filter((id) => !a.has(id)).map(name),
    nodesRemoved: [...a.keys()].filter((id) => !b.has(id)).map(name),
    nodesChanged: [...b.keys()].filter((id) => a.has(id) && a.get(id) !== b.get(id)).map(name),
    edgesAdded: [...eb].filter((k) => !ea.has(k)).length,
    edgesRemoved: [...ea].filter((k) => !eb.has(k)).length,
  }
}

function isEmptyDelta(d: ReturnType<typeof graphDelta>): boolean {
  return (
    d.nodesAdded.length === 0 &&
    d.nodesRemoved.length === 0 &&
    d.nodesChanged.length === 0 &&
    d.edgesAdded === 0 &&
    d.edgesRemoved === 0
  )
}

function clipValidation(v: WfGraphValidation) {
  return {
    source: v.source,
    versionNumber: v.versionNumber,
    errors: v.errors,
    warnings: v.warnings,
    issues: v.issues.slice(0, MAX_ISSUES).map(issueLine),
    ...(v.issues.length > MAX_ISSUES
      ? { omitted: v.issues.length - MAX_ISSUES }
      : {}),
  }
}

function issueLine(i: GraphIssue): string {
  const where = i.nodeLabel ? `${i.nodeLabel}${i.nodeId ? ` (${i.nodeId})` : ''}: ` : ''
  return `[${i.severity}] ${where}${i.message}`
}

/** The graph a draft edit starts from: the draft, else what is published. */
function baseGraph(detail: WfWorkflowDetail): {
  graph: WorkflowGraph
  from: 'draft' | 'published'
} | null {
  if (detail.draft) return { graph: detail.draft.graph, from: 'draft' }
  if (detail.currentVersion) {
    return { graph: detail.currentVersion.graph, from: 'published' }
  }
  return null
}

async function requireWorkflow(
  client: WfDataClient,
  workflowId: string,
): Promise<WfWorkflowDetail> {
  const detail = await client.getWorkflow(workflowId)
  if (!detail) throw new Error(`No workflow found for id ${workflowId}.`)
  return detail
}

/** Write a draft, lint it, and describe both — shared by patch and update. */
async function saveDraft(
  client: WfDataClient,
  detail: WfWorkflowDetail,
  graph: WorkflowGraph,
): Promise<Record<string, unknown>> {
  const workflowId = detail.workflow.id
  await client.updateDraft({ workflowId, graph })
  const validation = await client.validateGraph({ graph })
  const published = detail.currentVersion
  const delta = graphDelta(published?.graph, graph)
  return {
    ok: true,
    workflowId,
    validation: clipValidation({ ...validation, source: 'draft' }),
    draftDiffersFromPublished: delta,
    note: published
      ? `Saved as a draft only — v${published.versionNumber} is unchanged and still what runs. ${
          validation.errors > 0
            ? `The draft has ${validation.errors} error${validation.errors === 1 ? '' : 's'} and cannot be published until they are fixed.`
            : 'It lints clean.'
        } It also replaced whatever draft someone had open in the editor.`
      : 'Saved as a draft. This workflow has never been published.',
    next:
      validation.errors === 0 && published
        ? `publish_workflow({ workflowId: "${workflowId}", baseVersionNumber: ${published.versionNumber}, changeNote: "…" }) to make it live.`
        : 'Fix the errors, then publish_workflow.',
  }
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export function workflowReadTools(): WfMcpTool[] {
  return [
    {
      name: 'list_workflow_versions',
      title: 'List workflow versions',
      description:
        'Every published version of one workflow, newest first, with its number, the author’s change note and the AI summary. The highest number is what runs. Use it to find when a behavior changed, then get_workflow_version to read that graph and list_changes to see who published it.',
      inputSchema: {
        workflowId: z.string().describe('Workflow id, from list_workflows.'),
      },
      readOnly: true,
      run: async (client, args) => {
        const workflowId = reqString(args.workflowId, 'workflowId')
        const detail = await requireWorkflow(client, workflowId)
        const versions = await client.listVersions(workflowId)
        return {
          workflowId,
          name: detail.workflow.name,
          current: detail.currentVersion?.versionNumber ?? null,
          // A draft row sits beside nearly every workflow; only a draft that
          // DIFFERS from what is live is an edit in flight.
          unpublishedDraft: detail.draft
            ? !isEmptyDelta(graphDelta(detail.currentVersion?.graph, detail.draft.graph))
            : false,
          versions: [...versions]
            .sort((a, b) => b.versionNumber - a.versionNumber)
            .map((v) => ({
              versionId: v.id,
              versionNumber: v.versionNumber,
              changeNote: v.changeNote,
              summary: v.aiSummaryShort,
              details: v.aiSummaryLong,
              publishedAt: v.publishedAt,
            })),
        }
      },
    },

    {
      name: 'get_workflow_version',
      title: 'Get one workflow version',
      description:
        'The graph of one published version, by the versionId list_workflow_versions showed. Immutable. Compare two to see exactly what a publish changed.',
      inputSchema: {
        versionId: z.string().describe('Version id, from list_workflow_versions.'),
      },
      readOnly: true,
      run: async (client, args) => {
        const versionId = reqString(args.versionId, 'versionId')
        const v = await client.getVersion(versionId)
        return v ?? { error: `No version found for id ${versionId}.` }
      },
    },

    {
      name: 'validate_workflow_graph',
      title: 'Validate a workflow graph',
      description:
        'Lint a graph the way the editor’s Issues panel does, plus the check only the server can make: every Tool node’s args against the live tool catalog — an arg the tool no longer declares, a required arg left unbound, a literal of the wrong type (the boolean stored as the text "false"). Each error is a run that fails at that node. Pass workflowId to lint its draft (falling back to what is published), versionId for one published version, or graph for a graph you are about to write. Reads only.',
      inputSchema: {
        workflowId: z.string().nullish().describe('Lint this workflow’s draft, or its published graph if it has no draft.'),
        versionId: z.string().nullish().describe('Lint one published version.'),
        graph: z
          .record(z.string(), z.unknown())
          .nullish()
          .describe('Lint this graph as-is, without writing it.'),
      },
      readOnly: true,
      run: async (client, args) => {
        const workflowId = optString(args.workflowId)
        const versionId = optString(args.versionId)
        const graph = args.graph && typeof args.graph === 'object' ? (args.graph as WorkflowGraph) : undefined
        if (!workflowId && !versionId && !graph) {
          return { error: 'Pass one of workflowId, versionId or graph.' }
        }
        const v = await client.validateGraph({ workflowId, versionId, graph })
        return {
          ...clipValidation(v),
          verdict:
            v.errors > 0
              ? 'Cannot be published from here until the errors are fixed; if it is already published, runs that reach those nodes fail.'
              : v.warnings > 0
                ? 'Publishable; the warnings are advisory.'
                : 'Clean.',
        }
      },
    },

    {
      name: 'list_trigger_events',
      title: 'List trigger events',
      description: [
        'The ways a workflow can START here, and what each one hands it. `get_tool_catalog` for tools; this is the equivalent for triggers, and without it a trigger node can only be authored by guessing at a `triggerKind` the host may not declare.',
        '',
        'Two built-ins are always available and are NOT in this list: `manual` (someone presses Run; no payload) and `periodic` (a cron expression on the trigger node). Everything returned here is a host-declared EVENT — something real happening in the product — and its `kind` is the exact string a trigger node’s `config.triggerKind` takes.',
        '',
        '`fields` is the payload the trigger routes, which is what downstream nodes can `ref` and what an eval Sample’s `input.payload` has to look like. `outputContract` is the shape the workflow must PRODUCE — the runtime enforces it, so an Output node bound to the wrong shape fails the run rather than quietly returning something the caller cannot use (a chat trigger, for instance, contracts `string | { text }`).',
      ].join('\n'),
      inputSchema: {},
      readOnly: true,
      run: async (client) => {
        const events = await client.listTriggerEvents()
        return {
          builtIn: [
            {
              kind: MANUAL_TRIGGER_KIND,
              description:
                'Started by hand, and what every agent eval runs under. No payload.',
            },
            {
              kind: PERIODIC_TRIGGER_KIND,
              description:
                'Runs on a cron schedule — set `cron` on the trigger node alongside this kind.',
            },
          ],
          events,
          note:
            events.length === 0
              ? 'This host declares no event triggers, so a workflow can only start manually or on a schedule.'
              : undefined,
        }
      },
    },
  ]
}

export function workflowWriteTools(): WfMcpTool[] {
  return [
    {
      name: 'create_workflow',
      title: 'Create workflow',
      description: [
        'Create a workflow. It starts as the minimal graph — the trigger you choose wired straight into an Output node — and that graph is published as v1, so the workflow is real and addressable immediately. Build it up from there with patch_workflow_draft, then publish_workflow.',
        '',
        'ONE THING IS ALREADY WRONG WITH IT, deliberately: the Output node has no value bound, which lints as an error and means a run reaching it would fail. That is what the console\'s New Workflow button produces too — an Output cannot be bound before there is anything to bind it to. Binding it (`merge_node_config` on the Output with `{ "source": { "kind": "ref", "nodeId": "<the node that produces the answer>", "path": "" } }`) is the last step of building the graph, and publish_workflow will refuse until it is done.',
        '',
        'Pick how it starts with `trigger`:',
        `  • "${MANUAL_TRIGGER_KIND}" (the default) — someone presses Run. No payload.`,
        `  • "${PERIODIC_TRIGGER_KIND}" — on a schedule; \`cron\` is then required.`,
        '  • any event `kind` from list_trigger_events — the workflow fires when that happens in the product, and the event’s payload is what its nodes read.',
        '',
        'An event kind is checked against the host’s registry first, because a trigger kind nothing declares is a workflow that can never fire — and nothing would say so until someone wondered why it never ran.',
        '',
        'Creating one is cheap and reversible: it is referenced by nothing, fires only on the trigger you gave it, and update_workflow can archive it. A `periodic` workflow, though, begins firing on its own schedule as soon as it is published — which v1 is.',
      ].join('\n'),
      inputSchema: {
        name: z
          .string()
          .describe('What the workflow does, e.g. "Intake — conflict check".'),
        trigger: z
          .string()
          .nullish()
          .describe(
            `How it starts: "${MANUAL_TRIGGER_KIND}" (default), "${PERIODIC_TRIGGER_KIND}", or an event kind from list_trigger_events.`,
          ),
        cron: z
          .string()
          .nullish()
          .describe(
            'Cron expression, required when trigger is "periodic" and ignored otherwise.',
          ),
        description: z.string().nullish().describe('Optional longer note.'),
      },
      readOnly: false,
      run: async (client, args) => {
        const name = reqString(args.name, 'name')
        const trigger = optString(args.trigger) ?? MANUAL_TRIGGER_KIND
        const cron = optString(args.cron)

        let seed: NewWorkflowTrigger
        if (trigger === MANUAL_TRIGGER_KIND) {
          seed = { mode: 'manual' }
        } else if (trigger === PERIODIC_TRIGGER_KIND) {
          if (!cron) {
            return {
              error: 'A "periodic" workflow needs `cron` — the schedule it runs on.',
            }
          }
          seed = { mode: 'periodic', cron }
        } else {
          // The registry check. `triggerKind` is a plain string on the node and is
          // only resolved at execution time, so an unknown kind stores happily
          // and produces a workflow that simply never fires.
          const events: TriggerEventOption[] = await client
            .listTriggerEvents()
            .catch(() => [])
          const event = events.find((e) => e.kind === trigger)
          if (!event) {
            return {
              error: `This host declares no trigger event "${trigger}", so a workflow started by it could never fire. Use "${MANUAL_TRIGGER_KIND}", "${PERIODIC_TRIGGER_KIND}", or one of: ${
                events.map((e) => e.kind).join(', ') || '(none declared)'
              }. list_trigger_events describes each.`,
            }
          }
          seed = {
            mode: 'event',
            event: trigger,
            // The human description, so the canvas never shows the internal kind.
            eventLabel: event.description || undefined,
          }
        }

        const graph = buildStarterGraph(seed)
        const { workflowId } = await client.createWorkflow({
          name,
          description: optString(args.description),
          graph,
        })
        const detail = await client.getWorkflow(workflowId)
        const triggerNode = graph.nodes.find((n) => n.kind === 'trigger')
        const outputNode = graph.nodes.find((n) => n.kind === 'output')
        return {
          workflowId,
          name,
          trigger,
          publishedVersion: detail?.currentVersion?.versionNumber ?? null,
          nodes: {
            trigger: triggerNode?.id,
            output: outputNode?.id,
          },
          // Spelled out because the Output binding is the step most easily
          // forgotten and the one that blocks the publish.
          next: `Add nodes with patch_workflow_draft({ workflowId: "${workflowId}", ops: [{ op: "add_node", kind: "agent" }, …] }), wire them from ${triggerNode?.id}, then bind the Output: { op: "merge_node_config", nodeId: "${outputNode?.id}", config: { source: { kind: "ref", nodeId: "<answer node>", path: "" } } }. Publish with baseVersionNumber: ${detail?.currentVersion?.versionNumber ?? 1}.`,
          lintsWith: `1 error until the Output is bound — v1 exists but a run reaching ${outputNode?.id} would fail. publish_workflow refuses while that stands.`,
          warning:
            trigger === PERIODIC_TRIGGER_KIND
              ? `v1 is live, so this workflow starts firing on "${cron}" now — and all it does yet is pass the trigger through to the Output.`
              : undefined,
        }
      },
    },

    {
      name: 'update_workflow',
      title: 'Rename or archive a workflow',
      description: [
        'Rename a workflow, or archive it (and bring it back). Nothing about its graph is touched, and nothing is published — for the graph use patch_workflow_draft / publish_workflow, and for the description use update_description.',
        '',
        'ARCHIVING IS HOW A WORKFLOW IS RETIRED: an archived workflow stops firing on its event and drops out of the lists. It is not a delete — its versions, runs and history all survive, and `archived: false` brings it back — which is exactly why it is the right way to stop something rather than deleting it.',
        '',
        'Both land in the `wf_change` feed attributed to whoever authorized this session.',
      ].join('\n'),
      inputSchema: {
        workflowId: z.string().describe('Workflow id, from list_workflows.'),
        name: z.string().nullish().describe('New name for the workflow.'),
        archived: z
          .boolean()
          .nullish()
          .describe(
            'true retires it — it stops firing and leaves the lists; false brings it back.',
          ),
      },
      readOnly: false,
      run: async (client, args) => {
        const workflowId = reqString(args.workflowId, 'workflowId')
        const name = optString(args.name)
        const archived =
          typeof args.archived === 'boolean' ? args.archived : undefined
        if (name === undefined && archived === undefined) {
          return {
            error: 'Pass `name`, `archived`, or both — there is nothing else this tool changes.',
          }
        }
        const detail = await requireWorkflow(client, workflowId)
        await client.updateWorkflow({ workflowId, name, archived })
        const trigger = detail.currentVersion?.graph.nodes.find(
          (n) => n.kind === 'trigger',
        )
        const triggerKind =
          trigger?.kind === 'trigger' ? trigger.config.triggerKind : undefined
        return {
          workflowId,
          before: { name: detail.workflow.name, archived: detail.workflow.archived },
          after: {
            name: name ?? detail.workflow.name,
            archived: archived ?? detail.workflow.archived,
          },
          note:
            archived === true
              ? `Retired. It no longer fires${triggerKind ? ` on "${triggerKind}"` : ''} and drops out of list_workflows; its versions and run history are untouched, and update_workflow({ archived: false }) brings it back.`
              : archived === false
                ? 'Restored — it fires again on its trigger.'
                : undefined,
        }
      },
    },

    {
      name: 'patch_workflow_draft',
      title: 'Patch workflow draft',
      description: [
        'Apply a list of small, named changes to a workflow’s DRAFT — starting from the existing draft, or from the published graph if there is none. Ops:',
        '',
        `  • add_node (kind, label?, subgraphOf?) — kind is one of ${ADDABLE_KINDS.join(', ')}. Returns the new node's id; it arrives with its kind's default config and NO edges, so follow it with the ops that configure and wire it.`,
        '  • set_tool_arg (nodeId, arg, binding) / remove_tool_arg (nodeId, arg)',
        '  • set_node_label (nodeId, label)',
        '  • merge_node_config (nodeId, config) — shallow merge into the node’s `config`',
        '  • set_inform_user (nodeId, informUser) — what the CUSTOMER sees while the step runs',
        '  • set_node_execution (nodeId, execution) — retry/timeout/background policy; {} clears it',
        '  • add_edge (source, target, condition?) / remove_edge (edgeId | source+target)',
        '  • remove_node (nodeId — its edges go too)',
        '',
        '`informUser` and `execution` are SIBLINGS of `config`, not keys inside it, so merge_node_config cannot reach them — that is what the two dedicated ops are for.',
        '',
        'Every op reaches into an `iteration` node’s per-item subgraph as well as the top level, addressing inner nodes by their own ids. An edge must have both ends in the same graph: an iteration subgraph is a closed scope, so feed it from ONE node via its `source` ref rather than wiring across the boundary.',
        '',
        'Ops apply in order and all-or-nothing: one bad op writes nothing. The reply lints the result and names every node that now differs from the published version. Nothing runs the draft; publish_workflow makes it live. Read get_workflow first for node ids, and validate_workflow_graph or get_tool_catalog for what a tool’s args are called and typed.',
      ].join('\n'),
      inputSchema: {
        workflowId: z.string().describe('Workflow id, from list_workflows.'),
        ops: z.array(opSchema).describe('The changes, applied in order.'),
      },
      readOnly: false,
      run: async (client, args) => {
        const workflowId = reqString(args.workflowId, 'workflowId')
        const rawOps = Array.isArray(args.ops) ? args.ops : []
        if (rawOps.length === 0) return { error: 'Pass at least one op.' }
        const ops = rawOps.map((o, i) => {
          const parsed = opSchema.safeParse(o)
          if (!parsed.success) {
            throw new Error(`ops[${i}]: ${parsed.error.issues[0]?.message ?? 'invalid op'}.`)
          }
          return parsed.data
        })

        const detail = await requireWorkflow(client, workflowId)
        const base = baseGraph(detail)
        if (!base) return { error: `Workflow ${workflowId} has no draft and no published version to patch.` }

        const graph = structuredClone(base.graph)
        const applied: Applied[] = []
        for (const [i, op] of ops.entries()) {
          try {
            applied.push(applyPatchOp(graph, op))
          } catch (err) {
            return {
              error: `ops[${i}] failed: ${err instanceof Error ? err.message : String(err)} Nothing was written.`,
              applied,
            }
          }
        }
        // The result must still be a well-formed graph — `merge_node_config`
        // in particular can produce a config the node's kind does not accept.
        const shaped = workflowGraphShapeSchema.safeParse(graph)
        if (!shaped.success) {
          return {
            error: `The patched graph is not well-formed, so nothing was written: ${shaped.error.issues
              .slice(0, 5)
              .map((i) => `${i.path.join('.')}: ${i.message}`)
              .join('; ')}`,
            applied,
          }
        }
        // Edits that were already in the draft before this patch — someone
        // else's unpublished work, which a later publish_workflow would ship
        // along with these ops. Named here so the caller knows what it is
        // standing on.
        const inherited = graphDelta(detail.currentVersion?.graph, base.graph)
        return {
          startedFrom: base.from,
          ...(isEmptyDelta(inherited)
            ? {}
            : {
                inheritedUnpublishedEdits: inherited,
                warning:
                  'The draft already differed from the published version before this patch (see inheritedUnpublishedEdits). Publishing now ships those edits too; discard_workflow_draft and re-patch to start from what is live.',
              }),
          applied,
          ...(await saveDraft(client, detail, shaped.data)),
        }
      },
    },

    {
      name: 'update_workflow_draft',
      title: 'Update workflow draft',
      description: [
        'Replace a workflow’s unsaved DRAFT graph outright. For structural rewrites patch_workflow_draft cannot express; prefer patch_workflow_draft otherwise — this overwrites the whole graph, so any node, edge or field you omit is gone. Read get_workflow first and send the complete graph ({ version: 1, nodes, edges }) with your edits applied. Not a patch.',
        '',
        '`fromVersion` is the ROLLBACK shape and the one case where a whole-graph replace is the safe option: pass a published versionNumber instead of a `graph` and the draft becomes an exact copy of that version, read server-side. Doing it by hand (get_workflow_version then send the graph back) is the resend this tool warns about, so rolling back used to be riskier from here than from the console. Nothing is published — review the draft, then publish_workflow.',
        '',
        'The reply lints the result and names every node that now differs from the published version. Nothing runs the draft; publish_workflow makes it live.',
      ].join('\n'),
      inputSchema: {
        workflowId: z.string().describe('Workflow id, from list_workflows.'),
        graph: z
          .record(z.string(), z.unknown())
          .nullish()
          .describe('The complete WorkflowGraph — the same object get_workflow returns under `draft.graph` / `currentVersion.graph`, edited. Not a patch. Omit when using fromVersion.'),
        fromVersion: z
          .number()
          .nullish()
          .describe('Reset the draft to this published versionNumber instead of sending a graph — the rollback path. Cannot be combined with `graph`.'),
      },
      readOnly: false,
      run: async (client, args) => {
        const workflowId = reqString(args.workflowId, 'workflowId')
        const fromVersion =
          typeof args.fromVersion === 'number' ? args.fromVersion : undefined
        const hasGraph = !!args.graph && typeof args.graph === 'object'
        if (fromVersion != null && hasGraph) {
          return {
            error: 'Pass either `graph` (a rewrite) or `fromVersion` (a rollback), not both.',
          }
        }
        const detail = await requireWorkflow(client, workflowId)

        if (fromVersion != null) {
          const versions = await client.listVersions(workflowId)
          const target = versions.find((v) => v.versionNumber === fromVersion)
          if (!target) {
            return {
              error: `Workflow ${workflowId} has no published version ${fromVersion}. Published versions are ${
                versions.length > 0
                  ? versions.map((v) => v.versionNumber).sort((a, b) => a - b).join(', ')
                  : '(none yet)'
              }.`,
            }
          }
          // Read the stored graph rather than asking the caller to relay it: the
          // relay IS the lossy step, and a version is immutable so the server's
          // copy is definitionally the right one.
          const full = await client.getVersion(target.id)
          if (!full) {
            return { error: `Version ${fromVersion} could not be read back.` }
          }
          const saved = await saveDraft(client, detail, full.graph)
          return {
            ...saved,
            revertedTo: fromVersion,
            note: `The draft is now an exact copy of v${fromVersion}. Nothing is live yet — publish_workflow makes it so, and baseVersionNumber must still be the version that is CURRENTLY published (v${detail.currentVersion?.versionNumber ?? 0}), not ${fromVersion}.`,
          }
        }

        const shaped = workflowGraphShapeSchema.safeParse(args.graph)
        if (!shaped.success) {
          return {
            error: `\`graph\` is not a well-formed workflow graph, so nothing was written: ${shaped.error.issues
              .slice(0, 5)
              .map((i) => `${i.path.join('.')}: ${i.message}`)
              .join('; ')}`,
          }
        }
        return await saveDraft(client, detail, shaped.data)
      },
    },

    {
      name: 'publish_workflow',
      title: 'Publish workflow',
      description:
        'Publish the workflow’s current DRAFT as a new immutable version — from this moment it is what the trigger runs. THIS CHANGES WHAT CUSTOMERS GET. Two gates, both refusals rather than warnings: the draft must lint with zero errors (see validate_workflow_graph), and baseVersionNumber must equal the version that is live right now — pass the versionNumber you read from get_workflow or list_workflow_versions, so a version someone else published since you read is never silently overwritten. changeNote is required and becomes the version’s note in the history and the wf_change feed. Does not publish agents; that is deliberately unavailable.',
      inputSchema: {
        workflowId: z.string().describe('Workflow id, from list_workflows.'),
        changeNote: z
          .string()
          .describe('What changed and why, in one line — a git commit subject.'),
        baseVersionNumber: z
          .number()
          .describe('The currently published versionNumber you based the draft on. Refused if a newer one exists.'),
        summarize: z
          .boolean()
          .nullish()
          .describe(
            'Generate the version’s AI change summary as part of publishing (default true). The summary is what the history and the drift report show instead of a bare version number; a host that wired no background task never fills it in afterwards, so an MCP-published version would keep a null summary forever. Pass false to skip the extra model call.',
          ),
      },
      readOnly: false,
      run: async (client, args) => {
        const workflowId = reqString(args.workflowId, 'workflowId')
        const changeNote = optString(args.changeNote)?.trim()
        if (!changeNote) return { error: 'Missing required argument `changeNote`.' }
        const base = args.baseVersionNumber
        if (typeof base !== 'number' || !Number.isSafeInteger(base)) {
          return { error: 'Missing required argument `baseVersionNumber` — the versionNumber you read before editing.' }
        }

        const detail = await requireWorkflow(client, workflowId)
        const live = detail.currentVersion
        if (live && live.versionNumber !== base) {
          return {
            error: `Refused: v${live.versionNumber} is live but you based this on v${base}. Someone published since you read the workflow. Re-read it (get_workflow), check whether your draft still makes sense on top of v${live.versionNumber}, and pass baseVersionNumber: ${live.versionNumber}.`,
          }
        }
        if (!live && base !== 0) {
          return { error: 'Refused: this workflow has never been published; pass baseVersionNumber: 0.' }
        }
        if (!detail.draft) {
          return {
            error: live
              ? `Refused: there is no draft to publish — v${live.versionNumber} is already what runs. Write one with patch_workflow_draft first.`
              : 'Refused: this workflow has no draft and no version.',
          }
        }
        const graph = detail.draft.graph
        const delta = graphDelta(live?.graph, graph)
        if (live && isEmptyDelta(delta)) {
          return { error: `Refused: the draft is identical to v${live.versionNumber}; publishing would create an empty version.` }
        }
        const validation = await client.validateGraph({ graph })
        if (validation.errors > 0) {
          return {
            error: `Refused: the draft has ${validation.errors} error${validation.errors === 1 ? '' : 's'}. Each one is a run that fails at that node. Fix them with patch_workflow_draft, then publish.`,
            validation: clipValidation({ ...validation, source: 'draft' }),
          }
        }

        // Generated BEFORE the publish, and inline. `saveVersion` falls back to
        // generating one asynchronously, which needs the host to have wired a
        // background task — and on a host that hasn't, `aiSummaryShort` simply
        // stays null forever. Doing it here means the version row is complete the
        // moment it exists, whatever the host wired. A failure is not fatal: a
        // published version with no summary beats a refused publish.
        const summarize = args.summarize !== false
        const aiSummary = summarize
          ? await client
              .summarizeChanges({ workflowId, graph })
              .catch(() => undefined)
          : undefined

        const out = await client.saveVersion({
          workflowId,
          graph,
          changeNote,
          aiSummary,
        })
        return {
          ok: true,
          summary: aiSummary?.short,
          workflowId,
          published: { versionId: out.versionId, versionNumber: out.versionNumber },
          previous: live?.versionNumber ?? null,
          changed: delta,
          warnings: validation.warnings,
          note: `v${out.versionNumber} is live: the next ${detail.workflow.name} run uses it. Runs already in flight finish on the version they started with.`,
        }
      },
    },

    {
      name: 'discard_workflow_draft',
      title: 'Discard workflow draft',
      description:
        'Throw away the workflow’s unsaved draft so the editor shows the published version again. The undo for patch_workflow_draft / update_workflow_draft. Also discards whatever a person had unsaved in the editor, so the reply says what was lost.',
      inputSchema: {
        workflowId: z.string().describe('Workflow id, from list_workflows.'),
      },
      readOnly: false,
      run: async (client, args) => {
        const workflowId = reqString(args.workflowId, 'workflowId')
        const detail = await requireWorkflow(client, workflowId)
        if (!detail.draft) return { ok: true, workflowId, note: 'There was no draft to discard.' }
        const lost = graphDelta(detail.currentVersion?.graph, detail.draft.graph)
        await client.discardDraft({ workflowId })
        return {
          ok: true,
          workflowId,
          discarded: lost,
          note: isEmptyDelta(lost)
            ? 'The draft matched the published version; nothing of substance was lost.'
            : `The draft differed from v${detail.currentVersion?.versionNumber ?? '—'} as listed above; those edits are gone.`,
        }
      },
    },
    {
      name: 'retry_run',
      title: 'Retry a run',
      description: [
        'Re-execute a finished run. This is the last step of the diagnose loop — list_runs status=failed → get_run → get_run_step → patch_workflow_draft → publish_workflow → retry_run — which otherwise ended one move short of acting on what it found.',
        '',
        'THIS EXECUTES REAL SIDE EFFECTS. A retried run is a run: its tool nodes send the emails, write the records and call the third parties they were always going to. It is not a dry run and there is no preview. If the original run half-completed, the nodes that already succeeded run AGAIN under `restart` — only nodes written to be idempotent are safe to repeat.',
        '',
        'Two modes, and they answer different questions:',
        '  • "restart" (the default) — a fresh run from the beginning on the LATEST published version. This is what you want after publishing a fix: the point is to exercise the new graph.',
        '  • "resume" — reuse the version the original run was pinned to and pick up from the step that failed. For a transient failure (a provider 429, a timeout) where the graph was never the problem and the completed work is worth keeping.',
        '',
        'A new run id comes back; the original is left exactly as it was, so the failure stays on the record. Requires the host to have wired its `retryRun` hook — without it this refuses rather than silently doing nothing.',
      ].join('\n'),
      inputSchema: {
        runId: z
          .string()
          .describe('Run id, from list_runs, get_run or list_feedback.'),
        mode: z
          .string()
          .nullish()
          .describe(
            '"restart" (default) re-runs from the start on the latest published version; "resume" continues the original version from the failed step.',
          ),
      },
      readOnly: false,
      run: async (client, args) => {
        const runId = reqString(args.runId, 'runId')
        const raw = optString(args.mode) ?? 'restart'
        if (raw !== 'restart' && raw !== 'resume') {
          return {
            error: `\`mode\` must be "restart" or "resume", not "${raw}".`,
          }
        }
        const mode: RetryRunMode = raw
        const before = await client.getRun(runId)
        if (!before) return { error: `No run found for id ${runId}.` }
        // Retrying something still going would produce two live runs of the same
        // work — and the run viewer only offers Retry on a finished one, so this
        // is the same gate rather than a new rule.
        if (before.run.status === 'running' || before.run.status === 'queued') {
          return {
            error: `Run ${runId} is still ${before.run.status}. Wait for it to finish — retrying now would leave two live runs doing the same work.`,
          }
        }
        const { runId: newRunId } = await client.retryRun({ runId, mode })
        return {
          retriedRunId: runId,
          runId: newRunId,
          mode,
          original: {
            status: before.run.status,
            error: before.run.error,
            versionNumber: before.versionNumber,
          },
          note:
            mode === 'restart'
              ? 'Started fresh on the latest published version. Every node runs again, side effects included.'
              : `Resuming on the version the original ran (v${before.versionNumber ?? '—'}), from the failed step. The graph is NOT the latest — publish-then-resume tests the old version.`,
          next: `Poll get_run("${newRunId}") until status is "done" or "completed".`,
        }
      },
    },
  ]
}
