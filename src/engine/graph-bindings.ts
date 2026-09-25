import type {
  ArgBinding,
  RefBinding,
  WorkflowGraph,
  WorkflowNode,
} from './graph-schema'

// Every `ref` binding a node carries, in one place. Refs are scattered across
// per-kind config fields (`inputs`, `args`, `source`, `value`, `fields`, switch
// case values, an agent's `conversation`), and each consumer that needs "which
// nodes does this node READ" — the upstream-reachability lint, the
// scrub-on-delete in the editor — must not keep its own per-kind list that
// drifts the moment a kind grows a field. The `satisfies never` below makes a
// new kind a compile error here until it says what it binds.

export type NodeRef = {
  /** Where on the node the ref lives, for messages ("input 'clientMessage'"). */
  slot: string
  ref: RefBinding
}

function recordRefs(
  prefix: string,
  record: Record<string, ArgBinding> | undefined,
): NodeRef[] {
  if (!record) return []
  const out: NodeRef[] = []
  for (const [key, b] of Object.entries(record)) {
    if (b.kind === 'ref') out.push({ slot: `${prefix} '${key}'`, ref: b })
  }
  return out
}

function singleRef(slot: string, b: ArgBinding | undefined): NodeRef[] {
  return b?.kind === 'ref' ? [{ slot, ref: b }] : []
}

export function nodeRefs(node: WorkflowNode): NodeRef[] {
  switch (node.kind) {
    case 'agent':
      return [
        ...recordRefs('input', node.config.inputs),
        ...singleRef('conversation', node.config.conversation),
      ]
    case 'tool':
      return recordRefs('arg', node.config.args)
    case 'branch':
      return singleRef('source', node.config.source)
    case 'decision':
      return [
        ...singleRef('source', node.config.source),
        // A question whose choices come from upstream READS that node, as much
        // as the judged value does — so it counts for reachability and gets
        // scrubbed when its producer is deleted.
        ...node.config.questions.flatMap((q) =>
          singleRef(`question '${q.id}' choices`, q.choicesSource),
        ),
      ]
    case 'switch':
      return [
        ...singleRef('source', node.config.source),
        ...node.config.cases.flatMap((c) =>
          singleRef(`case '${c.label ?? c.key}'`, c.value),
        ),
      ]
    case 'workflow':
    case 'text':
      return recordRefs('input', node.config.inputs)
    case 'passthrough':
      return [
        ...singleRef('value', node.config.value),
        ...recordRefs('field', node.config.fields),
      ]
    case 'transform':
      return [
        ...singleRef('source', node.config.source),
        ...recordRefs('input', node.config.inputs),
      ]
    case 'output':
    case 'iteration':
      return singleRef('source', node.config.source)
    case 'trigger':
    case 'feature-request':
    case 'race':
    case 'aggregate':
    case 'note':
      return []
    default:
      node satisfies never
      return []
  }
}

