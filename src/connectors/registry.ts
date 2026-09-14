import { Validator } from '@cfworker/json-schema'
import { jsonSchema, tool } from 'ai'

import type {
  ToolRegistry,
  ToolRegistryEntry,
} from '../engine/tool-registry'
import type { WfDb } from '../storage/client'
import {
  getConnection,
  listEnabledConnectorTools,
  setConnectionStatus,
} from '../storage/data/connectors'

import { callRemoteTool, McpUnauthorizedError, type McpTarget } from './client'
import { resolveAccessToken } from './oauth'

// Connector tools, as the engine already understands tools.
//
// The engine resolves every tool through `ToolRegistry` — a plain `Map` the
// host injects at module scope. Connector tools can't live there: they are
// discovered at runtime and change without a deploy. Rather than thread an
// async resolver through the executor (and through `nodes/tool.ts`,
// `nodes/agent.ts`, the subgraph path, the playground…), this module builds
// ordinary registry entries from the catalog and MERGES them into the Map once
// per run. Nothing downstream changes: `registry.get(id)` keeps working, and a
// connector tool is indistinguishable from a host tool at the point of use.
//
// They are registered as `ai-tool` rather than `function` because that kind
// works in BOTH places — an agent's tool set uses it directly, and a Tool node
// invokes the same `execute` with its bound args (see `nodes/tool.ts`). A
// `function` entry would be usable only as a Tool node.

/**
 * A catalog entry, flattened to plain JSON.
 *
 * Deliberately serializable: on Cloudflare this is loaded inside a durable step
 * and therefore has to survive the journal. It carries NO credential — the
 * token is resolved lazily at call time, inside the node's own step, where a
 * live D1 binding is legal.
 */
export type ConnectorCatalogEntry = {
  /** The namespaced `mcp:<connector>:<tool>` id. */
  id: string
  connectorId: string
  connectorLabel: string
  connectorUrl: string
  transport: 'http' | 'sse'
  toolName: string
  title: string | null
  description: string | null
  inputSchema: unknown
  outputSchema: unknown
  sideEffect: 'read' | 'write'
  /** Frozen into the run so drift against the live server is detectable. */
  schemaHash: string
  icon: string | null
  iconName: string | null
  color: string | null
}

/**
 * Snapshot every callable connector tool.
 *
 * Called once per run (and once per editor request), never per node — a graph
 * of forty nodes must not mean forty catalog reads.
 */
export async function loadConnectorCatalog(
  db: WfDb,
): Promise<ConnectorCatalogEntry[]> {
  const rows = await listEnabledConnectorTools(db)
  return rows.map(({ tool: t, connector: c }) => ({
    id: t.id,
    connectorId: c.id,
    connectorLabel: c.label,
    connectorUrl: c.url,
    transport: c.transport,
    toolName: t.toolName,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    outputSchema: t.outputSchema,
    sideEffect: t.sideEffect,
    schemaHash: t.schemaHash,
    icon: c.icon,
    iconName: c.iconName,
    color: c.color,
  }))
}

export type ConnectorRuntime = {
  /**
   * A live `WfDb`. A function, not a handle: on Cloudflare a D1 binding cannot
   * cross a durable step boundary, so the client has to be constructed inside
   * the step that uses it — which is exactly when this is called.
   */
  resolveDb: () => WfDb
  /** The credential encryption key. See `./crypto`. */
  resolveSecret: () => string | Promise<string>
  /** Per-call timeout for the remote server. */
  timeoutMs?: number
}

/**
 * The arguments a connector tool was actually given, validated against the
 * server's own JSON Schema.
 *
 * Connector tools carry JSON Schema, not Zod, so they can't use the Tool node's
 * `inputSchema.parse()` path — which means bad bindings would otherwise reach
 * the server as-is and come back as an opaque remote error. Validating here
 * turns published-node arg drift into a message that names the field, and it
 * reuses the same eval-free validator the MCP client does (workerd forbids the
 * codegen Ajv relies on).
 */
function validateArgs(
  entry: ConnectorCatalogEntry,
  args: Record<string, unknown>,
): void {
  if (!entry.inputSchema || typeof entry.inputSchema !== 'object') return
  const result = new Validator(
    entry.inputSchema,
    '2020-12',
    false,
  ).validate(args)
  if (result.valid) return
  const detail = result.errors
    .map((e) => `${e.instanceLocation} ${e.error}`)
    .join('; ')
  throw new Error(
    `Arguments for '${entry.id}' do not match what ${entry.connectorLabel} expects: ${detail}. ` +
      `The tool's schema may have changed since this node was published.`,
  )
}

