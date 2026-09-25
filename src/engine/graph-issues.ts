import jsonata from 'jsonata'

import {
  ITERATION_MAX_ITEMS_CEILING,
  SWITCH_DEFAULT_CASE,
  switchArmName,
  type WorkflowGraph,
  type WorkflowNode,
} from './graph'
import { nodeRefs } from './graph-bindings'
import { graphShapeFacts, joinViolation, switchCoverage } from './graph-rules'
import { analyzeJoinTopology } from './graph-topology'
import { ancestorIds } from './graph-traverse'

// Author-time graph diagnostics. Where `workflowGraphSchema`'s superRefine is
// the strict *runtime* gate (a failing graph can't run), this collects the same
// problems — plus softer, per-node "not configured yet" issues — as a
// non-blocking list the editor can render in its "Issues" panel and use to
// highlight the offending nodes. It never throws: a work-in-progress graph is
// expected to have issues while it's being built.
//
// Intentionally mirrors (rather than imports) the superRefine's structural
// checks: the two answer different questions (reject-vs-run here, guide-the-
// author there) and diverge on severity — e.g. a dangling node is only a
// warning here but never rejects a runnable graph there.

export type GraphIssueSeverity = 'error' | 'warning'

export type GraphIssue = {
  /**
   * The node this issue attaches to, for canvas highlighting. Omitted for
   * graph-wide problems (e.g. "no trigger node").
   */
  nodeId?: string
  /** Human-readable node label at collection time, for display. */
  nodeLabel?: string
  message: string
  severity: GraphIssueSeverity
}

// Per-node "is this configured enough to run?" checks that need no external
// metadata (tool/agent catalogs). Binding-completeness lives in the UI layer,
// which has the catalogs to know a node's required inputs.
function configIssue(node: WorkflowNode): GraphIssue | null {
  const base = { nodeId: node.id, nodeLabel: node.label } as const
  switch (node.kind) {
    case 'agent':
      if (!node.config.agentId) {
        return { ...base, severity: 'error', message: 'No agent selected.' }
      }
      return null
    case 'branch': {
      const needsValue = !['is_empty', 'is_not_empty'].includes(
        node.config.operator,
      )
      if (needsValue && node.config.value === undefined) {
        return {
          ...base,
          severity: 'warning',
          message: `Branch "${node.config.operator}" has no value to compare against.`,
        }
      }
      return null
    }
    case 'decision': {
      // Ordered by what blocks the author first: a node with no decider can't
      // run at all, one with no question has nothing to ask, and a question with
      // no prompt is the half-finished state a fresh node lands in.
      if (!node.config.modelId) {
        return {
          ...base,
          severity: 'error',
          message: 'No decision model selected.',
        }
      }
      if (node.config.questions.length === 0) {
        return {
          ...base,
          severity: 'error',
          message: 'No questions — add at least one for this node to judge.',
        }
      }
      const unprompted = node.config.questions.filter((q) => !q.prompt.trim())
      if (unprompted.length > 0) {
        return {
          ...base,
          severity: 'error',
          message: `Question${unprompted.length > 1 ? 's' : ''} ${unprompted
            .map((q) => `"${q.id}"`)
            .join(', ')} ${unprompted.length > 1 ? 'have' : 'has'} no prompt.`,
        }
      }
      const thin = node.config.questions.filter(
        (q) => q.type !== 'boolean' && !q.choicesSource && q.choices.length < 2,
      )
      if (thin.length > 0) {
        return {
          ...base,
          severity: 'error',
          message: `Question${thin.length > 1 ? 's' : ''} ${thin
            .map((q) => `"${q.id}"`)
            .join(', ')} need${thin.length > 1 ? '' : 's'} at least two choices.`,
        }
      }
      if (node.config.source === undefined) {
        // Not an error: with a single upstream, judging the incoming value is
        // exactly right. It becomes a real hazard once a node has several
        // upstreams, which only the edge-aware pass below can see.
        return {
          ...base,
          severity: 'warning',
          message:
            'No value bound — this judges whatever arrives. Pick the upstream value to judge.',
        }
      }
      return null
    }
    case 'workflow':
      if (!node.config.workflowId) {
        return { ...base, severity: 'error', message: 'No workflow selected.' }
      }
      return null
    case 'feature-request':
      if (!node.config.description.trim()) {
        return {
          ...base,
          severity: 'warning',
          message:
            'Feature-request note is empty — this node just passes through.',
        }
      }
      return null
    case 'iteration':
      // A list must be chosen — a `ref` into an upstream node's array output.
      if (node.config.source === undefined) {
        return {
          ...base,
          severity: 'error',
          message: 'No list selected — pick the list to iterate over.',
        }
      }
      // Only the item-trigger + output bookends → the loop does no work.
      if (node.config.subgraph.nodes.length <= 2) {
        return {
          ...base,
          severity: 'warning',
          message:
            'Iteration subgraph is empty — add nodes between Item and Output.',
        }
      }
      return null
    case 'output':
      // The value the caller receives must be named explicitly — a `ref` into an
      // upstream node's output. Unbound is a hard error: the run would have no
      // result to return (mirrors iteration's "no list selected"). The incoming
      // edge only decides WHEN this Output fires, not WHAT it returns.
      if (node.config.source === undefined) {
        return {
          ...base,
          severity: 'error',
          message:
            'No value bound — pick the upstream result the caller should receive.',
        }
      }
      return null
    case 'text':
      // The body IS the node's behaviour — without one there is nothing to emit,
      // so this is an error rather than a warning (same call as Transform's
      // missing expression). Whether every `${token}` in the body is BOUND is
      // checked in the UI layer alongside the other binding-completeness rules.
      if (!node.config.body.trim()) {
        return {
          ...base,
          severity: 'error',
          message: 'No text yet — write the text this step should produce.',
        }
      }
      return null
    case 'transform': {
      // An expression is the node's entire behaviour — without one there is
      // nothing to run, so this is an error rather than a warning.
      if (!node.config.expression.trim()) {
        return {
          ...base,
          severity: 'error',
          message: 'No expression — write one for the shape this should emit.',
        }
      }
      // Compile it. JSONata's parser is the cheapest real check available and it
      // runs everywhere this module does, which turns a typo from a mid-run
      // failure (after a retry schedule, on the durable backend) into a red mark
      // on the canvas before the graph is ever published.
      const parseError = jsonataParseError(node.config.expression)
      if (parseError) {
        return {
          ...base,
          severity: 'error',
          message: `Invalid JSONata expression: ${parseError}`,
        }
      }
      return null
    }
    default:
      return null
  }
}

