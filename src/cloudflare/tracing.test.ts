import { beforeEach, describe, expect, mock, test } from 'bun:test'

const captured: unknown[] = []

void mock.module('@sentry/cloudflare', () => ({
  captureException: (err: unknown) => {
    captured.push(err)
  },
  startSpan: async (_opts: unknown, fn: () => Promise<unknown>) => {
    return await fn()
  },
  continueTrace: async (_opts: unknown, fn: () => Promise<unknown>) => {
    return await fn()
  },
}))

const { withNodeSpan } = await import('./tracing')
const { markOverrun } = await import('../engine/nodes/agent-generation-guard')

const info = { runId: 'run-1', nodeId: 'agent', nodeKind: 'agent', sequence: 1 }

async function fail(args: { err: unknown; isEval: boolean }) {
  await expect(
    withNodeSpan({ ...info, isEval: args.isEval }, async () => {
      throw args.err
    }),
  ).rejects.toBe(args.err)
}

describe('withNodeSpan — failure capture', () => {
  beforeEach(() => {
    captured.length = 0
  })

  test('an eval budget overrun still fails the node but is not an issue', async () => {
    await fail({ err: markOverrun(new Error('over budget')), isEval: true })
    expect(captured).toHaveLength(0)
  })

  test('the same overrun on a production run is captured', async () => {
    await fail({ err: markOverrun(new Error('over budget')), isEval: false })
    expect(captured).toHaveLength(1)
  })

  test('any other eval failure is captured', async () => {
    await fail({ err: new Error('provider 500'), isEval: true })
    expect(captured).toHaveLength(1)
  })
})
