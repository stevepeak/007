import { index, integer, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core'

import { createdAt } from './schema-common'

// ── MCP connectors ───────────────────────────────────────────────────────
// The INBOUND direction: a remote MCP server whose tools this deployment
// consumes. Not to be confused with `src/mcp/`, which is the outbound half —
// how an external client (Claude, Cursor) points itself at *us*.
//
// The shape follows `wf_model_provider` / `wf_model` deliberately: a connector
// is the configured service, its tools are a CACHED CATALOG refreshed from the
// server's `tools/list`, and each tool carries its own `enabled` flag that a
// human curates. A refresh inserts new tools DISABLED and preserves the flag on
// existing ones, so pulling a server's catalog can never silently widen what an
// agent is allowed to call.
//
// Where it departs from the model catalog is credentials. `wf_model_provider`
// says "credentials live in the host env, never here", and that holds for a key
// an operator pastes into wrangler. It cannot hold for OAuth: the token is
// minted by a user clicking Connect and rotates on refresh, so it has to be
// durable. Every secret column below is therefore ENCRYPTED at rest (AES-GCM,
// `../connectors/crypto`) with a key the host injects — the SDK stores
// ciphertext and never sees the key material at rest.

/** Wire transport. Streamable HTTP is current; `sse` is the legacy fallback. */
export const WF_CONNECTOR_TRANSPORTS = ['http', 'sse'] as const
export type WfConnectorTransport = (typeof WF_CONNECTOR_TRANSPORTS)[number]

/**
 * How we authenticate to the server.
 *   oauth2 — the real thing: discovery → registration → PKCE → refresh.
 *   bearer — a pasted API key / PAT. Many MCP servers accept one (Linear does),
 *            and it is the only option for servers that publish no OAuth
 *            metadata at all.
 *   none   — an open server (rare; local/dev).
 */
export const WF_CONNECTOR_AUTH_KINDS = ['oauth2', 'bearer', 'none'] as const
export type WfConnectorAuthKind = (typeof WF_CONNECTOR_AUTH_KINDS)[number]

/**
 * A connection's health, as the UI reports it.
 *
 * `expired` is a first-class state rather than an error string because it is
 * the one an operator can FIX, and the fix is a single button. A 401 from the
 * server flips a connection here, so the tool stops failing anonymously inside
 * runs and starts saying "Reconnect" on the connectors page.
 */
export const WF_CONNECTION_STATUSES = [
  'connected',
  'expired',
  'revoked',
  'error',
] as const
export type WfConnectionStatus = (typeof WF_CONNECTION_STATUSES)[number]

/**
 * Who a connection belongs to.
 *
 * v1 only ever writes `workspace`: 007 has no tenant column, and runs are
 * frequently unattended (cron, ingest, evals), so a per-user token would make
 * "does this tool work" depend on who happened to trigger the run. The column
 * exists from day one so per-user connections are a later feature rather than a
 * later migration.
 */
export const WF_CONNECTION_OWNER_SCOPES = ['workspace', 'user'] as const
export type WfConnectionOwnerScope =
  (typeof WF_CONNECTION_OWNER_SCOPES)[number]

/** The sentinel `owner_id` for a workspace-scoped connection. */
export const WF_CONNECTION_WORKSPACE_OWNER = ''

// A configured remote MCP server.
//
// `id` IS the slug, and it is permanent: it appears inside every tool id
// (`mcp:<id>:<tool>`), which is in turn frozen into published agent configs and
// run manifests. `label` is the display name and is free to change. Same
// contract as `wf_model_provider.id` ('openrouter'), for the same reason.
export const wfConnector = sqliteTable('wf_connector', {
  id: text('id').primaryKey(),
  label: text('label').notNull(),
  /** Absolute https endpoint, e.g. `https://mcp.linear.app/mcp`. */
  url: text('url').notNull(),
  transport: text('transport', { enum: WF_CONNECTOR_TRANSPORTS })
    .notNull()
    .default('http'),
  authKind: text('auth_kind', { enum: WF_CONNECTOR_AUTH_KINDS })
    .notNull()
    .default('oauth2'),
  /**
   * OAuth scopes to request at authorization, space-separated. Narrowing this
   * is the strongest control available — a token issued for `read` cannot reach
   * a write API no matter what the UI or the model does. Null → ask for the
   * server's advertised default.
   */
  scopes: text('scopes'),
  /** Platform-level off switch. Disabling hides every tool from the resolver. */
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  /** Inline SVG brand mark, mirroring `ToolMeta.icon`. Trusted, admin-set. */
  icon: text('icon'),
  /** Lucide icon name + palette color, for connectors with no brand SVG. */
  iconName: text('icon_name'),
  color: text('color'),
  /**
   * The icon the server advertised about itself on `initialize`
   * (`serverInfo.icons[].src`, MCP 2025-11-25+): an https URL or a
   * `data:image/*` URI. Rewritten on every Refresh so it tracks the server —
   * and cleared when the server stops sending one. UNTRUSTED third-party
   * content: rendered only ever as an `<img src>`, never inlined like `icon`.
   * The fallback behind the admin-set `icon` / `iconName`.
   */
  iconUrl: text('icon_url'),
  note: text('note'),
  lastRefreshedAt: integer('last_refreshed_at', { mode: 'timestamp' }),
  createdAt: createdAt(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }),
})