// The same node with every ref into `removed` erased. A deleted node's readers
// would otherwise keep a binding to an id that no longer exists — invisible on
// the canvas, and a runtime failure ("reads X, but that node produced no
// output") the first time the graph runs. Erasing leaves the slot unbound, which
// the Issues panel reports as a missing input the author can re-link.
//
// Record bindings drop the key; optional single bindings drop the field; a
// switch case's value (required by the schema) falls back to an empty literal,
// which the "no value to match" lint then flags. Iteration descends into its
// subgraph so a reader nested in a loop is scrubbed too.
export function stripNodeRefsTo(
  node: WorkflowNode,
  removed: ReadonlySet<string>,
): WorkflowNode {
  const isGone = (b: ArgBinding | undefined) =>
    b?.kind === 'ref' && removed.has(b.nodeId)
  const keep = (b: ArgBinding | undefined) => (isGone(b) ? undefined : b)
  const keepRecord = <T extends Record<string, ArgBinding> | undefined>(
    record: T,
  ): T => {
    if (!record) return record
    const next: Record<string, ArgBinding> = {}
    for (const [k, b] of Object.entries(record)) if (!isGone(b)) next[k] = b
    return next as T
  }

  switch (node.kind) {
    case 'agent':
      return {
        ...node,
        config: {
          ...node.config,
          inputs: keepRecord(node.config.inputs),
          conversation: keep(node.config.conversation),
        },
      }
    case 'tool':
      return {
        ...node,
        config: { ...node.config, args: keepRecord(node.config.args) },
      }
    case 'branch':
      return {
        ...node,
        config: {
          ...node.config,
          source: isGone(node.config.source) ? undefined : node.config.source,
        },
      }
    // Kept its own case rather than sharing Branch's: two kinds in one case
    // widen `node.config` to a union, and the rebuilt object then satisfies
    // neither member.
    case 'decision':
      return {
        ...node,
        config: {
          ...node.config,
          source: isGone(node.config.source) ? undefined : node.config.source,
          questions: node.config.questions.map((q) =>
            isGone(q.choicesSource) ? { ...q, choicesSource: undefined } : q,
          ),
        },
      }
    case 'switch':
      return {
        ...node,
        config: {
          ...node.config,
          source: isGone(node.config.source) ? undefined : node.config.source,
          cases: node.config.cases.map((c) =>
            isGone(c.value)
              ? { ...c, value: { kind: 'literal', value: '' } }
              : c,
          ),
        },
      }
    case 'workflow':
      return {
        ...node,
        config: { ...node.config, inputs: keepRecord(node.config.inputs) },
      }
    case 'text':
      return {
        ...node,
        config: { ...node.config, inputs: keepRecord(node.config.inputs) },
      }
    case 'passthrough':
      return {
        ...node,
        config: {
          ...node.config,
          value: keep(node.config.value),
          fields: keepRecord(node.config.fields),
        },
      }
    case 'transform':
      return {
        ...node,
        config: {
          ...node.config,
          source: keep(node.config.source),
          inputs: keepRecord(node.config.inputs),
        },
      }
    case 'output':
      return {
        ...node,
        config: {
          ...node.config,
          source: isGone(node.config.source) ? undefined : node.config.source,
        },
      }
    case 'iteration':
      return {
        ...node,
        config: {
          ...node.config,
          source: isGone(node.config.source) ? undefined : node.config.source,
          subgraph: stripGraphRefsTo(node.config.subgraph, removed),
        },
      }
    case 'trigger':
    case 'feature-request':
    case 'race':
    case 'aggregate':
    case 'note':
      return node
    default:
      node satisfies never
      return node
  }
}

export function stripGraphRefsTo(
  graph: WorkflowGraph,
  removed: ReadonlySet<string>,
): WorkflowGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((n) => stripNodeRefsTo(n, removed)),
  }
}

/**
 * Every ref in the graph that reads `<nodeId>.<from>` repointed to
 * `<nodeId>.<to>` — how renaming the thing a node OUTPUTS stays safe.
 *
 * The case this exists for is a Decision question id. That id is the address
 * downstream nodes bind to (`answers.is_urgent.value`), so renaming it in the
 * node alone would leave every reader pointing at a path that no longer exists:
 * invisible on the canvas, and a "reads X, but that node produced no output"
 * failure the first time it runs. The rename is only a rename if the readers
 * come with it.
 *
 * A prefix match, not an equality one: a reader may address the renamed subtree
 * at any depth (`answers.x`, `answers.x.value`, `answers.x.confidence`), and all
 * of them move together. `answers.xy` does NOT move — the boundary is a dot.
 *
 * Implemented as a structural walk rather than the per-kind switch above,
 * because here the per-kind knowledge buys nothing: a ref is the only thing in
 * a config shaped `{ kind: 'ref', nodeId, path }`, so matching that shape
 * anywhere in the tree finds exactly the refs and nothing else. The walk
 * descends an iteration's `subgraph` for free, which the switch has to spell
 * out.
 */
export function renameGraphRefPaths(
  graph: WorkflowGraph,
  target: { nodeId: string; from: string; to: string },
): WorkflowGraph {
  if (target.from === target.to) return graph
  return { ...graph, nodes: graph.nodes.map((n) => rewrite(n, target)) }
}

type RenameTarget = { nodeId: string; from: string; to: string }

function rewrite<T>(value: T, target: RenameTarget): T {
  if (Array.isArray(value)) {
    return value.map((v: unknown) => rewrite(v, target)) as T
  }
  if (value === null || typeof value !== 'object') return value
  const obj = value as Record<string, unknown>
  if (obj.kind === 'ref' && obj.nodeId === target.nodeId && typeof obj.path === 'string') {
    const moved = movePath(obj.path, target.from, target.to)
    return (moved === obj.path ? obj : { ...obj, path: moved }) as T
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) out[k] = rewrite(v, target)
  return out as T
}

/** `answers.old.value` → `answers.new.value`; `answers.older` is left alone. */
function movePath(path: string, from: string, to: string): string {
  if (path === from) return to
  return path.startsWith(`${from}.`) ? `${to}${path.slice(from.length)}` : path
}