/**
 * Compiles an expression purely to learn whether it parses, returning the
 * complaint or `null`. JSONata throws a plain object (`{code, position, token,
 * message}`) rather than an Error, so the message has to be dug out by hand.
 */
function jsonataParseError(expression: string): string | null {
  try {
    jsonata(expression)
    return null
  } catch (err) {
    if (err instanceof Error) return err.message
    if (err && typeof err === 'object') {
      const e = err as { code?: string; message?: string; position?: number }
      const detail = e.message ?? e.code ?? 'could not be parsed'
      return typeof e.position === 'number'
        ? `${detail} (at position ${e.position})`
        : detail
    }
    return String(err)
  }
}

/**
 * Above this many real work nodes, an item is "a pipeline" rather than "a step",
 * and replaying the whole thing on any inner failure starts to hurt. Deliberately
 * low: the point is to prompt a decision, not to police one.
 */
const HEAVY_SUBGRAPH_NODE_COUNT = 3

// Does one item do enough work that per-node durability is worth an instance
// start? An agent (or a nested workflow call) alone qualifies — it's the
// expensive, retry-prone, minutes-long kind of node whose replay an author most
// wants to avoid paying for twice.
function subgraphWeight(node: Extract<WorkflowNode, { kind: 'iteration' }>): {
  workNodes: number
  hasExpensiveNode: boolean
} {
  const work = node.config.subgraph.nodes.filter(
    (n) => n.kind !== 'trigger' && n.kind !== 'output' && n.kind !== 'note',
  )
  return {
    workNodes: work.length,
    hasExpensiveNode: work.some(
      (n) => n.kind === 'agent' || n.kind === 'workflow',
    ),
  }
}

/**
 * Flag an iteration whose SHAPE disagrees with its `itemExecution` choice.
 *
 * Both directions are only ever warnings: either setting runs correctly, and
 * which one is right depends on list length — which isn't knowable at author
 * time. This is the editor telling the author what it can see (how much work one
 * item does) so they can weigh it against what only they know (how many items
 * there usually are).
 */
