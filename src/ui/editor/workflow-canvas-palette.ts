import {
  buildIterationSubgraph,
  ITERATION_MAX_ITEMS_DEFAULT,
} from '../../engine'

import type { EditorNodeData } from './node-renderers'

/** Defaults for freshly-dragged nodes — sourced from the host's models/tools. */
export type NodeDefaults = { toolId: string }

// Default data for a freshly-dragged palette item. Model/tool ids come from the
// host (first available), so no provider is hardcoded. Returns null for the
// bookend kinds (trigger/output are template-owned, not palette-added).
export function defaultDataForKind(
  kind: string,
  defaults?: NodeDefaults,
): EditorNodeData | null {
  const data = nodeConfigForKind(kind, defaults)
  // Every fresh node starts silent; the inspector's "Inform user" control edits
  // it. Attached once here so each kind's shape below need not repeat it.
  return data
    ? ({ ...data, informUser: { mode: 'off' } } as EditorNodeData)
    : null
}

function nodeConfigForKind(
  kind: string,
  defaults?: NodeDefaults,
): Omit<EditorNodeData, 'informUser'> | null {
  const toolId = defaults?.toolId || 'tool'
  if (kind === 'agent') {
    // A pointer node — the inspector picks which pre-developed agent to run.
    return {
      kind: 'agent',
      label: 'New agent',
      config: {
        agentId: '',
        version: null,
        inputs: {},
      },
    }
  }
  if (kind === 'tool') {
    return { kind: 'tool', label: 'New tool', config: { toolId, args: {} } }
  }
  if (kind === 'branch') {
    return {
      kind: 'branch',
      label: 'New branch',
      config: { operator: 'is_not_empty' },
    }
  }
  if (kind === 'switch') {
    // Seeded with no cases — the author adds them in the inspector, which grows
    // one outgoing handle per case plus the always-present `default`. Until a
    // 'default' edge exists the graph flags a (non-blocking) issue.
    return {
      kind: 'switch',
      label: 'New switch',
      config: { cases: [] },
    }
  }
  if (kind === 'iteration') {
    // Seeded with a minimal Item → Result subgraph; the author drops work nodes
    // into the block. `source` is intentionally left unset so the block reads as
    // "no list selected" (an error) until the author picks a list to iterate.
    return {
      kind: 'iteration',
      label: 'New iteration',
      config: {
        concurrency: 4,
        stopOnError: false,
        // The cheap, no-surprises default. The Issues panel nudges the author to
        // Durable once the subgraph grows past a step or two, which is the point
        // at which the choice actually starts to matter.
        itemExecution: 'inline',
        // Bounded from the first frame: an unset limit is an error in the Issues
        // panel, and a new node should never open already broken. The seed is the
        // inline ceiling, so the author's only reason to touch it is to go LOWER
        // (or to raise it after switching to Durable).
        maxItems: ITERATION_MAX_ITEMS_DEFAULT.inline,
        subgraph: buildIterationSubgraph(),
      },
    }
  }
  if (kind === 'workflow') {
    // A pointer node — the inspector picks which workflow to call. Left empty so
    // it reads as "no workflow selected" (an error) until the author picks one.
    return {
      kind: 'workflow',
      label: 'Call workflow',
      // `calleeExecution: 'inline'` is the cheap default; the Issues panel nudges
      // toward Durable once the chosen callee turns out to be a real pipeline.
      config: { workflowId: '', inputs: {}, calleeExecution: 'inline' },
    }
  }
  if (kind === 'feature-request') {
    return {
      kind: 'feature-request',
      label: 'Feature request',
      config: { description: '' },
    }
  }
  if (kind === 'passthrough') {
    // Starts as a pure identity (forwards its input). The author opens the
    // inspector to switch it to `value` (one binding, unwrapped) or `fields`
    // (build an object) — the shape a converging branch arm needs.
    return { kind: 'passthrough', label: 'Passthrough', config: {} }
  }
  if (kind === 'transform') {
    // Drops in empty, which reads as a blocking "no expression" issue until the
    // author writes one — deliberate, since an expressionless transform has no
    // behaviour at all and silently forwarding its input would be a different
    // node (that node is Passthrough).
    return {
      kind: 'transform',
      label: 'Transform',
      config: { inputs: {}, expression: '' },
    }
  }
  if (kind === 'race') {
    // A config-less first-to-finish join. The author wires several upstreams into
    // it; the first to complete wins. It reads as a (non-blocking) "needs 2+
    // inputs" warning until at least two feed in.
    return { kind: 'race', label: 'Race', config: {} }
  }
  if (kind === 'aggregate') {
    // A config-less wait-for-all join. The author wires several upstreams into it;
    // once all complete it emits an ordered list (one element per producer) for a
    // downstream sibling to iterate. Reads as a (non-blocking) "needs 2+ inputs"
    // warning until at least two feed in.
    return { kind: 'aggregate', label: 'Aggregate', config: {} }
  }
  if (kind === 'note') {
    return { kind: 'note', label: 'Note', config: { text: '' } }
  }
  return null
}
