import { describe, expect, test } from 'bun:test'

import { workflowGraphSchema } from './graph'
import { chainGraph } from './executor-test-helpers'

describe('graph schema — node execution policy', () => {
  test('accepts a node with a full execution policy', () => {
    const parsed = workflowGraphSchema.parse(
      chainGraph({
        continueOnError: true,
        timeoutMs: 120_000,
        retries: { limit: 1, delayMs: 2_000, backoff: 'exponential' },
      }),
    )
    const boom = parsed.nodes.find((n) => n.id === 'boom')
    expect(boom?.execution).toEqual({
      continueOnError: true,
      timeoutMs: 120_000,
      retries: { limit: 1, delayMs: 2_000, backoff: 'exponential' },
    })
  })

  test('rejects a non-positive timeout', () => {
    expect(() =>
      workflowGraphSchema.parse(chainGraph({ timeoutMs: 0 })),
    ).toThrow()
  })

  test('a node with no execution policy parses (field stays undefined)', () => {
    const parsed = workflowGraphSchema.parse(chainGraph())
    expect(parsed.nodes.find((n) => n.id === 'boom')?.execution).toBeUndefined()
  })
})
