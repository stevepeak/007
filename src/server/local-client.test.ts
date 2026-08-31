import { describe, expect, test } from 'bun:test'

import { createLocalWfDataClient } from './local-client'

/**
 * The in-process client's whole job is to be indistinguishable from a real
 * request to the mounted route — same wire shape, same credentials, same
 * errors. Each of those is a way the copilot could quietly see more, or less,
 * than the person driving it.
 */

type Call = { method: string; params: unknown; headers: Headers }

function capture(
  respond: (call: Call) => Response = () => Response.json({ ok: true }),
): { calls: Call[]; handler: (req: Request) => Promise<Response> } {
  const calls: Call[] = []
  return {
    calls,
    handler: async (req) => {
      const body: { method: string; params: unknown } = await req.json()
      const call: Call = {
        method: body.method,
        params: body.params,
        headers: new Headers(req.headers),
      }
      calls.push(call)
      return respond(call)
    },
  }
}

function request(headers: Record<string, string> = {}): Request {
  return new Request('https://host.example/api/wf', {
    method: 'POST',
    headers,
    body: '{}',
  })
}

describe('createLocalWfDataClient', () => {
  test('sends the wire shape the HTTP client sends', async () => {
    const { calls, handler } = capture()
    const client = createLocalWfDataClient({ handler, request: request() })
    await client.getRun('run_1')
    expect(calls[0]?.method).toBe('getRun')
    // Positional on the interface, an object on the wire — the mapping the
    // dispatcher's input schemas are written against.
    expect(calls[0]?.params).toEqual({ runId: 'run_1' })
  })

  // The reason a copilot tool can't read anything its caller couldn't: the
  // host's `resolveContext` runs per call, against the real request's cookies.
  test("carries the caller's credentials on every call", async () => {
    const { calls, handler } = capture()
    const client = createLocalWfDataClient({
      handler,
      request: request({ cookie: 'session=abc', authorization: 'Bearer t' }),
    })
    await client.listAgents()
    await client.listWorkflows()
    for (const call of calls) {
      expect(call.headers.get('cookie')).toBe('session=abc')
      expect(call.headers.get('authorization')).toBe('Bearer t')
    }
  })

  test("does not inherit the original request's content-length", async () => {
    const { calls, handler } = capture()
    const client = createLocalWfDataClient({
      handler,
      request: request({ 'content-length': '2' }),
    })
    await client.listAgents()
    expect(calls[0]?.headers.get('content-length')).toBeNull()
    expect(calls[0]?.headers.get('content-type')).toBe('application/json')
  })

  test('raises the dispatcher\'s own error text', async () => {
    const { handler } = capture(() =>
      Response.json({ error: 'Forbidden' }, { status: 403 }),
    )
    const client = createLocalWfDataClient({ handler, request: request() })
    expect(client.listAgents()).rejects.toThrow('Forbidden')
  })

  test('still fails loudly when the body carries no reason', async () => {
    const { handler } = capture(() => new Response('', { status: 500 }))
    const client = createLocalWfDataClient({ handler, request: request() })
    expect(client.listAgents()).rejects.toThrow('listAgents failed (500)')
  })
})
