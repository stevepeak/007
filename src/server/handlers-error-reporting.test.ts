import { describe, expect, test } from 'bun:test'

import { errorLogText } from '../engine/error-detail'

import { createWfSdkHandlers } from './handlers'
import { NotFoundError, UnauthorizedError } from './handlers/shared'
import type { CreateWfSdkHandlersOptions } from './handlers/shared'

// The dispatcher CATCHES every handler failure and answers a 500 JSON body, so
// a Worker-level wrapper that only sees unhandled throws never learns a request
// failed. `onError` is the seam that gets those faults to the host's error
// tracker; these tests pin what does and does not reach it, because the failure
// mode is silent in both directions (a missed fault is invisible, and a leaked
// auth rejection floods the tracker).

type Report = {
  err: unknown
  method: string
  ctx?: { userId?: string }
}

function post(method: string): Request {
  return new Request('http://localhost/api/wf', {
    method: 'POST',
    body: JSON.stringify({ method, params: {} }),
  })
}

function options(
  over: Partial<CreateWfSdkHandlersOptions<unknown>>,
): CreateWfSdkHandlersOptions<unknown> {
  return {
    // `buildHandlers` walks the tool registry once at construction, so the stub
    // has to carry an empty one — nothing here reaches a tool.
    config: { listModels: async () => [], toolRegistry: new Map() },
    resolveDb: () => ({}),
    resolveContext: () => ({ userId: 'user_123' }),
    ...over,
  } as unknown as CreateWfSdkHandlersOptions<unknown>
}

describe('dispatcher error reporting', () => {
  test('a handler fault is reported with the method and the caller who hit it', async () => {
    const reports: Report[] = []
    const boom = new Error('D1_ERROR: Network connection lost')
    const handle = createWfSdkHandlers(
      options({
        resolveDb: () => {
          throw boom
        },
        onError: (input) => {
          reports.push(input)
        },
      }),
    )

    const res = await handle(post('listAgents'))

    expect(res.status).toBe(500)
    expect(reports).toHaveLength(1)
    expect(reports[0]?.err).toBe(boom)
    expect(reports[0]?.method).toBe('listAgents')
    // Identity is the whole point of the hook — a fault nobody can attribute is
    // barely better than the console line it replaced.
    expect(reports[0]?.ctx?.userId).toBe('user_123')
  })

  test('an auth rejection answers 403 and is NOT reported', async () => {
    const reports: Report[] = []
    const handle = createWfSdkHandlers(
      options({
        resolveContext: () => {
          throw new UnauthorizedError('Unauthorized')
        },
        onError: (input) => {
          reports.push(input)
        },
      }),
    )

    const res = await handle(post('listAgents'))

    // A tab polling on an expired session must not read as a server fault.
    expect(res.status).toBe(403)
    expect(reports).toHaveLength(0)
  })

  test('a 404 is not reported either', async () => {
    const reports: Report[] = []
    const handle = createWfSdkHandlers(
      options({
        resolveDb: () => {
          throw new NotFoundError('gone')
        },
        onError: (input) => {
          reports.push(input)
        },
      }),
    )

    const res = await handle(post('listAgents'))

    expect(res.status).toBe(404)
    expect(reports).toHaveLength(0)
  })

  test('a throwing onError still yields the 500 rather than dropping the response', async () => {
    const handle = createWfSdkHandlers(
      options({
        resolveDb: () => {
          throw new Error('underlying fault')
        },
        onError: () => {
          throw new Error('the error tracker is itself down')
        },
      }),
    )

    const res = await handle(post('listAgents'))

    expect(res.status).toBe(500)
    expect(await res.json<unknown>()).toEqual({ error: 'underlying fault' })
  })

  test('the failure resolves an identity when it can, and omits it when it cannot', async () => {
    const reports: Report[] = []
    const handle = createWfSdkHandlers(
      options({
        // The auth lookup itself fails — a genuine fault (not a rejection), so
        // it IS reported, but there is no resolved caller to attribute it to.
        resolveContext: () => {
          throw new Error('auth database unreachable')
        },
        onError: (input) => {
          reports.push(input)
        },
      }),
    )

    const res = await handle(post('listAgents'))

    expect(res.status).toBe(500)
    expect(reports).toHaveLength(1)
    expect(reports[0]?.ctx).toBeUndefined()
  })
})

describe('errorLogText', () => {
  test('keeps the message and the cause chain that a raw stack drops', () => {
    // The shape that went unattributable in production: drizzle's message names
    // only the SQL, and the D1 rejection hangs off `cause`.
    const cause = new Error('D1_ERROR: Network connection lost')
    const err = new Error('Failed query: select "id" from "wf_agent"', { cause: cause })

    const text = errorLogText(err)

    expect(text).toContain('Failed query: select "id" from "wf_agent"')
    expect(text).toContain('caused by: Error: D1_ERROR: Network connection lost')
  })

  test('a non-Error cause is serialized, not stringified to [object Object]', () => {
    const err = new Error('outer', { cause: { code: 'D1_ERROR', retryable: false } })

    const text = errorLogText(err)

    expect(text).toContain('"code":"D1_ERROR"')
    expect(text).not.toContain('[object Object]')
  })

  test('a self-referential cause terminates instead of spinning', () => {
    const a = new Error('a')
    const b = new Error('b')
    // Assignment, not the constructor option: the two errors reference EACH
    // OTHER, so neither cause exists when the other is constructed. Building
    // that cycle is the whole point of this test.
    /* eslint-disable unicorn/no-error-property-assignment */
    a.cause = b
    b.cause = a
    /* eslint-enable unicorn/no-error-property-assignment */

    expect(errorLogText(a)).toContain('caused by: Error: b')
  })
})
