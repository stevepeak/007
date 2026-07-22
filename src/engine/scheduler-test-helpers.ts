import type { Scheduler } from './scheduler'

// ---------------------------------------------------------------------------
// Minimal node/edge builders. We lean on workflowGraphSchema defaults (applied
// inside the Scheduler constructor) so each builder only sets what a test
// actually cares about.
// ---------------------------------------------------------------------------

let seq = 0
const pos = () => ({ x: (seq += 10), y: 0 })

export function trigger (id: string) {
  return {
  id,
  kind: 'trigger' as const,
  position: pos(),
  label: id,
  config: { triggerKind: 'chat_message' },
}
}

export function agent (id: string) {
  return {
  id,
  kind: 'agent' as const,
  position: pos(),
  label: id,
  config: { agentId: 'agent-1' },
}
}

export function branch (id: string) {
  return {
  id,
  kind: 'branch' as const,
  position: pos(),
  label: id,
  config: { operator: 'is_not_empty' as const },
}
}

export function output (id: string) {
  return {
  id,
  kind: 'output' as const,
  position: pos(),
  label: id,
  config: {},
}
}

export function race (id: string) {
  return {
  id,
  kind: 'race' as const,
  position: pos(),
  label: id,
  config: {},
}
}

export function aggregate (id: string) {
  return {
  id,
  kind: 'aggregate' as const,
  position: pos(),
  label: id,
  config: {},
}
}

export function edge (source: string,
  target: string,
  condition: 'yes' | 'no' | null = null) {
  return {
  id: `${source}->${target}:${condition ?? ''}`,
  source,
  target,
  condition,
}
}

/** Drive a scheduler to completion, executing each node via `run`. */
export function drive(
  s: Scheduler,
  run: (
    nodeId: string,
    kind: string,
  ) => {
    output: unknown
    branchResult?: 'yes' | 'no'
  },
): { fired: string[]; outputNodeId: string; output: unknown } {
  const fired: string[] = []
  while (true) {
    const inst = s.next()
    if (inst.type === 'stall') {
      throw new Error('stalled')
    }
    if (inst.type === 'output') {
      return { fired, outputNodeId: inst.nodeId, output: inst.output }
    }
    fired.push(inst.node.id)
    s.report(inst.node.id, run(inst.node.id, inst.node.kind))
  }
}
