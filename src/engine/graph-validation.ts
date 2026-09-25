import type { z } from 'zod'

import { graphShapeFacts, joinViolation, switchCoverage } from './graph-rules'
import {
  BRANCH_ARMS,
  SWITCH_DEFAULT_CASE,
  workflowGraphShapeSchema,
} from './graph-schema'
import { analyzeJoinTopology } from './graph-topology'
import { ITERATION_ITEM_TRIGGER_KIND } from './trigger-registry'

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
  const facts = graphShapeFacts(g)
  if (facts.triggerCount !== 1) {
    ctx.addIssue({
      code: 'custom',
      message: `Graph must have exactly one trigger node (found ${facts.triggerCount}).`,
    })
  }
  if (!facts.hasOutput) {
    ctx.addIssue({
      code: 'custom',
      message: 'Graph must have at least one output node.',
    })
  }
  if (facts.hasDuplicateIds) {
    ctx.addIssue({ code: 'custom', message: 'Node ids must be unique.' })
  }
  for (const e of facts.danglingEdges) {
    ctx.addIssue({
      code: 'custom',
      message: `Edge ${e.id} references missing node (${e.source} → ${e.target}).`,
    })
  }
  for (const id of facts.outputIdsMissingIncoming) {
    ctx.addIssue({
      code: 'custom',
      message: `Output node ${id} has no incoming edges.`,
    })
  }
}

// Ref bindings must point at real nodes. Tool `args`, Workflow/Transform/Text
// `inputs`, and the Branch/Output/Transform `source` all share the ArgBinding
// shape. A binary decision
// (branch) may still leave one arm unconnected — it "fizzles out" at run time —
// so a missing yes/no edge is deliberately not flagged here. (An Output with no
// `source` at all is a distinct, softer author-time concern handled elsewhere.)
function checkRefBindings(g: GraphShape, ctx: GraphCheckCtx): void {
  const ids = new Set(g.nodes.map((n) => n.id))
  for (const n of g.nodes) {
    const bindings =
      n.kind === 'tool'
        ? n.config.args
        : n.kind === 'workflow'
          ? n.config.inputs
          : n.kind === 'transform' || n.kind === 'text'
            ? n.config.inputs
            : null
    if (bindings) {
      const label = n.kind === 'tool' ? 'arg' : 'input'
      const kindLabel =
        n.kind === 'tool'
          ? 'Tool'
          : n.kind === 'workflow'
            ? 'Workflow'
            : n.kind === 'text'
              ? 'Text'
              : 'Transform'
      for (const [argName, binding] of Object.entries(bindings)) {
        if (binding.kind === 'ref' && !ids.has(binding.nodeId)) {
          ctx.addIssue({
            code: 'custom',
            message: `${kindLabel} node ${n.id} ${label} '${argName}' references missing node ${binding.nodeId}.`,
          })
        }
      }
    }
    if (n.kind === 'branch' || n.kind === 'output' || n.kind === 'transform') {
      const src = n.config.source
      if (src && src.kind === 'ref' && !ids.has(src.nodeId)) {
        const label =
          n.kind === 'branch'
            ? 'Branch'
            : n.kind === 'output'
              ? 'Output'
              : 'Transform'
        ctx.addIssue({
          code: 'custom',
          message: `${label} node ${n.id} source references missing node ${src.nodeId}.`,
        })
      }
    }
  }
}