function iterationExecutionIssue(node: WorkflowNode): GraphIssue | null {
  if (node.kind !== 'iteration') {
    return null
  }
  const base = { nodeId: node.id, nodeLabel: node.label } as const
  const { workNodes, hasExpensiveNode } = subgraphWeight(node)
  const heavy = hasExpensiveNode || workNodes > HEAVY_SUBGRAPH_NODE_COUNT

  if (node.config.itemExecution === 'inline' && heavy) {
    const why = hasExpensiveNode ? 'runs an agent' : `has ${workNodes} steps`
    return {
      ...base,
      severity: 'warning',
      message: `Each item ${why} but runs as one all-or-nothing unit — if it fails partway the whole item repeats from the start, and the inner steps' own timeout and retry settings are ignored. Consider switching item execution to Durable.`,
    }
  }

  if (node.config.itemExecution === 'durable' && !heavy) {
    return {
      ...base,
      severity: 'warning',
      message:
        'Each item starts its own run, which for a subgraph this small usually costs more than the durability is worth — especially over a long list. Inline is normally the better fit here.',
    }
  }

  return null
}

/**
 * Flag an iteration that has no upper bound on how wide it may fan out, or one
 * whose bound is wider than its execution mode can carry.
 *
 * Errors, not warnings — the two other iteration checks are judgement calls the
 * author is better placed to make, but "how many items is too many" is a
 * property of the RUNTIME, not of the workflow: an inline fan-out shares one
 * instance's subrequest and CPU budget no matter what the list means. An unbound
 * loop is a run that gets expensive, or wedged, before anyone can see it is
 * wrong — and the list length is data, so no amount of care at authoring time
 * rules it out.
 *
 * The bound the author declares is the one the run-time fence enforces; the
 * ceiling here only governs what may be declared, so this is the only place a
 * too-wide bound is ever mentioned. See `ITERATION_MAX_ITEMS_CEILING`.
 */
