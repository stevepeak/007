import { describe, expect, test } from 'bun:test'

import type { WfRunManifestEntry } from '../engine/graph'

import {
  calleeEventType,
  iterationItemParams,
  WF_EVENT_TYPE_PATTERN,
} from './callee-protocol'
import type { GraphWorkflowParams } from './graph-workflow'

// NEW-173. What one item of a DURABLE iteration is started with.
//
// The two fields worth a test are the two that are optional on
// `GraphWorkflowParams`: leaving either out compiles, and then the child quietly
// runs the wrong graph or against the wrong prompt versions. Neither failure
// announces itself at run time — you get a plausible result from the wrong
// input — so they are pinned here rather than left to review.

const MANIFEST: WfRunManifestEntry[] = [
  { kind: 'agent', id: 'agent-1', versionId: 'agent-1-v3', versionNumber: 3 },
] as unknown as WfRunManifestEntry[]

const parent = {
  runId: 'parent-room',
  workflowRunId: 'parent-run',
  workflowVersionId: 'version-7',
  triggerInput: { document: 'the whole pdf' },
  runContext: {
    triggerKind: 'upload',
    subjectId: 'org-1',
    correlationId: 'corr-1',
    actorId: 'user-1',
    promptVariables: { locale: 'nl' },
  },
} as unknown as GraphWorkflowParams

function build(index: number, item: unknown) {
  return iterationItemParams({
    parent,
    manifest: MANIFEST,
    parentInstanceId: 'parent-instance',
    nodeId: 'per-recipe',
    item,
    eventType: calleeEventType('per-recipe', index),
    childRunId: `child-run-${index}`,
    roomId: `child-room-${index}`,
  })
}

describe('iterationItemParams', () => {
  test('names the iteration node, so the child runs the SUBGRAPH', () => {
    // Without this the child loads `workflowVersionId`'s whole graph and runs
    // the entire parent workflow again — per item.
    expect(build(0, 'a').subRun?.iterationNodeId).toBe('per-recipe')
  })

  test('passes the frozen manifest down instead of letting the child resolve', () => {
    // Without this the child re-resolves every floating reference at ITS start,
    // so a publish landing mid-run splits one logical run across two prompt
    // versions — the exact thing the manifest exists to prevent.
    expect(build(0, 'a').inheritedManifest).toEqual(MANIFEST)
  })

  test('runs against the parent version and carries the parent run context', () => {
    const params = build(0, 'a')

    expect(params.workflowVersionId).toBe('version-7')
    expect(params.runContext).toEqual(parent.runContext)
  })

  test('seeds the ITEM as trigger input, not the parent trigger input', () => {
    // A sub-run is seeded raw, so this is the same value `executeSubgraph`
    // hands the subgraph inline — which is what keeps flipping item execution
    // from changing what the item sees.
    const item = { title: 'Bavette', locator: 'p3' }

    expect(build(2, item).triggerInput).toEqual(item)
    expect(build(2, item).triggerInput).not.toEqual(parent.triggerInput)
  })

  test('each item gets its own run, room, and event type', () => {
    const a = build(0, 'a')
    const b = build(1, 'b')

    expect(a.workflowRunId).not.toBe(b.workflowRunId)
    expect(a.runId).not.toBe(b.runId)
    // The one that matters most: a shared event type would let whichever child
    // finished first wake both waiters, handing each the wrong item's output.
    expect(a.subRun?.eventType).not.toBe(b.subRun?.eventType)
  })

  test('every child reports to the same parent instance, with a valid type', () => {
    for (const i of [0, 1, 17]) {
      const params = build(i, i)
      expect(params.subRun?.parent).toEqual({
        kind: 'instance',
        instanceId: 'parent-instance',
      })
      expect(params.subRun?.eventType).toMatch(WF_EVENT_TYPE_PATTERN)
    }
  })
})
