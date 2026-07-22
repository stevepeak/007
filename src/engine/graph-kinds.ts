// Canonical node-kind list and the kind-based classifiers that ride on it. Kept
// free of the zod schemas so both the schema layer and the scheduler/topology
// can depend on these constants without pulling in the whole graph module.

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
