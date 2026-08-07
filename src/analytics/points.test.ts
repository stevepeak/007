import { describe, expect, test } from 'bun:test'

import type { ModelPriceMap } from '../storage/cost'

import {
  encodeRunPoint,
  encodeStepPoint,
  TELEMETRY_SCHEMA_VERSION,
  type RunDims,
} from './points'

// THE CONTRACT TEST. Analytics Engine columns are positional and permanent, so
// every expectation below is a LITERAL array — never one derived from the same
// constants the encoder uses, which would agree with any renumbering. If a
// change here is needed, the layout is being broken and three months of history
// is being reinterpreted.

const DIMS: RunDims = {
  workflowId: 'wf-1',
  workflowVersionId: 'ver-9',
  runId: 'run-abc',
  triggerKind: 'chat',
  traceId: 'a'.repeat(32),
  isEval: false,
  simulate: false,
}

const AGENT_META = {
  model: 'venice:llama-3.3-70b',
  systemPrompt: 'you are a lawyer',
  agentId: 'agent-7',
  agentVersion: 3,
  steps: [
    { stepNumber: 1, toolCalls: [{ toolCallId: 'a', toolName: 't', input: {}, output: {} }] },
    { stepNumber: 2, toolCalls: [] },
  ],
  totalUsage: { inputTokens: 1_000, outputTokens: 250 },
}

describe('encodeStepPoint', () => {
  test('agent step — full literal layout', () => {
    const point = encodeStepPoint(DIMS, {
      nodeId: 'node-a',
      nodeKind: 'agent',
      status: 'completed',
      sequence: 4,
      startedAt: new Date(1_700_000_000_000),
      finishedAt: new Date(1_700_000_002_500),
      meta: AGENT_META,
    })

    expect(point.indexes).toEqual(['wf-1'])
    expect(point.blobs).toEqual([
      'step', // blob1  pointType
      '1', // blob2  schemaVersion
      'wf-1', // blob3  workflowId
      'ver-9', // blob4  workflowVersionId
      'run-abc', // blob5  runId
      'chat', // blob6  triggerKind
      'a'.repeat(32), // blob7  traceId
      'node-a', // blob8  nodeId
      'agent', // blob9  nodeKind
      'completed', // blob10 status
      'venice:llama-3.3-70b', // blob11 modelId
      'agent-7', // blob12 agentId
      '', // blob13 toolId
      '', // blob14 parentNodeId
      '', // blob15 errorText
    ])
    expect(point.doubles).toEqual([
      0, // double1  isEval
      0, // double2  simulate
      4, // double3  sequence
      -1, // double4  itemIndex (top-level sentinel)
      2500, // double5  latencyMs
      1000, // double6  inputTokens
      250, // double7  outputTokens
      0, // double8  costUsdMicros (no price map supplied)
      0, // double9  priced
      2, // double10 turns
      1, // double11 toolCalls
      0, // double12 stoppedOnTokenBudget
      0, // double13 stoppedOnContextLimit
    ])
  })

  test('non-agent step carries zeros, not nulls, in the LLM ordinals', () => {
    const point = encodeStepPoint(DIMS, {
      nodeId: 'node-t',
      nodeKind: 'tool',
      status: 'completed',
      sequence: 1,
      meta: { toolId: 'tavily_search', args: { q: 'x' } },
    })

    expect(point.blobs[10]).toBe('') // blob11 modelId
    expect(point.blobs[11]).toBe('') // blob12 agentId
    expect(point.blobs[12]).toBe('tavily_search') // blob13 toolId
    // double6..double13 — tokens, cost, turns, stop flags
    expect(point.doubles.slice(5)).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  })

  test('latency is 0 when the caller never measured it', () => {
    const point = encodeStepPoint(DIMS, {
      nodeId: 'node-b',
      nodeKind: 'branch',
      status: 'completed',
      sequence: 2,
    })
    expect(point.doubles[4]).toBe(0) // double5 latencyMs
  })

  test('iteration sub-step carries its parent and item index', () => {
    const point = encodeStepPoint(DIMS, {
      nodeId: 'node-inner',
      nodeKind: 'agent',
      status: 'completed',
      sequence: 3,
      parentNodeId: 'node-iter',
      itemIndex: 7,
      meta: AGENT_META,
    })
    expect(point.blobs[13]).toBe('node-iter') // blob14 parentNodeId
    expect(point.doubles[3]).toBe(7) // double4 itemIndex
  })

  test('error text is truncated to 120 chars', () => {
    const point = encodeStepPoint(DIMS, {
      nodeId: 'node-a',
      nodeKind: 'agent',
      status: 'failed',
      sequence: 5,
      error: 'x'.repeat(500),
    })
    expect(point.blobs[9]).toBe('failed') // blob10 status
    expect(point.blobs[14]).toHaveLength(120) // blob15 errorText
  })

  test('prices are applied at encode time, in integer micros', () => {
    const prices: ModelPriceMap = new Map([
      ['venice:llama-3.3-70b', { promptPerMTok: 0.7, completionPerMTok: 2.8 }],
    ])
    const point = encodeStepPoint(
      DIMS,
      {
        nodeId: 'node-a',
        nodeKind: 'agent',
        status: 'completed',
        sequence: 1,
        meta: AGENT_META,
      },
      prices,
    )
    // (1000 × 0.7 + 250 × 2.8) / 1e6 USD = $0.0014 → 1400 micros
    expect(point.doubles[7]).toBe(1400) // double8 costUsdMicros
    expect(point.doubles[8]).toBe(1) // double9 priced
  })

  test('an unpriced model reports priced = 0, not a misleading $0', () => {
    const point = encodeStepPoint(
      DIMS,
      {
        nodeId: 'node-a',
        nodeKind: 'agent',
        status: 'completed',
        sequence: 1,
        meta: AGENT_META,
      },
      new Map(),
    )
    expect(point.doubles[7]).toBe(0) // double8 costUsdMicros
    expect(point.doubles[8]).toBe(0) // double9 priced
  })

  test('index1 falls back to the version id so it is never empty', () => {
    const point = encodeStepPoint(
      { ...DIMS, workflowId: '' },
      { nodeId: 'n', nodeKind: 'agent', status: 'completed', sequence: 1 },
    )
    expect(point.indexes).toEqual(['ver-9'])
  })
})

