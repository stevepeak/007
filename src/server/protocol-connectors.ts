import type { JsonSchema } from '../engine/agent-output'
import type {
  WfConnectionStatus,
  WfConnectorAuthKind,
  WfConnectorTransport,
} from '../storage/schema'

// Wire shapes for MCP connectors — the INBOUND direction (a remote server whose
// tools we consume), as distinct from `../mcp`, which is how a client connects
// to us.
//
// Nothing secret crosses this boundary. A connection is described by its status
// and who it belongs to; the token itself never leaves the server, not even
// redacted, because a redacted secret in a JSON payload is still a secret one
// screenshot away from being a real one.

export type { WfConnectionStatus, WfConnectorAuthKind, WfConnectorTransport }

/** How a connector's credential currently stands. */
export type ConnectorConnectionInfo = {
  status: WfConnectionStatus
  /** Who we're connected as, when the grant told us. */
  accountLabel: string | null
  /** Scopes the server actually granted — may be narrower than requested. */
  scopes: string | null
  /** When the access token expires. Null = no stated expiry (e.g. an API key). */
  expiresAt: number | null
  /** Why the connection is not `connected`, when it isn't. */
  error: string | null
  connectedAt: number | null
  /** Whether a refresh token exists, i.e. whether expiry is self-healing. */
  canRefresh: boolean
}

/** One connector, as the list page shows it. */
export type ConnectorSummary = {
  id: string
  label: string
  url: string
  transport: WfConnectorTransport
  authKind: WfConnectorAuthKind
  scopes: string | null
  enabled: boolean
  icon: string | null
  iconName: string | null
  color: string | null
  note: string | null
  lastRefreshedAt: number | null
  /** Null when nobody has connected it yet — a setup state, not a failure. */
  connection: ConnectorConnectionInfo | null
  toolCount: number
  enabledToolCount: number
}

/** One discovered tool, as the connector detail page shows it. */
export type ConnectorToolInfo = {
  /** The namespaced `mcp:<connector>:<tool>` id agents reference. */
  id: string
  toolName: string
  title: string | null
  /**
   * The server's own description. UNTRUSTED text authored by a third party and
   * shown to both a human and (when enabled) a model — render as text, never as
   * markup.
   */
  description: string | null
  inputSchema: JsonSchema | undefined
  outputSchema: JsonSchema | undefined
  enabled: boolean
  sideEffect: 'read' | 'write'
  /** True when a human set `sideEffect` by hand; a refresh then leaves it be. */
  sideEffectOverridden: boolean
  /** Set when the server stopped advertising this tool. */
  missingSince: number | null
  lastSeenAt: number | null
  schemaHash: string
}

export type ConnectorDetail = {
  connector: ConnectorSummary
  tools: ConnectorToolInfo[]
}

/** What a catalog refresh changed. Reported back so the UI can say so. */
export type ConnectorRefreshResult = {
  refreshedAt: number
  added: number
  updated: number
  missing: number
  /** Tools whose schema moved since we last looked — the drift signal. */
  drifted: string[]
  toolCount: number
}

/** Whether this deployment can store connector credentials at all. */
export type ConnectorCapability = {
  /**
   * False when the host wired no encryption key. Connectors are then read-only
   * scaffolding: nothing can be connected, and the page says what to wire
   * rather than failing at the moment someone presses Connect.
   */
  credentialsConfigured: boolean
}
