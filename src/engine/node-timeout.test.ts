import { describe, expect, test } from 'bun:test'

import { EVAL_NODE_EXECUTION } from '../eval/execution-policy'

import { AI_NODE_TIMEOUT_MS, resolveNodeTimeoutMs } from './node-timeout'

// The run-scoped override lets an eval bound a wedged provider without
// rewriting anybody's published graph. "Tighten only" is the whole contract: it
// must beat a looser author policy and never relax a stricter one.

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

describe('resolveNodeTimeoutMs with a run-scoped override', () => {
  test('tightens a node that declared nothing', () => {
    // The case that matters most: with no `execution`, a node silently inherits
    // 20 minutes. If the kind default didn't participate in the comparison the
    // override would be a no-op for exactly these nodes.
    expect(resolveNodeTimeoutMs({ kind: 'agent' }, EVAL_NODE_EXECUTION)).toBe(
      7 * 60_000,
    )
  })

  test('does not loosen a node that is already stricter', () => {
    expect(
      resolveNodeTimeoutMs(
        { kind: 'agent', execution: { timeoutMs: 60_000 } },
        EVAL_NODE_EXECUTION,
      ),
    ).toBe(60_000)
  })

  test('cannot be defeated by an author declaring something looser', () => {
    expect(
      resolveNodeTimeoutMs(
        { kind: 'agent', execution: { timeoutMs: 30 * 60_000 } },
        EVAL_NODE_EXECUTION,
      ),
    ).toBe(7 * 60_000)
  })

  test('an override with no timeout changes nothing', () => {
    expect(resolveNodeTimeoutMs({ kind: 'agent' }, { retries: { limit: 0 } })).toBe(
      AI_NODE_TIMEOUT_MS,
    )
  })
})
