import { describe, expect, test } from 'bun:test'

import { parseEvalPlan, resolveEvalCellMode } from './plan'

// How a sweep decides which way its cells execute — the one structural
// difference between the two agent kinds, resolved once at launch and frozen.

describe('resolveEvalCellMode', () => {
  const kinds = new Map<string, 'generation' | 'decision'>([
    ['gen_1', 'generation'],
    ['dec_1', 'decision'],
  ])

  test('a decision-agent goal runs its cells inline', () => {
    expect(
      resolveEvalCellMode([{ targetId: 'dec_1' }], kinds),
    ).toEqual({ mode: 'decision' })
  })

  test('a generation agent runs as wf_runs', () => {
    expect(
      resolveEvalCellMode([{ targetId: 'gen_1' }], kinds),
    ).toEqual({ mode: 'run' })
  })

  test('mixing the two kinds is refused rather than half-launched', () => {
    // The two produce incomparable reports — one has runs, steps and a cost
    // per cell; the other has a verdict and a matrix.
    const resolved = resolveEvalCellMode(
      [
        { targetId: 'dec_1' },
        { targetId: 'gen_1' },
      ],
      kinds,
    )
    expect('error' in resolved).toBe(true)
  })

  test('an agent whose kind is unknown reads as a run cell', () => {
    // A failed `listAgents` must not turn every goal into a decision sweep.
    expect(
      resolveEvalCellMode(
        [{ targetId: 'never_seen' }],
        new Map(),
      ),
    ).toEqual({ mode: 'run' })
  })
})

describe('parseEvalPlan', () => {
  test('a plan written before ART-238 reads as a run sweep', () => {
    // Absent `mode` is exactly what `run` means, so no migration is needed.
    const plan = parseEvalPlan({
      version: 1,
      cells: [{ rowId: 'row_1' }],
      concurrency: 2,
      timeoutMs: 1000,
    })
    expect(plan?.mode).toBe('run')
  })

  test('a decision plan survives the round trip', () => {
    const plan = parseEvalPlan({
      version: 1,
      mode: 'decision',
      cells: [{ rowId: 'row_1' }],
      concurrency: 2,
      timeoutMs: 1000,
    })
    expect(plan?.mode).toBe('decision')
  })
})
