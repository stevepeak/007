import { buildIterationSubgraph } from './graph-builders'
import type { WfNodeKind } from './graph-kinds'
import { ITERATION_MAX_ITEMS_DEFAULT, type WorkflowNode } from './graph-schema'

// Default config for a freshly-added node, one entry per kind.
//
// This is the second half of the node-kind registry. It lives apart from
// `graph-kinds.ts` for one reason: seeding an iteration needs
// `buildIterationSubgraph`, which sits above `graph-schema`, and graph-schema
// imports graph-kinds — so putting this table there would close an import cycle.
// It is keyed `Record<WfNodeKind, …>` exactly like the descriptor table, so a
// new kind is a compile error here until it declares how it starts life.

/** Host-sourced defaults, so no provider or tool id is hardcoded in the SDK. */
export type NodeSeedDefaults = { toolId: string }

/**
 * A node as the editor holds it before placement: the engine node minus the
 * fields something else owns — `id`/`position` (the canvas) and `informUser`
 * (attached uniformly by `defaultDataForKind`, since every fresh node starts
 * silent). Distributive so each kind keeps its own config type rather than
 * collapsing to the union's common keys.
 */
export type WorkflowNodeSeed = WorkflowNode extends infer N
  ? N extends WorkflowNode
    ? Omit<N, 'id' | 'position' | 'informUser'>
    : never
  : never

/**
 * Returns the seed for one kind, typed to THAT kind — a wrong config shape is a
 * compile error at the entry, not a cast swallowed at the call site. `null` for
 * kinds the author can't add: `trigger` and `output` are template-owned bookends
 * seeded with the graph itself.
 */
type NodeKindSeed<K extends WfNodeKind> =
  | ((defaults: NodeSeedDefaults) => Extract<WorkflowNodeSeed, { kind: K }>)
  | null

export const NODE_KIND_SEEDS: { [K in WfNodeKind]: NodeKindSeed<K> } = {
  trigger: null,
  output: null,

  agent: () => ({
    // A pointer node — the inspector picks which pre-developed agent to run.
    kind: 'agent',
    label: 'New agent',
    config: { agentId: '', version: null, inputs: {} },
  }),

  tool: ({ toolId }) => ({
    kind: 'tool',
    label: 'New tool',
    config: { toolId, args: {} },
  }),

  branch: () => ({
    kind: 'branch',
    label: 'New branch',
    config: { operator: 'is_not_empty' },
  }),

  // Seeded with no cases — the author adds them in the inspector, which grows
  // one outgoing handle per case plus the always-present `default`. Until a
  // 'default' edge exists the graph flags a (non-blocking) issue.
  switch: () => ({
    kind: 'switch',
    label: 'New switch',
    config: { cases: [] },
  }),

  // Seeded with a minimal Item → Result subgraph; the author drops work nodes
  // into the block. `source` is intentionally left unset so the block reads as
  // "no list selected" (an error) until the author picks a list to iterate.
  iteration: () => ({
    kind: 'iteration',
    label: 'New iteration',
    config: {
      concurrency: 4,
      stopOnError: false,
      // The cheap, no-surprises default. The Issues panel nudges the author to
      // Durable once the subgraph grows past a step or two, which is the point
      // at which the choice actually starts to matter.
      itemExecution: 'inline',
      // Items are numbered until the author names them. Left empty rather than
      // seeded with a guess like `${title}`: a template pointing at a field the
      // list doesn't have resolves to nothing and falls back to numbering
      // anyway, so a guess would only ever be invisible or wrong.
      itemTitle: '',
      // Bounded from the first frame: an unset limit is an error in the Issues
      // panel, and a new node should never open already broken. The seed is the
      // inline ceiling, so the author's only reason to touch it is to go LOWER
      // (or to raise it after switching to Durable).
      maxItems: ITERATION_MAX_ITEMS_DEFAULT.inline,
      subgraph: buildIterationSubgraph(),
    },
  }),

  // A pointer node — the inspector picks which workflow to call. Left empty so
  // it reads as "no workflow selected" (an error) until the author picks one.
  // Nothing else to seed: the callee runs as its own child run, on the engine
  // its own trigger declares, so a caller has no execution knobs of its own.
  workflow: () => ({
    kind: 'workflow',
    label: 'Call workflow',
    config: { workflowId: '', inputs: {} },
  }),

  'feature-request': () => ({
    kind: 'feature-request',
    label: 'Feature request',
    config: { description: '' },
  }),

  // Starts as a pure identity (forwards its input). The author opens the
  // inspector to switch it to `value` (one binding, unwrapped) or `fields`
  // (build an object) — the shape a converging branch arm needs.
  passthrough: () => ({
    kind: 'passthrough',
    label: 'Passthrough',
    config: {},
  }),

  // Drops in empty, which reads as a blocking "no expression" issue until the
  // author writes one — deliberate, since an expressionless transform has no
  // behaviour at all and silently forwarding its input would be a different
  // node (that node is Passthrough).
  transform: () => ({
    kind: 'transform',
    label: 'Transform',
    config: { inputs: {}, expression: '' },
  }),

  // A config-less first-to-finish join. The author wires several upstreams into
  // it; the first to complete wins. It reads as a (non-blocking) "needs 2+
  // inputs" warning until at least two feed in.
  race: () => ({ kind: 'race', label: 'Race', config: {} }),

  // A config-less wait-for-all join. The author wires several upstreams into it;
  // once all complete it emits an ordered list (one element per producer) for a
  // downstream sibling to iterate. Reads as a (non-blocking) "needs 2+ inputs"
  // warning until at least two feed in.
  aggregate: () => ({ kind: 'aggregate', label: 'Aggregate', config: {} }),

  note: () => ({ kind: 'note', label: 'Note', config: { text: '' } }),
}
