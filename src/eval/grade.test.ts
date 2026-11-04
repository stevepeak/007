import { describe, expect, test } from 'bun:test'

import type { CheckTree } from '../engine/eval-schema'

import {
  gradeRow,
  rollup,
  type GradeRowInput,
  type GradeStep,
} from './grade'

// Phase 3 — the pure grader. No DB, no Cloudflare; deterministic checks read a
// hand-built trace. Judge checks are covered in grade-decision.test.ts.

// A workflow-style trace: a top-level `tool` step + an `agent` step, plus a
// node whose input we can assert on.
const workflowSteps: GradeStep[] = [
  {
    nodeKind: 'agent',
    output: { text: 'What is your order id?' },
    meta: {
      steps: [
        {
          stepNumber: 0,
          toolCalls: [
            { toolCallId: '1', toolName: 'lookup_order', input: { id: 'x' }, output: { found: false } },
            { toolCallId: '2', toolName: 'issue_refund', input: { amount: 100, currency: 'USD' }, output: { ok: true } },
          ],
        },
      ],
    },
  },
]

const output = { message: 'Your refund of $100 is on the way. ETA 3 days.' }

function grade(checks: CheckTree, extra?: Partial<GradeRowInput>) {
  return gradeRow({ checks, steps: workflowSteps, output, ...extra })
}

describe('gradeRow — deterministic checks', () => {
  test('tool_called finds a workflow Tool-node call', async () => {
    const r = await grade({
      op: 'and',
      checks: [{ type: 'tool_called', toolId: 'issue_refund', called: true }],
    })
    expect(r.status).toBe('pass')
    expect(r.checkResults[0]?.pass).toBe(true)
  })

  test('tool_called finds a call made INSIDE an agent node', async () => {
    const r = await grade({
      op: 'and',
      checks: [{ type: 'tool_called', toolId: 'lookup_order', called: true }],
    })
    expect(r.status).toBe('pass')
  })

  test('tool_called = false fails when the tool WAS called (with actual reason)', async () => {
    const r = await grade({
      op: 'and',
      checks: [{ type: 'tool_called', toolId: 'issue_refund', called: false }],
    })
    expect(r.status).toBe('fail')
    expect(r.checkResults[0]?.reason).toContain('issue_refund')
  })

  test('tool_args_match reads the tool’s recorded args at a path', async () => {
    const r = await grade({
      op: 'and',
      checks: [
        {
          type: 'tool_args_match',
          toolId: 'issue_refund',
          path: 'amount',
          match: 'equals',
          value: 100,
        },
      ],
    })
    expect(r.status).toBe('pass')
  })

  test('output_match with regex over the run output', async () => {
    const r = await grade({
      op: 'and',
      checks: [
        { type: 'output_match', path: 'message', match: 'regex', value: 'ETA' },
      ],
    })
    expect(r.status).toBe('pass')
  })

  test('output_match paths take bracket indices and a final .length', async () => {
    const r = await gradeRow({
      checks: {
        op: 'and',
        checks: [
          { type: 'output_match', path: 'items[1].id', match: 'equals', value: 'b' },
          { type: 'output_match', path: 'items.length', match: 'equals', value: 2 },
          { type: 'output_match', path: 'items[0].id.length', match: 'equals', value: 1 },
        ],
      },
      steps: [],
      output: { items: [{ id: 'a' }, { id: 'b' }] },
    })
    expect(r.status).toBe('pass')
    const list = await gradeRow({
      checks: {
        op: 'and',
        checks: [
          { type: 'output_match', path: '[0].id', match: 'equals', value: 'a' },
          { type: 'output_match', path: 'length', match: 'equals', value: 1 },
        ],
      },
      steps: [],
      output: [{ id: 'a' }],
    })
    expect(list.status).toBe('pass')
  })

  test('equals treats an undefined key as missing', async () => {
    const r = await gradeRow({
      checks: {
        op: 'and',
        checks: [
          { type: 'output_match', path: 'obj', match: 'equals', value: { a: 1 } },
          { type: 'output_match', path: 'list', match: 'contains', value: { b: 2 } },
        ],
      },
      steps: [],
      output: { obj: { a: 1, b: undefined }, list: [{ b: 2, c: undefined }] },
    })
    expect(r.status).toBe('pass')
  })

  test('binary checks never contribute a score (score is null with no judge)', async () => {
    const r = await grade({
      op: 'and',
      checks: [{ type: 'tool_called', toolId: 'issue_refund', called: true }],
    })
    expect(r.score).toBeNull()
  })
})

describe('gradeRow — AND/OR reduction', () => {
  const good = { type: 'tool_called', toolId: 'issue_refund', called: true } as const
  const bad = { type: 'tool_called', toolId: 'issue_refund', called: false } as const

  test('AND fails if any check fails', async () => {
    expect((await grade({ op: 'and', checks: [good, bad] })).status).toBe('fail')
  })
  test('OR passes if any check passes', async () => {
    expect((await grade({ op: 'or', checks: [good, bad] })).status).toBe('pass')
  })
  // A sample that asserts nothing is not a passing sample — it's an
  // unanswerable question, and it used to inflate every pass rate it sat in.
  test('an empty tree is an error, not a pass (nothing was asserted)', async () => {
    const r = await grade({ op: 'and', checks: [] })
    expect(r.status).toBe('error')
    expect(r.score).toBeNull()
    expect(r.checkResults).toEqual([])
    expect(r.error).toContain('no checks')
  })
  test('an empty OR tree is an error too', async () => {
    expect((await grade({ op: 'or', checks: [] })).status).toBe('error')
  })
})

describe('rollup', () => {
  test('pass rate + judge-only mean score', () => {
    const out = rollup([
      { status: 'pass', score: 0.9 },
      { status: 'fail', score: 0.5 },
      { status: 'pass', score: null }, // no judge → excluded from mean
      { status: 'error', score: null },
    ])
    expect(out.total).toBe(4)
    expect(out.passed).toBe(2)
    // `failed` is "not passed": the errored row counts, and `errored` names it.
    expect(out.failed).toBe(2)
    expect(out.errored).toBe(1)
    expect(out.passRate).toBe(0.5)
    expect(out.meanScore).toBeCloseTo(0.7, 5) // mean of 0.9 and 0.5
  })

  test('no scored rows → meanScore null', () => {
    expect(rollup([{ status: 'pass', score: null }]).meanScore).toBeNull()
  })
})
