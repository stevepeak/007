// Canonical node-kind registry and the classifiers that ride on it. Kept free of
// the zod schemas — and of every other engine module — so both the schema layer
// and the scheduler/topology can depend on it without pulling in the whole graph
// module, and so the UI can read node metadata without importing the executor.
//
// THIS IS THE SINGLE SOURCE OF TRUTH FOR WHAT A NODE KIND IS. `WfNodeKind` is
// derived from the registry's keys rather than the other way round, so adding a
// kind is one object entry and every consumer that must react to it fails to
// compile until it does.
//
// The one thing deliberately NOT here is a new node's default config: seeding an
// iteration needs `buildIterationSubgraph`, which sits above `graph-schema`, and
// importing it here would close the cycle graph-kinds → graph-builders →
// graph-schema → graph-kinds. That table lives in `node-kind-seeds.ts` and is
// keyed `Record<WfNodeKind, …>`, so it is exhaustive in exactly the same way.

/** Palette grouping. Steps do work, Logic routes, Other never executes. */
export type NodeKindCategory = 'Steps' | 'Logic' | 'Other'

/**
 * Icon NAMES, not components. The engine depends only on `ai` + `zod` — that is
 * what makes it publishable — so it must never import `lucide-react`. The UI
 * resolves these to components in `node-kind-icons.ts`, where a name with no
 * mapping is a compile error.
 */
export type NodeKindIconName =
  | 'Flag'
  | 'Forward'
  | 'GitBranch'
  | 'Layers'
  | 'Lightbulb'
  | 'Play'
  | 'Repeat'
  | 'Shuffle'
  | 'Sparkles'
  | 'Split'
  | 'StickyNote'
  | 'Target'
  | 'Type'
  | 'Workflow'
  | 'Wrench'

/** How a kind presents itself in the "Add a node" palette. */
export type NodeKindPalette = {
  category: NodeKindCategory
  description: string
}

export type NodeKindDescriptor = {
  /** Human-facing name — Sentry span titles, palette entries, inspector headers. */
  label: string
  icon: NodeKindIconName
  /**
   * Long (LLM-ish) vs. default deterministic timeout. `agent` waits on a
   * provider; `workflow` and `iteration` are CONTAINERS that run a whole
   * subgraph — usually several LLM nodes — as one unit of execution, so they
   * need the same budget. See `node-timeout.ts` for why omitting a container
   * here is a broken budget rather than a smaller one.
   */
  timeout: 'ai' | 'default'
  /**
   * Engine-managed bookend — never an executable instruction. Trigger and Output
   * are seeded/terminated by the driver loop; a portless Note has no incoming
   * edges, so it never becomes ready.
   */
  bookend: boolean
  /**
   * Routes via a conditional outgoing edge (`edge.condition` selects the live
   * arm). The binary `branch` (predicate) emits 'yes'/'no'; the multi-way
   * `switch` emits a case key or 'else'. The scheduler and cone/join validation
   * treat both uniformly for routing.
   */
  decision: boolean
  /** Palette entry, or null for kinds the author cannot drag in. */
  palette: NodeKindPalette | null
}