function iterationMaxItemsIssue(node: WorkflowNode): GraphIssue | null {
  if (node.kind !== 'iteration') {
    return null
  }
  const base = { nodeId: node.id, nodeLabel: node.label } as const
  const mode = node.config.itemExecution
  const ceiling = ITERATION_MAX_ITEMS_CEILING[mode]
  const { maxItems } = node.config

  if (maxItems === undefined) {
    return {
      ...base,
      severity: 'error',
      message: `No item limit set — cap how many items this loop may run (up to ${ceiling} on ${mode} item execution). Without one, an unexpectedly long list fans out until the run runs out of budget.`,
    }
  }
  if (maxItems > ceiling) {
    const other = mode === 'inline' ? 'Durable' : 'Inline'
    return {
      ...base,
      severity: 'error',
      message: `Item limit ${maxItems} is above the ${ceiling}-item maximum for ${mode} item execution — lower it${mode === 'inline' ? `, or switch to ${other} to raise the ceiling` : ''}.`,
    }
  }
  return null
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

// Collect every author-time issue for a graph. Pure and metadata-free — the UI
// appends binding-completeness issues (missing required inputs) on top.
export function collectGraphIssues(graph: WorkflowGraph): GraphIssue[] {
  const issues: GraphIssue[] = []
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))

  // Shared join/cone analysis (adjacency, decision sources, sealed cones) — the
  // same reasoning the strict schema uses, so author-time flags match runtime
  // rejects. See graph-topology.ts.
  const topo = analyzeJoinTopology(graph)
  const { incoming, outgoing } = topo

  // ── Graph-wide shape ──────────────────────────────────────────────────────
  const shape = graphShapeFacts(graph)
  if (shape.triggerCount === 0) {
    issues.push({ severity: 'error', message: 'Graph has no trigger node.' })
  } else if (shape.triggerCount > 1) {
    issues.push({
      severity: 'error',
      message: `Graph has ${shape.triggerCount} trigger nodes; exactly one is allowed.`,
    })
  }
  if (!shape.hasOutput) {
    issues.push({ severity: 'error', message: 'Graph has no output node.' })
  }
  for (const e of shape.danglingEdges) {
    issues.push({
      severity: 'error',
      message: `Connection references a missing node (${e.source} → ${e.target}).`,
    })
  }

  // ── Per-node ──────────────────────────────────────────────────────────────
  for (const node of graph.nodes) {
    const base = { nodeId: node.id, nodeLabel: node.label } as const
    const inc = incoming.get(node.id) ?? []
    const out = outgoing.get(node.id) ?? []

    // Config completeness.
    const cfg = configIssue(node)
    if (cfg) issues.push(cfg)

    // Execution-shape advice (iteration item durability). Separate from
    // `configIssue`, which answers "is this configured enough to run?" — this one
    // answers "will this run the way you want when something fails?", and both
    // can legitimately fire on the same node.
    const exec = iterationExecutionIssue(node)
    if (exec) issues.push(exec)

    // Fan-out width. Separate again from the two above: they weigh HOW an item
    // runs, this one caps HOW MANY may run at all — and unlike them it's an
    // error, because the answer isn't a judgement call (see below).
    const bound = iterationMaxItemsIssue(node)
    if (bound) issues.push(bound)

    // Connectivity. A Note is a portless canvas annotation — it is meant to be
    // unconnected, so it's exempt from both connectivity checks.
    if (node.kind !== 'trigger' && node.kind !== 'note' && inc.length === 0) {
      issues.push({
        ...base,
        severity: 'error',
        message: 'Not connected — nothing feeds into this node.',
      })
    }
    if (node.kind !== 'output' && node.kind !== 'note' && out.length === 0) {
      issues.push({
        ...base,
        severity: 'warning',
        message: 'Nothing downstream — this node’s result is never used.',
      })
    }

    // Data links vs. connections. A ref names WHICH node's output to read; the
    // edges decide WHEN this node fires. Both have to agree: a ref into a node
    // with no path to this one reads a value that may not exist yet — the run
    // fails with "produced no output" the moment the node fires first. A ref
    // into a node that is gone altogether can never resolve. (An unconnected
    // node is already an error above, so its refs get no second flag.)
    const ancestors = new Set(ancestorIds(graph, node.id))
    for (const { slot, ref } of nodeRefs(node)) {
      const target = byId.get(ref.nodeId)
      if (!target) {
        issues.push({
          ...base,
          severity: 'error',
          message: `${capitalize(slot)} reads a node that no longer exists — link it to another node's output.`,
        })
      } else if (inc.length > 0 && !ancestors.has(ref.nodeId)) {
        issues.push({
          ...base,
          severity: 'warning',
          message: `${capitalize(slot)} reads "${target.label}", but nothing connects that node to this one — it may not have run when this node fires. Connect it upstream, or link a node that is.`,
        })
      }
    }

    // A Race joins many upstreams and fires on the first to finish. With only
    // one input it can't race anything — it degenerates to a plain pass-through.
    if (node.kind === 'race' && inc.length === 1) {
      issues.push({
        ...base,
        severity: 'warning',
        message:
          'A race needs 2+ inputs to have anything to race — with one it just passes through.',
      })
    }

    // An Aggregate collects many upstreams into a list. With a single input it
    // just wraps that one value in a one-element list — usually not intended.
    if (node.kind === 'aggregate' && inc.length === 1) {
      issues.push({
        ...base,
        severity: 'warning',
        message:
          'An aggregate needs 2+ inputs to collect — with one it just wraps it in a single-item list.',
      })
    }

    // A branch may connect just one arm — the other is allowed to "fizzle out"
    // (that path simply ends). So a missing yes/no edge is not flagged; the
    // generic "nothing downstream" warning above still covers a routing node
    // with no outgoing edges at all.

    // A Decision does not route: it answers, and a Branch or Switch downstream
    // routes on the answer. A conditioned edge out of one names an arm the node
    // will never emit, so the scheduler leaves it dead and everything below it
    // silently never runs. An ERROR, because `workflowGraphSchema` rejects it
    // and the run dies before the first node.
    if (node.kind === 'decision') {
      const stray = out.filter((e) => e.condition != null)
      if (stray.length > 0) {
        issues.push({
          ...base,
          severity: 'error',
          message: `Outgoing edge${stray.length > 1 ? 's' : ''} ${stray
            .map((e) => `"${e.condition}"`)
            .join(', ')} name${stray.length > 1 ? '' : 's'} an arm, but a Decision never routes. Remove the condition, and route with a Branch or Switch reading "answers.<questionId>.value".`,
        })
      }
    }

    // A Branch's outgoing edges carry its yes/no, and an unconditioned one is
    // the mirror-image mistake: `scheduler.ts` treats
    // a null condition as always-live, so before the matching rule landed in
    // `graph-validation.ts` the edge fired on BOTH results with no error at all
    // — the branch just quietly stopped branching.
    if (node.kind === 'branch') {
      const stray = out.filter(
        (e) => e.condition !== 'yes' && e.condition !== 'no',
      )
      if (stray.length > 0) {
        issues.push({
          ...base,
          severity: 'error',
          message: `Outgoing edge${stray.length > 1 ? 's' : ''} ${stray
            .map((e) => (e.condition == null ? 'with no arm' : `"${e.condition}"`))
            .join(', ')} match${stray.length > 1 ? '' : 'es'} no branch arm (yes, no). An unconditioned edge is always live, so it fires whichever way the branch decides.`,
        })
      }
    }

    // A switch needs an outgoing edge per case. The 'else' fallback is
    // optional — without it an unmatched input just fizzles out, the same as
    // an unconnected branch arm — so it's only a warning.
    if (node.kind === 'switch') {
      const { missingCases, hasDefault } = switchCoverage(node, out)
      if (missingCases.length > 0) {
        const many = missingCases.length > 1
        issues.push({
          ...base,
          severity: 'error',
          message: `Switch case${many ? 's' : ''} ${missingCases
            .map((k) => `"${k}"`)
            .join(', ')} ${many ? 'have' : 'has'} no outgoing edge.`,
        })
      }
      if (!hasDefault) {
        issues.push({
          ...base,
          severity: 'warning',
          message: `Switch has no "${SWITCH_DEFAULT_CASE}" (fallback) path — an unmatched input stops here.`,
        })
      }
      // A case the author added but never filled in. It isn't inert — an empty
      // literal MATCHES an empty input, so the arm can fire for a reason nobody
      // intended, which reads as a routing bug rather than an unfinished case.
      const blank = node.config.cases.filter((c) => {
        return (
          c.value.kind === 'literal' &&
          (c.value.value == null || c.value.value === '')
        )
      })
      if (blank.length > 0) {
        const many = blank.length > 1
        issues.push({
          ...base,
          severity: 'error',
          message: `Switch case${many ? 's' : ''} ${blank
            .map((c) => `"${switchArmName(node.config.cases, c.key)}"`)
            .join(
              ', ',
            )} ${many ? 'have' : 'has'} no value to match — type the value, or link the upstream data it should equal.`,
        })
      }
    }

    // Join legality (shares the fact-producer with the strict schema, formats a
    // softer message here). A Race accepts any fan-in; an Output must not merge
    // parallel paths; a work node must not join both arms of one decision.
    const join = joinViolation(node, topo, graph.edges)
    if (join?.kind === 'parallel-output-merge') {
      issues.push({
        ...base,
        severity: 'error',
        message:
          'Merges parallel paths — only mutually-exclusive branch arms may share one Output. Give each path its own Output.',
      })
    } else if (join?.kind === 'both-arms-join') {
      const branch = byId.get(join.decisionId)
      issues.push({
        ...base,
        severity: 'error',
        message: `Joins both arms of branch "${branch?.label ?? join.decisionId}" — those paths never run together, so this node would stall. Route each arm to its own Output.`,
      })
    }
  }

  // Descend into iteration containers: their subgraph is a real mini-graph
  // (Item trigger → work → Result output) whose nodes are flattened onto the
  // same canvas, so their issues must surface too. Without this, a misconfigured
  // or unconnected node inside a loop is silently un-flagged. Nested iteration
  // is disallowed by the schema, so this recursion is one level deep.
  for (const node of graph.nodes) {
    if (node.kind === 'iteration') {
      issues.push(...collectGraphIssues(node.config.subgraph))
      // A step inside a loop cannot reach the user: the feed is one flat list,
      // with nowhere to put the same line thirty times over. The editor
      // disables the control, so this can only come from a graph published
      // before it did — and a note that silently says nothing is worse than one
      // that is flagged. The loop's own note is where the narration belongs.
      for (const child of node.config.subgraph.nodes) {
        if (child.informUser.mode === 'off') continue
        issues.push({
          nodeId: child.id,
          nodeLabel: child.label,
          severity: 'warning',
          message: `"Inform user" is set on a step inside iteration "${node.label}", where nothing it reports reaches the user. Set the note on the iteration step itself instead.`,
        })
      }
    }
  }

  return issues
}
