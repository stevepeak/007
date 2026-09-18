// Connector tool identity.
//
// A connector tool's id is `mcp:<connectorId>:<toolName>`. Three properties of
// that shape are load-bearing:
//
//   • It cannot collide with a host registry tool id, so the resolver can check
//     the static registry first and fall through without ambiguity.
//   • The connector is recoverable from the id ALONE. That matters when reading
//     a frozen run manifest or a published agent config months later — the row
//     may have been renamed or deleted, and the id still says where it came
//     from.
//   • It reads as itself in an agent config. `mcp:linear:create_issue` needs no
//     lookup to understand in a diff.
//
// This module is deliberately free of storage and engine imports: both sides
// depend on it, and neither should have to depend on the other to agree on what
// a tool id means.

/** Namespace every connector tool id carries. */
export const CONNECTOR_TOOL_PREFIX = 'mcp'

/**
 * Legal connector id / slug: lowercase alphanumerics and dashes. Constrained
 * because it is embedded in a `:`-delimited tool id — a slug containing `:`
 * would make the id ambiguous to parse.
 */
export const CONNECTOR_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/

/**
 * Derive a connector id from its label — "Linear (prod)" → `linear-prod`.
 *
 * Nobody types an id: it is internal, permanent (embedded in every tool id),
 * and there is nothing a human could choose that beats the label's slug. A
 * label with no usable characters falls back to `connector`, so the result
 * always satisfies {@link CONNECTOR_ID_PATTERN}.
 */
export function slugifyConnectorId(label: string): string {
  const slug = label
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/, '')
  return slug.length > 0 ? slug : 'connector'
}

/** Build the namespaced id an agent or Tool node references. */
export function connectorToolId(connectorId: string, toolName: string): string {
  return `${CONNECTOR_TOOL_PREFIX}:${connectorId}:${toolName}`
}

/** Whether an id belongs to a connector (vs. the host's static registry). */
export function isConnectorToolId(id: string): boolean {
  return id.startsWith(`${CONNECTOR_TOOL_PREFIX}:`)
}

/**
 * Split a connector tool id back into its parts, or null if it isn't one.
 *
 * The tool name is everything after the SECOND colon, un-split: MCP tool names
 * are server-chosen and nothing in the spec forbids a colon in one. The
 * connector id is constrained (see {@link CONNECTOR_ID_PATTERN}), so the first
 * two segments are unambiguous and the rest belongs to the server.
 */
export function parseConnectorToolId(
  id: string,
): { connectorId: string; toolName: string } | null {
  if (!isConnectorToolId(id)) return null
  const rest = id.slice(CONNECTOR_TOOL_PREFIX.length + 1)
  const split = rest.indexOf(':')
  if (split <= 0) return null
  const connectorId = rest.slice(0, split)
  const toolName = rest.slice(split + 1)
  if (!connectorId || !toolName) return null
  return { connectorId, toolName }
}

/**
 * Stable JSON: object keys sorted at every depth, so two schemas that differ
 * only in key order hash the same. Without this a server that serialises its
 * schema non-deterministically would report drift on every single refresh, and
 * the drift signal would be worth nothing.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
  return `{${entries.join(',')}}`
}

/**
 * Fingerprint a tool's input+output schema.
 *
 * Recorded per tool on refresh and frozen into the run manifest, so a Tool node
 * whose arguments were bound against an older shape can be flagged rather than
 * silently sending arguments the server now rejects. Remote schemas change
 * without warning and nobody here controls the release — this is the only
 * signal that they did.
 */
export async function schemaHash(input: {
  inputSchema?: unknown
  outputSchema?: unknown
}): Promise<string> {
  const canonical = stableStringify({
    input: input.inputSchema ?? null,
    output: input.outputSchema ?? null,
  })
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonical),
  )
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32)
}