// Insertion order is meaningful twice over: it fixes `WF_NODE_KINDS`, and within
// a category it fixes the palette's top-to-bottom order.
const NODE_KINDS = {
  trigger: {
    label: 'Trigger',
    icon: 'Play',
    timeout: 'default',
    bookend: true,
    decision: false,
    // Template-owned: every graph has exactly one, seeded at creation.
    palette: null,
  },
  agent: {
    label: 'Agent',
    icon: 'Sparkles',
    timeout: 'ai',
    bookend: false,
    decision: false,
    palette: { category: 'Steps', description: 'Run an agent.' },
  },
  tool: {
    label: 'Tool',
    icon: 'Wrench',
    timeout: 'default',
    bookend: false,
    decision: false,
    palette: {
      category: 'Steps',
      description: 'Direct call to a registered tool — no LLM in the loop.',
    },
  },
  text: {
    label: 'Text',
    icon: 'Type',
    timeout: 'default',
    bookend: false,
    decision: false,
    palette: {
      category: 'Steps',
      description:
        'Write a block of text, filling in ${values} from earlier steps.',
    },
  },
  branch: {
    label: 'Branch',
    icon: 'GitBranch',
    timeout: 'default',
    bookend: false,
    decision: true,
    palette: {
      category: 'Logic',
      description: 'Yes / no routing from a deterministic condition — no LLM.',
    },
  },
  switch: {
    label: 'Switch',
    icon: 'Split',
    timeout: 'default',
    bookend: false,
    decision: true,
    palette: {
      category: 'Logic',
      description: 'Multi-way routing — match a value to one of many cases.',
    },
  },
  workflow: {
    label: 'Workflow',
    icon: 'Workflow',
    timeout: 'ai',
    bookend: false,
    decision: false,
    palette: {
      category: 'Steps',
      description: 'Call another workflow and wait for its result.',
    },
  },
  'feature-request': {
    label: 'Feature Request',
    icon: 'Lightbulb',
    timeout: 'default',
    bookend: false,
    decision: false,
    palette: {
      category: 'Other',
      description: 'Placeholder for a future idea — passes through unchanged.',
    },
  },
  passthrough: {
    label: 'Passthrough',
    icon: 'Forward',
    timeout: 'default',
    bookend: false,
    decision: false,
    palette: {
      category: 'Logic',
      description:
        'Re-shape a value so a branch arm can feed a Race the same shape as its sibling.',
    },
  },
  transform: {
    label: 'Transform',
    icon: 'Shuffle',
    timeout: 'default',
    bookend: false,
    decision: false,
    palette: {
      category: 'Logic',
      description:
        'Reshape a value with a JSONata expression — e.g. turn records into the messages an agent expects.',
    },
  },
  race: {
    label: 'Race',
    icon: 'Flag',
    timeout: 'default',
    bookend: false,
    decision: false,
    palette: {
      category: 'Logic',
      description:
        'First-to-finish join — fires as soon as any upstream completes.',
    },
  },
  aggregate: {
    label: 'Aggregate',
    icon: 'Layers',
    timeout: 'default',
    bookend: false,
    decision: false,
    palette: {
      category: 'Logic',
      description:
        'Wait-for-all join — collects every upstream result into one list.',
    },
  },
  iteration: {
    label: 'Iteration',
    icon: 'Repeat',
    timeout: 'ai',
    bookend: false,
    decision: false,
    palette: {
      category: 'Logic',
      description: 'Run a subgraph once per item in a list, in parallel.',
    },
  },
  note: {
    label: 'Note',
    icon: 'StickyNote',
    timeout: 'default',
    bookend: true,
    decision: false,
    palette: {
      category: 'Other',
      description: 'A sticky note with Markdown — never affects the workflow.',
    },
  },
  output: {
    label: 'Output',
    icon: 'Target',
    timeout: 'default',
    bookend: true,
    decision: false,
    // Template-owned, like `trigger`.
    palette: null,
  },
} as const satisfies Record<string, NodeKindDescriptor>

/** Canonical node-kind list — owned by the SDK (no external @app/types dep). */
export type WfNodeKind = keyof typeof NODE_KINDS

export const NODE_KIND_REGISTRY: Record<WfNodeKind, NodeKindDescriptor> =
  NODE_KINDS

export const WF_NODE_KINDS = Object.keys(NODE_KINDS) as [
  WfNodeKind,
  ...WfNodeKind[],
]

/** Section order in the palette. */
export const NODE_KIND_CATEGORY_ORDER: readonly NodeKindCategory[] = [
  'Steps',
  'Logic',
  'Other',
]

/** True for a kind the SDK knows about — narrows an unvalidated string. */
export function isWfNodeKind(kind: string): kind is WfNodeKind {
  return Object.hasOwn(NODE_KINDS, kind)
}

/** Descriptor for a kind, or undefined when the string isn't a known kind. */
export function nodeKindDescriptor(
  kind: string,
): NodeKindDescriptor | undefined {
  return isWfNodeKind(kind) ? NODE_KIND_REGISTRY[kind] : undefined
}

/** Human-facing label; falls back to the raw string for an unknown kind. */
export function nodeKindLabel(kind: string): string {
  return nodeKindDescriptor(kind)?.label ?? kind
}

// Shapes a Transform node can assert its result against. A transform's output
// is an expression's return value, so nothing upstream of the run knows what it
// will be — declaring a shape is how an author buys back a real error message
// and a real output type for the downstream binding picker. The zod schemas
// these name live in nodes/transform.ts; this list is here so the graph schema
// can reference it without importing the engine's node layer.
export const TRANSFORM_OUTPUT_SHAPES = ['conversation'] as const
export type TransformOutputShape = (typeof TRANSFORM_OUTPUT_SHAPES)[number]

/** Kinds that route via a conditional outgoing edge — derived, never hand-listed. */
export const DECISION_NODE_KINDS = WF_NODE_KINDS.filter(
  (kind) => NODE_KIND_REGISTRY[kind].decision,
)
export function isDecisionKind(kind: string): boolean {
  return nodeKindDescriptor(kind)?.decision ?? false
}

/** Engine-managed bookend kinds — derived, never hand-listed. */
export const BOOKEND_NODE_KINDS = WF_NODE_KINDS.filter(
  (kind) => NODE_KIND_REGISTRY[kind].bookend,
)
// Derived from the `bookend` column rather than hand-listed, so flipping the
// flag on a kind moves it between the executable and bookend sets everywhere at
// once — including the `ExecutableNode` narrowing in scheduler.ts.
export type BookendNodeKind = {
  [K in WfNodeKind]: (typeof NODE_KINDS)[K]['bookend'] extends true ? K : never
}[WfNodeKind]
// Node-level guard (not just the kind string) so it narrows a WorkflowNode: the
// false branch excludes the bookend members, yielding the executable set.
export function isBookendKind<T extends { kind: string }>(
  node: T,
): node is T & { kind: BookendNodeKind } {
  return nodeKindDescriptor(node.kind)?.bookend ?? false
}
