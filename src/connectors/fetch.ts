import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'

/**
 * The fetch every connector call hands the MCP SDK.
 *
 * The SDK releases responses it won't read with `await response.body.cancel()`
 * — on a redirect it follows by hand, a non-OK discovery probe, a 202. Some
 * fetch implementations hand back a body whose cancel never settles (Next.js's
 * patched fetch tees every body, and cancelling one branch of a tee waits for
 * the other), which hangs the whole call. So the body is re-wrapped: reads pass
 * straight through, and cancel asks the underlying stream to stop without
 * waiting on it.
 */
export const connectorFetch: FetchLike = async (url, init) => {
  const res = await fetch(url, init)
  // `new Response` rejects statuses outside 200–599 (an opaque redirect is 0).
  if (!res.body || res.status < 200 || res.status > 599) return res
  return new Response(detachCancel(res.body), {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  })
}

function detachCancel(
  body: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read()
      if (done) controller.close()
      else controller.enqueue(value)
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => {})
    },
  })
}