// Switch nodes: unique, non-reserved case keys; an outgoing edge per case; and
// no outgoing edge whose condition matches neither a declared case nor 'else'.
// A missing 'else' arm is NOT rejected here — like an unconnected branch arm,
// an unmatched input simply fizzles out at run time. It stays an author-time
// warning in graph-issues.ts.
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
    const { missingCases } = switchCoverage(n, outs)
    for (const k of new Set(missingCases)) {
      ctx.addIssue({
        code: 'custom',
        message: `Switch node ${n.id} case '${k}' has no outgoing edge.`,
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

// Branch nodes: every outgoing edge names 'yes' or 'no'. An UNCONDITIONED edge
// out of a Branch is the shape this rule exists for — the Scheduler treats a
// null condition as always-live (see `isEdgeLive`), so such an edge fires on
// both results and the Branch silently routes nothing. That reads on the canvas
// exactly like a default arm and behaves nothing like one, and because a Branch
// never rejects the way Switch does, it used to fail as a wrong
// answer rather than an error. A CONNECTED-BUT-MISSING arm stays legal: like
// Switch's absent 'else', an unconnected arm simply fizzles out.
function checkBranchNodes(g: GraphShape, ctx: GraphCheckCtx): void {
  const arms = new Set<string>(BRANCH_ARMS)
  for (const n of g.nodes) {
    if (n.kind !== 'branch') continue
    const outs = g.edges.filter((e) => e.source === n.id)
    for (const e of outs) {
      if (e.condition == null || !arms.has(e.condition)) {
        ctx.addIssue({
          code: 'custom',
          message: `Branch node ${n.id} edge ${e.id} condition '${e.condition ?? 'null'}' matches no arm (${[...arms].join(', ')}) — an unconditioned edge out of a branch is always live, so it fires on both results.`,
        })
      }
    }
  }
}

/**
 * Decision nodes: questions are well-formed, and no outgoing edge is
 * conditioned.
 *
 * The edge check is the one that matters. A Decision does not route — it
 * answers, and a Branch or Switch downstream routes on the answer. So a
 * conditioned edge out of one is an author expecting an arm that will never be
 * emitted: the scheduler only keeps a conditioned edge alive when its source
 * reported a matching result (see `isEdgeLive`), and this node reports none. The
 * edge would match nothing, the path below it would never run, and the run would
 * drain without reaching an Output. Catching it here turns a silent stall into a
 * rejected graph.
 */
function checkDecisionNodes(g: GraphShape, ctx: GraphCheckCtx): void {
  for (const n of g.nodes) {
    if (n.kind !== 'decision') continue

    const ids = n.config.questions.map((q) => q.id)
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: 'custom',
        message: `Decision node ${n.id} has duplicate question ids.`,
      })
    }
    for (const q of n.config.questions) {
      if (q.type === 'boolean') continue
      // Choices coming from upstream are unknowable here — `decision.ts` counts
      // what actually arrives. Rejecting the graph for an empty authored list
      // would reject exactly the shape the binding exists for.
      if (q.choicesSource) continue
      const keys = q.choices.map((c) => c.key)
      if (keys.length < 2) {
        ctx.addIssue({
          code: 'custom',
          message: `Decision node ${n.id} question '${q.id}' is a ${q.type} question with ${keys.length} choice(s); it needs at least two.`,
        })
      }
      if (new Set(keys).size !== keys.length) {
        ctx.addIssue({
          code: 'custom',
          message: `Decision node ${n.id} question '${q.id}' has duplicate choice keys.`,
        })
      }
    }

    for (const e of g.edges) {
      if (e.source !== n.id || e.condition == null) continue
      ctx.addIssue({
        code: 'custom',
        message: `Decision node ${n.id} edge ${e.id} has condition '${e.condition}', but a Decision never routes — it answers. Remove the condition, and route with a Branch or Switch reading \`answers.<questionId>.value\`.`,
      })
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
    const v = joinViolation(n, topo, g.edges)
    if (v?.kind === 'parallel-output-merge') {
      // Only mutually-exclusive branch arms may converge on one Output; two or
      // more always-live (unconditional) incoming edges are parallel paths, one
      // of which would be silently dropped.
      ctx.addIssue({
        code: 'custom',
        message: `Output node ${n.id} merges ${v.count} parallel paths; only mutually-exclusive branch arms may converge on one Output. Give each parallel path its own Output node.`,
      })
    } else if (v?.kind === 'both-arms-join') {
      // A work node fires only when ALL its incoming edges are alive; it stalls
      // when a single branch feeds BOTH its arms into this node (mutually
      // exclusive, so one arm's edge stays dead forever).
      ctx.addIssue({
        code: 'custom',
        message: `Node ${n.id} joins both arms of branch ${v.decisionId}; those paths are mutually exclusive and can never all complete, so the join would stall. Route each arm to its own Output, or converge only paths on the same branch arm.`,
      })
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
    checkBranchNodes(g, ctx)
    checkDecisionNodes(g, ctx)
    checkIterationSubgraphs(g, ctx)
    checkJoinTopology(g, ctx)
  },
)
