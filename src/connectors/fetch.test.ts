import { afterEach, describe, expect, test } from 'bun:test'

import { connectorFetch } from './fetch'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

/**
 * A body whose cancel never settles — what a tee'd body does under Next.js.
 * It stays open after `text` (cancelling a closed stream settles at once);
 * `close` ends it for the reads test.
 */
function stuckBody(text: string, opts: { close?: boolean } = {}) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      if (opts.close) controller.close()
    },
    cancel: () => new Promise<void>(() => {}),
  })
}

/** Serve `body` as-is: a real `Response` would swap in its own stream. */
function serve(args: { body: ReadableStream<Uint8Array>; init: ResponseInit }) {
  const shape = new Response(null, args.init)
  globalThis.fetch = (async () => ({
    status: shape.status,
    statusText: shape.statusText,
    headers: shape.headers,
    ok: shape.ok,
    body: args.body,
  })) as unknown as typeof fetch
}

describe('connectorFetch', () => {
  test('cancelling a redirect body settles even when the underlying cancel never does', async () => {
    serve({
      body: stuckBody('moved'),
      init: { status: 302, headers: { location: 'https://example.com/next' } },
    })
    const res = await connectorFetch('https://example.com/start', {
      redirect: 'manual',
    })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('https://example.com/next')
    await res.body?.cancel()
  })

  test('reads pass through unchanged', async () => {
    serve({ body: stuckBody('{"ok":true}', { close: true }), init: { status: 200 } })
    const res = await connectorFetch('https://example.com/')
    expect(await res.json()).toEqual({ ok: true })
  })
})
