import { z } from 'zod'

import { analyzeJoinTopology, bothArmsJoinDecision } from './graph-topology'
import { SWITCH_DEFAULT_CASE, workflowGraphShapeSchema } from './graph-schema'
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