// One credential for one connector.
//
// Everything secret here is ciphertext. `tokenVersion` is the concurrency
// guard: a refresh writes `where token_version = <the value it read>`, so when
// two nodes in the same run both notice an expired token, exactly one of them
// wins and the loser re-reads the row the winner just wrote instead of burning
// a single-use refresh token twice.
export const wfConnectorConnection = sqliteTable(
  'wf_connector_connection',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    connectorId: text('connector_id').notNull(),
    ownerScope: text('owner_scope', { enum: WF_CONNECTION_OWNER_SCOPES })
      .notNull()
      .default('workspace'),
    /** Host user id for `user` scope; `''` for `workspace`. Opaque to the SDK. */
    ownerId: text('owner_id').notNull().default(WF_CONNECTION_WORKSPACE_OWNER),
    /** AES-GCM ciphertext. Never logged, never returned over the wire. */
    accessToken: text('access_token').notNull(),
    /** AES-GCM ciphertext. Null when the server issues no refresh token. */
    refreshToken: text('refresh_token'),
    tokenType: text('token_type').notNull().default('Bearer'),
    expiresAt: integer('expires_at', { mode: 'timestamp' }),
    /** Scopes the server actually GRANTED, which may be narrower than asked. */
    scopes: text('scopes'),
    /** Who we're connected as, for the UI. Best-effort, from the token grant. */
    accountLabel: text('account_label'),
    status: text('status', { enum: WF_CONNECTION_STATUSES })
      .notNull()
      .default('connected'),
    /** Last failure reason, shown next to a non-`connected` status. */
    lastError: text('last_error'),
    /** Optimistic-concurrency counter for token refresh. See the note above. */
    tokenVersion: integer('token_version').notNull().default(0),
    /** Who pressed Connect. Attribution only. */
    connectedBy: text('connected_by'),
    createdAt: createdAt(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }),
  },
  (t) => [
    // One connection per (connector, owner). Reconnecting updates in place, so
    // a re-auth can never leave two live credentials racing each other.
    unique('wf_connector_connection_owner_idx').on(
      t.connectorId,
      t.ownerScope,
      t.ownerId,
    ),
  ],
)