describe('encodeRunPoint', () => {
  test('full literal layout', () => {
    const point = encodeRunPoint(
      { ...DIMS, isEval: true, simulate: true },
      {
        status: 'completed',
        engine: 'durable',
        outputNodeId: 'node-out',
        startedAtMs: 1_700_000_000_000,
        finishedAtMs: 1_700_000_012_000,
        nodeCount: 6,
        iterationItems: 12,
        workflowSteps: 41,
        failedNodeCount: 0,
        droppedPoints: 3,
      },
    )

    expect(point.indexes).toEqual(['wf-1'])
    expect(point.blobs).toEqual([
      'run', // blob1  pointType
      '1', // blob2  schemaVersion
      'wf-1', // blob3  workflowId
      'ver-9', // blob4  workflowVersionId
      'run-abc', // blob5  runId
      'chat', // blob6  triggerKind
      'a'.repeat(32), // blob7  traceId
      'completed', // blob8  status
      'node-out', // blob9  outputNodeId
      '', // blob10 errorText
      'durable', // blob11 engine
    ])
    expect(point.doubles).toEqual([
      1, // double1 isEval
      1, // double2 simulate
      12_000, // double3 runLatencyMs
      6, // double4 nodeCount
      12, // double5 iterationItems
      41, // double6 workflowSteps
      0, // double7 failedNodeCount
      3, // double8 droppedPoints
      1_700_000_000, // double9 runStartedAtSec
    ])
  })

  test('run error text is truncated to 200 chars', () => {
    const point = encodeRunPoint(DIMS, {
      status: 'failed',
      engine: 'inline',
      error: 'y'.repeat(500),
      startedAtMs: 1_000,
      finishedAtMs: 2_000,
      nodeCount: 1,
      iterationItems: 0,
      workflowSteps: 0,
      failedNodeCount: 1,
      droppedPoints: 0,
    })
    expect(point.blobs[9]).toHaveLength(200) // blob10 errorText
    expect(point.blobs[10]).toBe('inline') // blob11 engine
  })
})

test('schema version is 1 — bump it only when ORDINALS ARE ADDED', () => {
  expect(TELEMETRY_SCHEMA_VERSION).toBe('1')
})
