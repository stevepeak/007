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
// It lives in `engine` — the bottom layer — and imports nothing, because
// `connectors`, `storage` and `server` all have to agree on what a tool id
// means and none of them should have to depend on another to do it. Held in
// `connectors/` it made `storage → connectors → storage` a real cycle, since
// `storage/data/connectors.ts` mints ids while `connectors/client.ts` reads the
// rows back.

import { sha256Hex } from './sha256'
import { slugify } from './slug'
import { stableStringify } from './stable-stringify'

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
  const slug = slugify({ text: label, sep: '-', max: 63, fallback: 'connector' })
  // The cut at 63 can land on a dash; it is trimmed.
  return slug.replace(/-+$/, '')
}

/** Build the namespaced id an agent or Tool node references. */
export function connectorToolId(connectorId: string, toolName: string): string {
  return `${CONNECTOR_TOOL_PREFIX}:${connectorId}:${toolName}`
}

/**
 * The id that attaches a WHOLE connector to an agent — `mcp:<connectorId>:*`.
 * A connector is one kind of tool group; see {@link groupWildcardToolId}.
 */
export function connectorWildcardToolId(connectorId: string): string {
  return groupWildcardToolId(connectorGroup(connectorId))
}

// Tool groups.
//
// A group is the prefix of a tool id up to its last structural `:` — a
// connector's tools share `mcp:<connectorId>`, and a host tool registered as
// `<group>:<name>` (e.g. `app:list_tags`) shares `<group>`. Like a connector,
// the group is recoverable from the id ALONE, so a frozen config still says
// what `<group>:*` meant without a lookup. `<group>:*` attaches the whole
// group: expanded at run time to every tool in it (see `resolveAgentToolIds`),
// so tools added later reach the agent without anyone editing it. `*` cannot
// be a real tool name: MCP limits names to `[A-Za-z0-9_.-]`, and host groups
// follow {@link CONNECTOR_ID_PATTERN}.

/** The group a connector's tools share — `mcp:<connectorId>`. */
export function connectorGroup(connectorId: string): string {
  return `${CONNECTOR_TOOL_PREFIX}:${connectorId}`
}

/**
 * The group a tool id belongs to — `mcp:<connectorId>` for a connector tool,
 * `<group>` for a host tool registered as `<group>:<name>` — or null for an
 * ungrouped id.
 */
export function toolGroupOf(id: string): string | null {
  const connector = parseConnectorToolId(id)
  if (connector) return connectorGroup(connector.connectorId)
  if (isConnectorToolId(id)) return null
  const split = id.indexOf(':')
  if (split <= 0) return null
  const group = id.slice(0, split)
  return CONNECTOR_ID_PATTERN.test(group) ? group : null
}

/** The id that attaches a whole group — `<group>:*`. */
export function groupWildcardToolId(group: string): string {
  return `${group}:*`
}

/** The group a `<group>:*` id attaches, or null if it isn't one. */
export function parseGroupWildcard(id: string): string | null {
  return id.endsWith(':*') ? toolGroupOf(id) : null
}

/** The connector a group belongs to, or null for a host group. */
export function connectorOfGroup(group: string): string | null {
  return group.startsWith(`${CONNECTOR_TOOL_PREFIX}:`)
    ? group.slice(CONNECTOR_TOOL_PREFIX.length + 1)
    : null
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
  // Object keys sorted at every depth, so two schemas that differ only in key
  // order hash the same — without that a server which serialises its schema
  // non-deterministically would report drift on every single refresh and the
  // signal would be worth nothing.
  const canonical = stableStringify({
    input: input.inputSchema ?? null,
    output: input.outputSchema ?? null,
  })
  return await sha256Hex({ text: canonical, bytes: 16 })
}
