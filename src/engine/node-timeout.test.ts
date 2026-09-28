import { describe, expect, test } from 'bun:test'

import { AI_NODE_TIMEOUT_MS, resolveNodeTimeoutMs } from './node-timeout'

// The per-kind defaults. The run-scoped override half of this contract is
// tested from the layer that owns the override — `src/eval/node-timeout-override.test.ts`
// — because `engine` may not import `eval`, not even in a test (AGENTS.md §1).

describe('resolveNodeTimeoutMs without an override', () => {
  test('falls back to the per-kind default', () => {
    expect(resolveNodeTimeoutMs({ kind: 'agent' })).toBe(AI_NODE_TIMEOUT_MS)
    expect(resolveNodeTimeoutMs({ kind: 'tool' })).toBe(60_000)
  })

  // The regression: `iteration` fell through to the 60s default, and since the
  // container's timeout is what the item subgraph's model budget derives from,
  // 60s minus the 3-minute slack floored at `MIN_TOTAL_MS` — so every agent
  // inside every iteration ran under a 30-second cap while its own `iter:` step
  // was allowed 20 minutes. Both subgraph containers need the AI default.
  test('subgraph containers get the AI default, not the 60s one', () => {
    expect(resolveNodeTimeoutMs({ kind: 'iteration' })).toBe(AI_NODE_TIMEOUT_MS)
    expect(resolveNodeTimeoutMs({ kind: 'workflow' })).toBe(AI_NODE_TIMEOUT_MS)
  })

  test("respects the author's own timeout", () => {
    expect(
      resolveNodeTimeoutMs({ kind: 'agent', execution: { timeoutMs: 90_000 } }),
    ).toBe(90_000)
  })
})
