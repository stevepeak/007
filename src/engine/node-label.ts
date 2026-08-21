import {
  agentFromManifest,
  workflowFromManifest,
  type WfRunManifestEntry,
} from './run-manifest'

// Human-facing node labels, used to name a node's Sentry span (and any other
// place a run node needs a readable title). Kept pure and manifest-driven so it
// can be unit-tested without a live run.

// Pretty kind prefixes. Anything unlisted falls back to its raw kind string.
const KIND_LABELS: Record<string, string> = {
  agent: 'Agent',
  tool: 'Tool',
  branch: 'Branch',
  switch: 'Switch',
  workflow: 'Workflow',
  iteration: 'Iteration',
  passthrough: 'Passthrough',
  transform: 'Transform',
  race: 'Race',
  aggregate: 'Aggregate',
  'feature-request': 'Feature Request',
  trigger: 'Trigger',
  output: 'Output',
  note: 'Note',
}

function prettyKind(kind: string): string {
  return KIND_LABELS[kind] ?? kind
}

// The minimal node shape this needs — a kind, its editor label, and (for
// entity-backed nodes) the config pointing at the manifest entry. Structural so
// both the full `WorkflowNode` union and the executor's node satisfy it.
type LabelableNode = {
  kind: string
  label?: string
  config?: unknown
}

/**
 * Human label for a node, e.g. `Agent: Legal Researcher - Draft the memo` or
 * `Branch: Has prior rulings?`. Entity-backed nodes (agent, workflow) fold in
 * the resolved entity name from the run manifest; every other kind is just
 * `{Kind}: {node label}`. Falls back gracefully when the label or manifest
 * entry is missing.
 */
export function nodeSpanLabel(
  node: LabelableNode,
  manifest: readonly WfRunManifestEntry[] = [],
): string {
  const label = node.label?.trim() || undefined

  if (node.kind === 'agent') {
    const cfg = node.config as
      | { agentId?: string; version?: number | null }
      | undefined
    const name = cfg?.agentId
      ? agentFromManifest(manifest, cfg.agentId, cfg.version ?? null)?.name
      : undefined
    if (name && label) return `Agent: ${name} - ${label}`
    return `Agent: ${name ?? label ?? 'agent'}`
  }

  if (node.kind === 'workflow') {
    const cfg = node.config as { workflowId?: string } | undefined
    const name = cfg?.workflowId
      ? workflowFromManifest(manifest, cfg.workflowId)?.name
      : undefined
    if (name && label) return `Workflow: ${name} - ${label}`
    return `Workflow: ${name ?? label ?? 'workflow'}`
  }

  return label ? `${prettyKind(node.kind)}: ${label}` : prettyKind(node.kind)
}
