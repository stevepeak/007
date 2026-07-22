import type { WorkflowGraph } from './graph-schema'
import {
  ITERATION_ITEM_TRIGGER_KIND,
  MANUAL_TRIGGER_KIND,
  PERIODIC_TRIGGER_KIND,
} from './trigger-registry'

// The trigger a new workflow is seeded with (chosen in the creation flow).
export type NewWorkflowTrigger =
  | { mode: 'manual' }
  | { mode: 'periodic'; cron: string }
  // `eventLabel` is the event's human description, used as the trigger node's
  // display label so the internal `event` kind is never surfaced. Falls back to
  // a generic 'On event' when the caller has no description on hand.
  | { mode: 'event'; event: string; eventLabel?: string }

/**
 * Build the minimal valid starter graph for a new workflow: the chosen trigger
 * wired straight into an Output node. The editor takes over from here.
 */
export function buildStarterGraph(trigger: NewWorkflowTrigger): WorkflowGraph {
  const triggerId = crypto.randomUUID()
  const outputId = crypto.randomUUID()

  const config =
    trigger.mode === 'manual'
      ? { triggerKind: MANUAL_TRIGGER_KIND }
      : trigger.mode === 'periodic'
        ? { triggerKind: PERIODIC_TRIGGER_KIND, cron: trigger.cron }
        : { triggerKind: trigger.event }

  const label =
    trigger.mode === 'manual'
      ? 'Manual start'
      : trigger.mode === 'periodic'
        ? 'On schedule'
        : (trigger.eventLabel ?? 'On event')

  return {
    version: 1,
    nodes: [
      {
        id: triggerId,
        kind: 'trigger',
        label,
        position: { x: 0, y: 0 },
        config,
      },
      {
        id: outputId,
        kind: 'output',
        label: 'Output',
        position: { x: 320, y: 0 },
        config: {},
      },
    ],
    edges: [
      {
        id: crypto.randomUUID(),
        source: triggerId,
        target: outputId,
        condition: null,
      },
    ],
  }
}

/**
 * Build the minimal valid subgraph an iteration node is seeded with: an
 * `iteration_item` trigger (its output is the current list element) wired
 * straight into an Output node. In the editor these two render as the `Item` and
 * `Result` bookend nodes inside the iteration container; the author drops work
 * nodes between them. Positions are relative to the container's top-left, offset
 * below its header.
 */
export function buildIterationSubgraph(): WorkflowGraph {
  const triggerId = crypto.randomUUID()
  const outputId = crypto.randomUUID()
  return {
    version: 1,
    nodes: [
      {
        id: triggerId,
        kind: 'trigger',
        label: 'Item',
        position: { x: 24, y: 72 },
        config: { triggerKind: ITERATION_ITEM_TRIGGER_KIND },
      },
      {
        id: outputId,
        kind: 'output',
        label: 'Result',
        position: { x: 300, y: 72 },
        config: {},
      },
    ],
    edges: [
      {
        id: crypto.randomUUID(),
        source: triggerId,
        target: outputId,
        condition: null,
      },
    ],
  }
}
