import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'

import type { WfDataClient } from '../server/protocol'

import { createWfMcpServer } from './server'

// Serving the MCP catalog over Streamable HTTP, as a plain fetch handler.
//
// This is the transport the stdio `wf-mcp` bin used to be. The move was not
// about transport preference — it is what made per-user authorization possible
// at all. A stdio server runs on the reader's own machine and can only carry a
// credential someone put there by hand; an HTTP endpoint can sit behind the
// app's own OAuth and learn who is calling from the token itself.
//
// Deliberately STATELESS (`sessionIdGenerator: undefined`). A Worker isolate is
// not a place to keep session state: the next request may land in a different
// one, so a session id would be a promise the runtime cannot keep. Stateless
// mode answers each POST on its own, which is exactly what the modern protocol
// is designed for — and it means no Durable Object in the path of a tool call.
//
// `enableJsonResponse` for the same reason: with no session to stream over,
// one JSON body per request is the honest shape, and it avoids holding an SSE
// stream open against a Worker's CPU budget for a call that has already
// answered.

export type CreateWfMcpHandlerOptions = {
  /**
   * The data client every tool runs against. The host builds this per request —
   * in practice `createLocalWfDataClient` bound to the identity it just
   * verified — so the catalog it serves is already scoped to that caller.
   */
  client: WfDataClient
  /**
   * Register the mutating tools. Off by default, and off means they are not
   * registered AT ALL, so a read-only session has none to be talked into
   * calling. The host drives this from the access token's scopes.
   */
  write?: boolean
}

/**
 * Build a fetch handler that speaks MCP over Streamable HTTP.
 *
 * One server and one transport per request. That looks wasteful next to a
 * long-lived stdio process and isn't: registering ~30 tool definitions is
 * assembling objects from a static catalog, and it is the only construction
 * that can be correct when the tool SET depends on the caller's scopes.
 */
export function createWfMcpHandler(
  opts: CreateWfMcpHandlerOptions,
): (req: Request) => Promise<Response> {
  return async (req) => {
    const server = createWfMcpServer({ client: opts.client, write: opts.write })
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    await server.connect(transport)
    try {
      return await transport.handleRequest(req)
    } finally {
      // The transport owns no socket here, but it does hold the server's
      // message plumbing. Closing it keeps a failed request from leaving a
      // half-connected server pinned for the isolate's lifetime.
      await transport.close()
    }
  }
}