// The discovered tool catalog — one row per tool the server advertised.
//
// `id` is the namespaced `mcp:<connectorId>:<toolName>`, which is what agents
// and Tool nodes reference. Namespacing is what makes a connector tool unable to
// collide with a host registry tool, and lets the connector be recovered from
// the id alone when resolving a frozen manifest.
export const wfConnectorTool = sqliteTable(
  'wf_connector_tool',
  {
    id: text('id').primaryKey(),
    connectorId: text('connector_id').notNull(),
    /** The server's own tool name, as sent in `tools/call`. */
    toolName: text('tool_name').notNull(),
    title: text('title'),
    /**
     * The server's description. UNTRUSTED text that reaches the model — render
     * it as text, never as markup, and never let it reach a system prompt
     * unlabelled. See the trust-boundary note in AGENTS.md.
     */
    description: text('description'),
    /** JSON Schema, verbatim from `tools/list`. Already JSON — no zod round trip. */
    inputSchema: text('input_schema', { mode: 'json' }),
    outputSchema: text('output_schema', { mode: 'json' }),
    /** The tool's MCP annotations (`readOnlyHint`, `destructiveHint`, …). */
    annotations: text('annotations', { mode: 'json' }),
    /**
     * Effective side-effect classification, derived from `annotations` on
     * refresh (`readOnlyHint: true` → read, everything else → write) unless an
     * admin has overridden it. Write is the safe default: evals simulate it and
     * the playground warns before running it for real.
     */
    sideEffect: text('side_effect', { enum: ['read', 'write'] })
      .notNull()
      .default('write'),
    /** Set when a human overrode the derived classification — a refresh then
     * leaves `side_effect` alone rather than reverting their decision. */
    sideEffectOverridden: integer('side_effect_overridden', { mode: 'boolean' })
      .notNull()
      .default(false),
    /** Curation flag. New tools arrive disabled; a refresh preserves this. */
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
    /**
     * Hash of the input+output schema as last seen. A run manifest freezes this
     * so a Tool node whose bound args were authored against an older shape can
     * be flagged instead of silently passing arguments the server now rejects.
     */
    schemaHash: text('schema_hash').notNull(),
    lastSeenAt: integer('last_seen_at', { mode: 'timestamp' }),
    /**
     * When the tool stopped appearing in the server's catalog. The row is kept
     * rather than deleted: an agent may still reference it, and "this tool was
     * withdrawn by the server" is a far better answer than a missing id.
     */
    missingSince: integer('missing_since', { mode: 'timestamp' }),
    createdAt: createdAt(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }),
  },
  (t) => [
    index('wf_connector_tool_connector_idx').on(t.connectorId),
    index('wf_connector_tool_enabled_idx').on(t.enabled),
  ],
)

// The OAuth client this deployment registered with one connector's
// authorization server (RFC 7591 dynamic client registration).
//
// Its own table because registration happens ONCE per connector and outlives
// every individual connection: disconnecting and reconnecting must not burn a
// new client registration, and a client secret is a different secret with a
// different lifetime than an access token.
export const wfConnectorClient = sqliteTable('wf_connector_client', {
  connectorId: text('connector_id').primaryKey(),
  clientId: text('client_id').notNull(),
  /** AES-GCM ciphertext. Null for a public client (PKCE, no secret). */
  clientSecret: text('client_secret'),
  /** The redirect URI registered with the AS — must match at authorization. */
  redirectUri: text('redirect_uri').notNull(),
  /** Issuer the registration belongs to; a changed issuer invalidates it. */
  issuer: text('issuer'),
  /** The full registration response, for fields we don't model yet. */
  raw: text('raw', { mode: 'json' }),
  createdAt: createdAt(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }),
})

// In-flight authorization attempts.
//
// Short-lived by construction: a row is written when the user is sent to the
// authorization server and DELETED the moment it is redeemed, so `state` is
// single-use and a replayed callback finds nothing. `expiresAt` sweeps the
// abandoned ones (the user closed the tab).
export const wfConnectorOauthState = sqliteTable('wf_connector_oauth_state', {
  /** The opaque `state` parameter — high-entropy, generated per attempt. */
  state: text('state').primaryKey(),
  connectorId: text('connector_id').notNull(),
  /** AES-GCM ciphertext of the PKCE verifier. */
  codeVerifier: text('code_verifier').notNull(),
  redirectUri: text('redirect_uri').notNull(),
  /** Where to send the browser once the exchange completes. */
  returnTo: text('return_to'),
  /** Resolved AS endpoints, so the callback needn't re-run discovery. */
  tokenEndpoint: text('token_endpoint').notNull(),
  issuer: text('issuer'),
  scopes: text('scopes'),
  /** Who started the flow — recorded on the resulting connection. */
  userId: text('user_id'),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  createdAt: createdAt(),
})