/** Build one registry entry for one catalog row. */
function toRegistryEntry<TDeps>(
  entry: ConnectorCatalogEntry,
  runtime: ConnectorRuntime,
): ToolRegistryEntry<TDeps> {
  const execute = async (args: Record<string, unknown>): Promise<unknown> => {
    validateArgs(entry, args)
    const db = runtime.resolveDb()
    const secret = await runtime.resolveSecret()
    const connector = {
      id: entry.connectorId,
      label: entry.connectorLabel,
      url: entry.connectorUrl,
    }

    const credential = await resolveAccessToken({
      db,
      // `resolveAccessToken` reads only these three fields off the row.
      connector: connector as Parameters<
        typeof resolveAccessToken
      >[0]['connector'],
      secret,
    })
    if (!credential) {
      throw new McpUnauthorizedError(
        `${entry.connectorLabel} is not connected. Connect it from the connectors page.`,
      )
    }

    const target: McpTarget = {
      url: entry.connectorUrl,
      transport: entry.transport,
      auth: {
        kind: 'bearer',
        token: credential.token,
        tokenType: credential.tokenType,
      },
      timeoutMs: runtime.timeoutMs,
    }

    try {
      return await callRemoteTool(target, entry.toolName, args)
    } catch (err) {
      // A 401 here is the credential going bad mid-life (revoked upstream, or
      // an expiry the server never told us about). Record it so the connectors
      // page offers Reconnect, instead of every run failing anonymously.
      if (err instanceof McpUnauthorizedError) {
        const connection = await getConnection(db, entry.connectorId)
        if (connection) {
          await setConnectionStatus(db, {
            connectionId: connection.id,
            status: 'expired',
            error: err.message,
          })
        }
      }
      throw err
    }
  }

  return {
    id: entry.id,
    // The connector's name leads, so a picker full of generic verbs
    // ("create_issue", "search") still says whose they are.
    name: `${entry.connectorLabel}: ${entry.title ?? entry.toolName}`,
    // The server's own description, verbatim — it is what MCP intends the model
    // to read. UNTRUSTED text: see the trust-boundary note in AGENTS.md.
    description: entry.description ?? `${entry.toolName} via ${entry.connectorLabel}`,
    icon: entry.icon ?? undefined,
    iconName: entry.iconName ?? undefined,
    color: entry.color ?? undefined,
    sideEffect: entry.sideEffect,
    // Authored by neither side: the SDK ships the plumbing, the host wires the
    // key, but the tool itself belongs to a third party. `sdk` is the closer of
    // the two — a deployment cannot fix its behaviour by editing this repo.
    origin: 'sdk',
    statusLabel: `Using ${entry.connectorLabel}`,
    kind: 'ai-tool',
    build: () =>
      tool({
        description:
          entry.description ?? `${entry.toolName} via ${entry.connectorLabel}`,
        inputSchema: jsonSchema(
          (entry.inputSchema as Record<string, unknown> | null) ?? {
            type: 'object',
            properties: {},
          },
        ),
        execute: (args: unknown) => execute(args as Record<string, unknown>),
      }),
  }
}

/** Registry entries for a whole catalog snapshot. */
export function connectorToolEntries<TDeps>(
  catalog: ConnectorCatalogEntry[],
  runtime: ConnectorRuntime,
): ToolRegistryEntry<TDeps>[] {
  return catalog.map((entry) => toRegistryEntry<TDeps>(entry, runtime))
}

/**
 * A config whose tool registry also contains the connector tools.
 *
 * Returns a NEW config and a NEW Map — the host's registry is module-scope
 * state shared by every run in the isolate, and mutating it would leak one
 * run's catalog snapshot into the next.
 *
 * Host tools win on a collision. That can only happen if a host registers an id
 * starting `mcp:`, which the namespacing exists to prevent; if someone does it
 * anyway, the tool they wrote and can debug is the safer one to keep.
 */
export function withConnectorTools<
  TDeps,
  TConfig extends { toolRegistry: ToolRegistry<TDeps> },
>(
  config: TConfig,
  catalog: ConnectorCatalogEntry[],
  runtime: ConnectorRuntime,
): TConfig {
  if (catalog.length === 0) return config
  const merged: ToolRegistry<TDeps> = new Map(config.toolRegistry)
  for (const entry of connectorToolEntries<TDeps>(catalog, runtime)) {
    if (!merged.has(entry.id)) merged.set(entry.id, entry)
  }
  return { ...config, toolRegistry: merged }
}
