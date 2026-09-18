import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Implementation } from '@modelcontextprotocol/sdk/types.js'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker-provider.js'

import type { DiscoveredTool } from '../storage/data/connectors'

import { schemaHash } from './tool-id'

// The MCP client, as this SDK is allowed to construct one.
//
// ─── Why the factory exists ────────────────────────────────────────────────
// `new Client(info)` compiles every tool's `outputSchema` with Ajv, and Ajv
// compiles via `new Function`, which workerd forbids:
//
//   EvalError: Code generation from strings disallowed for this context
//       at Ajv2.compileSchema → AjvJsonSchemaValidator.getValidator
//       at Client.cacheToolMetadata → Client.listTools
//
// Two things make that worse than a plain incompatibility. It fires on
// `tools/list` — the one call discovery cannot skip — and it is DATA-dependent,
// so a server whose tools declare no output schema smoke-tests clean and the
// feature breaks on the first real connector. `callTool` alone never trips it,
// which is exactly how it would hide until production.
//
// So no call site constructs a `Client` directly; `createMcpClient` is the only
// constructor, and it always injects the SDK's eval-free edge validator.
// `client-factory.test.ts` enforces that by reading this directory's source.

const CLIENT_INFO = { name: '007', version: '0.1.0' }

/** How we authenticate to a server for one session. */
export type McpAuth =
  | { kind: 'bearer'; token: string }
  | { kind: 'none' }

export type McpTarget = {
  url: string
  transport?: 'http' | 'sse'
  auth?: McpAuth
  /** Abort the whole session after this long. Defaults to 30s. */
  timeoutMs?: number
}

/**
 * The server rejected our credential.
 *
 * Its own type because it is the one failure with a user-facing remedy: the
 * caller flips the connection to `expired`, and the connectors page offers
 * Reconnect instead of the tool failing anonymously inside runs forever.
 */
export class McpUnauthorizedError extends Error {
  constructor(message = 'The MCP server rejected our credentials.') {
    super(message)
    this.name = 'McpUnauthorizedError'
  }
}

/** Any other transport/protocol failure, with the server's status if it had one. */
export class McpTransportError extends Error {
  readonly status: number | undefined
  constructor(message: string, status?: number) {
    super(message)
    this.name = 'McpTransportError'
    this.status = status
  }
}

/** A tool reported `isError`, i.e. the call ran and failed on the server. */
export class McpToolCallError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'McpToolCallError'
  }
}

/**
 * The scheme is always the literal `Bearer`, never the server's own
 * `token_type` echoed back. RFC 6750 makes the scheme case-insensitive, but
 * Linear answers `token_type: "bearer"` from its token endpoint and then 401s
 * `Authorization: bearer …` at its MCP server — and the official MCP SDK
 * hard-codes `Bearer`, so that is the only spelling servers are ever tested
 * against. A non-bearer `token_type` is a server we don't support anyway.
 */
export function authHeaders(auth: McpAuth | undefined): Record<string, string> {
  if (!auth || auth.kind === 'none') return {}
  return { Authorization: `Bearer ${auth.token}` }
}

/**
 * Translate a transport failure into our vocabulary.
 *
 * Without an `authProvider` the SDK surfaces a 401 as a `StreamableHTTPError`
 * with `code: 401` rather than its own `UnauthorizedError`; we deliberately
 * don't wire an authProvider (token lifecycle is ours, in D1 — see `oauth.ts`),
 * so this is the path every expired credential takes.
 */
function toConnectorError(err: unknown): Error {
  if (err instanceof StreamableHTTPError) {
    if (err.code === 401 || err.code === 403) {
      return new McpUnauthorizedError(
        `The MCP server rejected our credentials (HTTP ${err.code}).`,
      )
    }
    return new McpTransportError(err.message, err.code)
  }
  const e = err as { name?: string; message?: string }
  // The SSE transport and the SDK's auth helpers raise this name instead.
  if (e?.name === 'UnauthorizedError') return new McpUnauthorizedError()
  return new McpTransportError(e?.message ?? String(err))
}

/**
 * The ONLY place a `Client` is constructed. See the header.
 */
function createMcpClient(): Client {
  return new Client(CLIENT_INFO, {
    jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
  })
}

/** A connected session. Scoped to {@link withMcpSession} so it always closes. */
export type McpSession = {
  listTools: () => Promise<DiscoveredTool[]>
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>
  /**
   * What the server said about itself on `initialize` — name, version and,
   * on servers speaking MCP 2025-11-25 or later, `icons` / `websiteUrl`. Free:
   * the handshake already happened in `connect`, this only reads it back.
   */
  serverInfo: () => Implementation | undefined
}

/**
 * Connect, run, and always disconnect.
 *
 * One session per unit of work rather than a pooled connection: a Worker
 * isolate cannot hold a session across a durable step boundary, and MCP's
 * `Mcp-Session-Id` is optional server-side anyway. The cost is an `initialize`
 * round trip per call, which is the honest price of durable execution.
 */
export async function withMcpSession<T>(
  target: McpTarget,
  fn: (session: McpSession) => Promise<T>,
): Promise<T> {
  const client = createMcpClient()
  const headers = authHeaders(target.auth)
  const url = new URL(target.url)
  const transport =
    target.transport === 'sse'
      ? new SSEClientTransport(url, { requestInit: { headers } })
      : new StreamableHTTPClientTransport(url, { requestInit: { headers } })

  const timeoutMs = target.timeoutMs ?? 30_000
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), timeoutMs)

  try {
    await client.connect(transport)
    const session: McpSession = {
      listTools: () => listTools(client),
      callTool: (name, args) => callTool(client, name, args),
      serverInfo: () => client.getServerVersion(),
    }
    return await fn(session)
  } catch (err) {
    throw toConnectorError(err)
  } finally {
    clearTimeout(timer)
    // Closing is best-effort: the work is already done (or already failed), and
    // a server that mishandles session teardown must not turn a good result
    // into an error.
    try {
      await client.close()
    } catch {
      // ignore
    }
  }
}

