import { z } from 'zod'

import {
  argBindingSchema,
  workflowGraphShapeSchema,
  type ArgBinding,
  type WorkflowEdge,
  type WorkflowGraph,
  type WorkflowNode,
} from '../engine/graph'
import type { GraphIssue } from '../engine/graph-issues'
import type {
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
// still exists for the structural rewrite an op list can't express.

/** Issues beyond this are counted, not listed — a broken graph has hundreds. */
const MAX_ISSUES = 40

// ---------------------------------------------------------------------------
// Patch ops
// ---------------------------------------------------------------------------

const OPS = [
  'set_tool_arg',
  'remove_tool_arg',
  'set_node_label',
  'merge_node_config',
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
})
type PatchOp = z.infer<typeof opSchema>

type Applied = { op: OpName; nodeId?: string; summary: string }

/** Find a node at the top level or inside any iteration subgraph. */
function findNode(graph: WorkflowGraph, id: string): WorkflowNode | undefined {
  for (const n of graph.nodes) {
    if (n.id === id) return n
    if (n.kind === 'iteration') {
      const inner = findNode(n.config.subgraph, id)
      if (inner) return inner
    }
  }
  return undefined
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
      for (const id of [source, target]) {
        if (!graph.nodes.some((n) => n.id === id)) {
          throw new Error(`${op.op}: no top-level node ${id}.`)
        }
      }
      const condition = optString(op.condition) ?? null
      const dup = graph.edges.find(
        (e) => e.source === source && e.target === target && e.condition === condition,
      )
      if (dup) throw new Error(`${op.op}: that edge already exists (${dup.id}).`)
      const edge: WorkflowEdge = { id: crypto.randomUUID(), source, target, condition }
      graph.edges.push(edge)
      return {
        op: op.op,
        summary: `edge ${edge.id}: ${source} → ${target}${condition ? ` [${condition}]` : ''}`,
      }
    }
    case 'remove_edge': {
      const edgeId = optString(op.edgeId)
      const matches = edgeId
        ? graph.edges.filter((e) => e.id === edgeId)
        : graph.edges.filter(
            (e) => e.source === op.source && e.target === op.target,
          )
      if (!edgeId && !(op.source && op.target)) {
        throw new Error(`${op.op} needs \`edgeId\`, or \`source\` + \`target\`.`)
      }
      if (matches.length === 0) throw new Error(`${op.op}: no such edge.`)
      const gone = new Set(matches.map((e) => e.id))
      graph.edges = graph.edges.filter((e) => !gone.has(e.id))
      return {
        op: op.op,
        summary: `removed ${matches.map((e) => `${e.source} → ${e.target}${e.condition ? ` [${e.condition}]` : ''}`).join(', ')}`,
      }
    }
    case 'remove_node': {
      const nodeId = need(op, 'nodeId')
      const node = graph.nodes.find((n) => n.id === nodeId)
      if (!node) throw new Error(`${op.op}: no top-level node ${nodeId}.`)
      graph.nodes = graph.nodes.filter((n) => n.id !== nodeId)
      const edges = graph.edges.filter((e) => e.source === nodeId || e.target === nodeId)
      graph.edges = graph.edges.filter((e) => e.source !== nodeId && e.target !== nodeId)
      return {
        op: op.op,
        nodeId,
        summary: `removed ${node.kind} "${node.label}" and ${edges.length} connected edge${edges.length === 1 ? '' : 's'}`,
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
  ]
}

export function workflowWriteTools(): WfMcpTool[] {
  return [
    {
      name: 'patch_workflow_draft',
      title: 'Patch workflow draft',
      description:
        'Apply a list of small, named changes to a workflow’s DRAFT — starting from the existing draft, or from the published graph if there is none. Ops: set_tool_arg (nodeId, arg, binding), remove_tool_arg (nodeId, arg), set_node_label (nodeId, label), merge_node_config (nodeId, config), add_edge (source, target, condition?), remove_edge (edgeId | source+target), remove_node (nodeId — its edges go too). Ops apply in order and all-or-nothing: one bad op writes nothing. The reply lints the result and names every node that now differs from the published version. Nothing runs the draft; publish_workflow makes it live. Read get_workflow first for node ids, and validate_workflow_graph or get_tool_catalog for what a tool’s args are called and typed.',
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
      description:
        'Replace a workflow’s unsaved DRAFT graph outright. For structural rewrites patch_workflow_draft cannot express; prefer patch_workflow_draft otherwise — this overwrites the whole graph, so any node, edge or field you omit is gone. Read get_workflow first and send the complete graph ({ version: 1, nodes, edges }) with your edits applied. The reply lints the result and names every node that now differs from the published version. Nothing runs the draft; publish_workflow makes it live.',
      inputSchema: {
        workflowId: z.string().describe('Workflow id, from list_workflows.'),
        graph: z
          .record(z.string(), z.unknown())
          .describe('The complete WorkflowGraph — the same object get_workflow returns under `draft.graph` / `currentVersion.graph`, edited. Not a patch.'),
      },
      readOnly: false,
      run: async (client, args) => {
        const workflowId = reqString(args.workflowId, 'workflowId')
        const shaped = workflowGraphShapeSchema.safeParse(args.graph)
        if (!shaped.success) {
          return {
            error: `\`graph\` is not a well-formed workflow graph, so nothing was written: ${shaped.error.issues
              .slice(0, 5)
              .map((i) => `${i.path.join('.')}: ${i.message}`)
              .join('; ')}`,
          }
        }
        const detail = await requireWorkflow(client, workflowId)
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

        const out = await client.saveVersion({ workflowId, graph, changeNote })
        return {
          ok: true,
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
  ]
}