/**
 * Read whether a tool is safe under simulation from its MCP annotations.
 *
 * `readOnlyHint: true` → `read`; anything else → `write`. Unclassified-as-write
 * is the safe direction: evals then simulate it rather than letting an eval run
 * mutate somebody's tracker, and the playground warns before a real call. The
 * cost is a read-only tool mislabelled until someone overrides it, which is a
 * far cheaper mistake than the reverse.
 */
export function deriveSideEffect(annotations: unknown): 'read' | 'write' {
  const hint = (annotations as { readOnlyHint?: unknown } | null | undefined)
    ?.readOnlyHint
  return hint === true ? 'read' : 'write'
}

async function listTools(client: Client): Promise<DiscoveredTool[]> {
  const { tools } = await client.listTools()
  return await Promise.all(
    tools.map(async (t) => ({
      name: t.name,
      title: t.title ?? null,
      description: t.description ?? null,
      inputSchema: t.inputSchema ?? null,
      outputSchema: t.outputSchema ?? null,
      annotations: t.annotations ?? null,
      sideEffect: deriveSideEffect(t.annotations),
      schemaHash: await schemaHash({
        inputSchema: t.inputSchema,
        outputSchema: t.outputSchema,
      }),
    })),
  )
}

/**
 * Normalize a tool result into the single value a node's output carries.
 *
 * Preference order is deliberate: `structuredContent` is the machine-readable
 * answer when the tool declares an output schema (and the client has already
 * validated it against that schema), so it wins. Otherwise the text blocks are
 * joined — and a lone text block that happens to be JSON is parsed, because
 * that is how most servers return structured data today, and handing a
 * downstream node a JSON *string* it has to parse itself would be a worse
 * default than trying.
 */
export function normalizeToolResult(result: {
  content?: unknown
  structuredContent?: unknown
  isError?: boolean
}): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent
  const blocks = Array.isArray(result.content) ? result.content : []
  const text = blocks
    .filter(
      (b): b is { type: 'text'; text: string } => { return (b as { type?: unknown })?.type === 'text' &&
        typeof (b as { text?: unknown })?.text === 'string' },
    )
    .map((b) => b.text)
    .join('\n')
  if (!text) return blocks.length > 0 ? blocks : null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const result = (await client.callTool({ name, arguments: args })) as {
    content?: unknown
    structuredContent?: unknown
    isError?: boolean
  }
  if (result.isError) {
    const message = normalizeToolResult({ content: result.content })
    throw new McpToolCallError(
      typeof message === 'string' ? message : JSON.stringify(message),
    )
  }
  return normalizeToolResult(result)
}

// The largest icon we will persist. A 64px PNG data URI is a few KB; anything
// past this is a server padding our connector row, not a brand mark.
const MAX_ICON_SRC_LENGTH = 64 * 1024

/**
 * Choose the one icon `src` worth storing from a server's `initialize` info.
 *
 * Third-party input, so the scheme is allow-listed rather than trusted: only
 * `https:` and `data:image/*` survive, which rules out `javascript:`, plain
 * `http:` (mixed content on a https host) and non-image data URIs. Among the
 * survivors an SVG wins (crisp at every chip size), then a light-theme or
 * theme-less one — the UI is light — then whatever the server listed first.
 */
export function pickServerIcon(
  info: Pick<Implementation, 'icons'> | undefined,
): string | null {
  const candidates = (info?.icons ?? []).filter((i) => {
    const src = i.src.trim()
    if (src.length === 0 || src.length > MAX_ICON_SRC_LENGTH) return false
    const lower = src.toLowerCase()
    return lower.startsWith('https://') || lower.startsWith('data:image/')
  })
  if (candidates.length === 0) return null
  const score = (i: (typeof candidates)[number]): number => {
    const svg =
      i.mimeType === 'image/svg+xml' ||
      i.src.toLowerCase().startsWith('data:image/svg') ||
      /\.svg(?:\?|$)/i.test(i.src)
    return (svg ? 2 : 0) + (i.theme === 'dark' ? 0 : 1)
  }
  return candidates.reduce((best, i) => (score(i) > score(best) ? i : best)).src
    .trim()
}

/** Everything a Refresh learns about a server in one session. */
export type DiscoveredCatalog = {
  tools: DiscoveredTool[]
  /** The server-advertised icon, already vetted by {@link pickServerIcon}. */
  iconUrl: string | null
}

/**
 * Discover a server's catalog — the one call a Refresh makes.
 *
 * Returns tool rows in exactly the shape `upsertConnectorTools` persists,
 * hashes and side-effect classification included, so nothing between the wire
 * and the database gets to reinterpret them — plus the server's own icon,
 * which the same `initialize` handshake already delivered.
 */
export async function discoverCatalog(
  target: McpTarget,
): Promise<DiscoveredCatalog> {
  return await withMcpSession(target, async (s) => ({
    tools: await s.listTools(),
    iconUrl: pickServerIcon(s.serverInfo()),
  }))
}

/** Execute one tool against a server. */
export async function callRemoteTool(
  target: McpTarget,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  return await withMcpSession(target, (s) => s.callTool(name, args))
}
