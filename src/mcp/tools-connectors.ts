import { z } from 'zod'

import type {
  ConnectorSummary,
  ConnectorToolInfo,
  ToolOption,
  WfToolInvocation,
} from '../server/protocol'

import { clip } from './clip'
import { boundedLimit, optString, reqString, type WfMcpTool } from './tools'

// Connectors — the INBOUND direction: a third party's MCP server whose tools
// this deployment consumes. (The outbound direction, a client connecting to us,
// is what every other file here serves.)
//
// The string "connector" did not appear anywhere under `src/mcp/` before this
// file, against twelve `WfDataClient` methods and a whole console section. The
// consequence was specific rather than merely incomplete: an MCP session could
// already wire an `mcp:<slug>:<tool>` id into an agent — `preflightAgentConfig`
// resolves those happily — while being unable to see which connector it belonged
// to, whether that connector was connected, or what the tool took.
//
// ── The symptom that made this worth building ────────────────────────────────
//
// The tool catalog simply STOPS LISTING a connector tool when its connector is
// disabled or its token expires. So "the Linear tools vanished" and "the Linear
// token expired last Tuesday" produce the identical observation, and only the
// second is actionable. Nothing could tell withdrawn from never-existed.
// `ConnectorConnectionInfo` — status, account, scopes, expiry, error, canRefresh
// — is the answer, and it was already built and already secret-free.
//
// ── The boundary, which is enforced below the MCP ─────────────────────────────
//
// `protocol-connectors.ts`: "Nothing secret crosses this boundary … the token
// itself never leaves the server, not even redacted, because a redacted secret
// in a JSON payload is still a secret one screenshot away from being a real one."
// That is a property of the protocol, not a discipline these tools have to keep,
// so every connector read here inherits it for free. `access_token`,
// `refresh_token`, `WF_CONNECTOR_KEY` and the OAuth state/PKCE verifier cannot
// appear in an MCP payload because they cannot appear in a `ConnectorSummary`.
//
// ── Deliberately NOT here (tools & connectors) ────────────────────────────────
//
//   • Add / edit / delete a connector, and per-tool enable/disable. Enabling a
//     connector tool "is the moment a third party's code becomes callable by an
//     agent" (`ui/connectors/connector-detail.tsx`) — the same consequence class
//     the catalog already withholds `publish_agent` for, and pointing an agent at
//     a URL a model chose is a larger step than publishing a prompt it wrote.
//     A person does this, having read what the server advertises.
//
//   • `start_connector_auth` returns a URL only a browser can complete, and
//     `save_connector_token` takes a raw secret as an ARGUMENT — which is written
//     into a model's context and into the session transcript. That one is
//     disqualified permanently, not pending a design.
//
// `refresh_connector` is the one connector write. It is idempotent, it grants no
// new trust (a tool that was disabled stays disabled, and nothing becomes
// callable that wasn't), it is the fix for the most common connector fault, and
// its `drifted` array is exactly the signal an MCP session wants: the third party
// changed a tool's schema under an agent that still binds the old one.
//
// `run_tool` executes one catalog tool FOR REAL — the console's "Run tool for
// real" playground, over the same host `runToolPreview` hook. The playground's
// gate is a person reading a warning; the gate here is `allowWrite`, which a
// tool tagged `write` (or untagged — the host has not said it is safe) refuses
// to run without. A `read` tool runs on the write surface alone.

/** A connector tool's description is third-party prose and can run long. */
const CONNECTOR_DESC_CHARS = 600

/** Recorded tool args/outputs are real client data; they are read, not dumped. */
const INVOCATION_FIELD_CHARS = 2000

/** A `run_tool` result is real data and can be a whole document. */
const TOOL_OUTPUT_CHARS = 20_000

/** Invocations one call returns. A busy tool has thousands. */
const DEFAULT_INVOCATIONS = 10
const MAX_INVOCATIONS = 50

/**
 * A connector's health, flattened and stated rather than left to be inferred.
 *
 * `connection: null` is a SETUP state — nobody has connected it yet — and reads
 * identically to a broken one unless something says which it is. That
 * distinction is the whole point of the block.
 */
function health(c: ConnectorSummary): Record<string, unknown> {
  const conn = c.connection
  return {
    status: conn?.status ?? 'never-connected',
    accountLabel: conn?.accountLabel ?? null,
    scopes: conn?.scopes ?? null,
    expiresAt:
      conn?.expiresAt == null ? null : new Date(conn.expiresAt).toISOString(),
    // An expiry in the past with `canRefresh: false` is a human sign-in, not
    // something to wait out. Worth computing rather than making the reader
    // compare a timestamp against now.
    expired:
      conn?.expiresAt != null ? conn.expiresAt <= Date.now() : undefined,
    canRefresh: conn?.canRefresh,
    error: conn?.error ?? null,
    diagnosis:
      conn == null
        ? 'Nobody has connected this yet, so none of its tools are callable. A person completes the sign-in in a browser — it cannot be done from here.'
        : conn.status !== 'connected'
          ? `Not connected (${conn.status}), so every one of its tools is withdrawn from the catalog — that is why they "vanished".${conn.canRefresh ? ' It has a refresh token, so refresh_connector may fix it.' : ' It has no refresh token, so a person has to sign in again.'}`
          : c.enabled
            ? undefined
            : 'Connected, but the connector is switched off at the platform level, so its tools are still withdrawn.',
  }
}

/** One discovered tool, with the schema that makes it authorable. */
function toolInfo(t: ConnectorToolInfo): Record<string, unknown> {
  return {
    id: t.id,
    toolName: t.toolName,
    title: t.title,
    // UNTRUSTED third-party prose. Clipped, and never to be treated as
    // instructions to follow.
    description: clip(t.description, CONNECTOR_DESC_CHARS),
    enabled: t.enabled,
    sideEffect: t.sideEffect,
    sideEffectOverridden: t.sideEffectOverridden,
    // Already JSON Schema on the wire from the server — no Zod conversion, so
    // none of the CPU argument behind the host-side strip in `get_tool_catalog`
    // applies here. Nobody had wired the call.
    inputSchema: t.inputSchema,
    outputSchema: t.outputSchema,
    // Set when the server stopped advertising it: the tool is still referenced
    // by whatever bound it, and will now fail.
    missingSince:
      t.missingSince == null ? null : new Date(t.missingSince).toISOString(),
  }
}

export function connectorReadTools(): WfMcpTool[] {
  return [
    {
      name: 'list_connectors',
      title: 'List MCP connectors',
      description: [
        'The third-party MCP servers this deployment consumes tools from, with each one’s CONNECTION HEALTH — status, which account, which scopes were actually granted, when the token expires, and whether it can refresh itself.',
        '',
        'Read this whenever a connector tool is missing from get_tool_catalog or an agent that used to call one has started failing. A connector tool stops being listed at all when its connector is disabled or its credential expires, so "the tools vanished" and "the token expired" are the same observation — and only this call can tell them apart. `diagnosis` says which.',
        '',
        'Pass `connectorId` for one connector’s full discovered tool catalog, including each tool’s `inputSchema` — the argument shape an agent or a Tool node needs, and the thing to compare against when a call started failing after the third party shipped a change.',
        '',
        'No credential ever crosses this boundary — not the token, not a redacted form of it. That is enforced below this tool, not by it.',
      ].join('\n'),
      inputSchema: {
        connectorId: z
          .string()
          .nullish()
          .describe(
            'Drill in: one connector’s full tool catalog with schemas, instead of the list.',
          ),
        includeDisabledTools: z
          .boolean()
          .nullish()
          .describe(
            'With connectorId: include tools that are switched off (default false). A disabled tool is not callable and is not in get_tool_catalog.',
          ),
      },
      readOnly: true,
      run: async (client, args) => {
        const connectorId = optString(args.connectorId)

        if (connectorId) {
          const detail = await client.getConnector({ connectorId })
          if (!detail) {
            return {
              error: `No connector found for id ${connectorId}. Ids come from list_connectors — they are the slug embedded in every one of its tool ids (\`mcp:<slug>:<tool>\`).`,
            }
          }
          const showDisabled = args.includeDisabledTools === true
          const tools = detail.tools.filter((t) => showDisabled || t.enabled)
          return {
            connector: {
              id: detail.connector.id,
              label: detail.connector.label,
              url: detail.connector.url,
              transport: detail.connector.transport,
              authKind: detail.connector.authKind,
              enabled: detail.connector.enabled,
              note: detail.connector.note,
              lastRefreshedAt:
                detail.connector.lastRefreshedAt == null
                  ? null
                  : new Date(detail.connector.lastRefreshedAt).toISOString(),
              toolCount: detail.connector.toolCount,
              enabledToolCount: detail.connector.enabledToolCount,
            },
            health: health(detail.connector),
            tools: tools.map(toolInfo),
            hiddenDisabledTools: showDisabled
              ? undefined
              : detail.tools.length - tools.length || undefined,
            note: 'Only ENABLED tools on an ENABLED, CONNECTED connector appear in get_tool_catalog and can be bound to an agent. Enabling one is a person’s decision — it makes a third party’s code callable by an agent — so it cannot be done from here.',
          }
        }

        const [capability, connectors] = await Promise.all([
          client.getConnectorCapability().catch(() => null),
          client.listConnectors(),
        ])
        return {
          // Stated first because it makes every other row moot: with no
          // encryption key wired, connectors are read-only scaffolding and
          // nothing can be connected at all. Without this, an empty or
          // never-connected list reads as neglect rather than as unconfigured.
          credentialsConfigured: capability?.credentialsConfigured,
          connectors: connectors.map((c) => ({
            id: c.id,
            label: c.label,
            url: c.url,
            enabled: c.enabled,
            toolCount: c.toolCount,
            enabledToolCount: c.enabledToolCount,
            lastRefreshedAt:
              c.lastRefreshedAt == null
                ? null
                : new Date(c.lastRefreshedAt).toISOString(),
            health: health(c),
          })),
          note:
            capability?.credentialsConfigured === false
              ? 'This deployment has no connector encryption key wired, so nothing here can be connected and no connector tool is callable. That is a host configuration fix, not something to resolve from here.'
              : connectors.length === 0
                ? 'No connectors are configured, so every tool in get_tool_catalog is this deployment’s own.'
                : undefined,
        }
      },
    },

    {
      name: 'list_tool_invocations',
      title: 'List tool invocations',
      description: [
        'Recent real calls of one tool, across every run: the arguments it was actually invoked with, what it returned, and whether it failed. The answer to "is this tool being called correctly?" — which otherwise meant paging list_runs and opening each trace to find the one step you wanted.',
        '',
        'Most useful next to a tool’s declared `inputSchema` (get_tool_catalog with `toolIds`): a required argument that is always absent, a literal that is always the wrong shape, or an id being passed where a name was expected shows up here as a pattern rather than as one run’s bad luck. It is also how you check whether a Tool node’s bindings survived a schema change.',
        '',
        'Arguments and outputs are REAL CLIENT DATA from production runs and are truncated here. Read the whole thing with get_run / get_run_step on the `runId`.',
      ].join('\n'),
      inputSchema: {
        toolId: z
          .string()
          .describe(
            'Tool id, from get_tool_catalog. A connector tool is `mcp:<connector>:<tool>`.',
          ),
        limit: z
          .number()
          .nullish()
          .describe(
            `How many calls, newest first (default ${DEFAULT_INVOCATIONS}, max ${MAX_INVOCATIONS}).`,
          ),
      },
      readOnly: true,
      run: async (client, args) => {
        const toolId = reqString(args.toolId, 'toolId')
        const limit = boundedLimit(
          args.limit,
          DEFAULT_INVOCATIONS,
          MAX_INVOCATIONS,
        )
        const rows = await client.listToolInvocations({ toolId, limit })
        return {
          toolId,
          count: rows.length,
          failed: rows.filter((r: WfToolInvocation) => r.error != null).length,
          invocations: rows.map((r: WfToolInvocation) => ({
            runId: r.runId,
            nodeId: r.nodeId,
            workflow: r.workflowName,
            status: r.status,
            error: r.error,
            durationMs:
              r.startedAt != null && r.finishedAt != null
                ? r.finishedAt - r.startedAt
                : null,
            args: clip(r.args, INVOCATION_FIELD_CHARS),
            output: clip(r.output, INVOCATION_FIELD_CHARS),
          })),
          note:
            rows.length === 0
              ? 'This tool has never been called in a recorded run — so nothing here says whether it works, only that nothing has tried.'
              : 'Args and outputs are truncated; get_run_step on a runId reads one in full.',
        }
      },
    },
  ]
}

export function connectorWriteTools(): WfMcpTool[] {
  return [
    {
      name: 'refresh_connector',
      title: 'Refresh a connector',
      description: [
        'Re-read one connector’s `tools/list` from its server and persist what it advertises. Also the fix for an expired credential when the connector holds a refresh token (`canRefresh` in list_connectors).',
        '',
        'Grants no new trust, which is why this is the one connector write that exists: a tool that was switched off stays off, a tool that was on stays on, nothing becomes newly callable, and no credential is read or written by the caller. It is idempotent — running it twice changes nothing the first run didn’t.',
        '',
        '`drifted` is the reason to care. It names the tools whose SCHEMA moved since we last looked — a third party changing an argument under an agent that still binds the old one, which is the ART-146 failure arriving from outside this repo. Those are the tools to re-check with validate_workflow_graph and list_tool_invocations.',
        '',
        '`missing` counts tools the server has stopped advertising. Anything still bound to one of those will fail at its next run, and no amount of refreshing brings it back.',
        '',
        'SLOW: it opens a session to a server we do not control and re-reads its whole catalog.',
      ].join('\n'),
      inputSchema: {
        connectorId: z
          .string()
          .describe('Connector id, from list_connectors.'),
      },
      readOnly: false,
      run: async (client, args) => {
        const connectorId = reqString(args.connectorId, 'connectorId')
        // Read first so a bad id, or a connector nobody has signed into, is a
        // refusal that explains itself rather than a third-party error relayed
        // from a session that could never have opened.
        const before = await client
          .getConnector({ connectorId })
          .catch(() => null)
        if (!before) {
          const all: ConnectorSummary[] = await client
            .listConnectors()
            .catch(() => [])
          return {
            error: `No connector found for id ${connectorId}.`,
            connectorIds: all.map((c) => c.id),
          }
        }
        const result = await client.refreshConnector({ connectorId })
        return {
          connectorId,
          label: before.connector.label,
          refreshedAt: new Date(result.refreshedAt).toISOString(),
          added: result.added,
          updated: result.updated,
          missing: result.missing,
          toolCount: result.toolCount,
          drifted: result.drifted,
          note:
            result.drifted.length > 0
              ? `${result.drifted.length} tool schema(s) changed under us. Anything binding those args may now be wrong — check with validate_workflow_graph, and list_tool_invocations to see what has actually been sent.`
              : result.missing > 0
                ? `${result.missing} tool(s) are no longer advertised by that server. Anything still bound to one will fail at its next run.`
                : 'Nothing drifted and nothing went missing. New tools, if any, arrive DISABLED — a person enables them.',
        }
      },
    },

    {
      name: 'run_tool',
      title: 'Run a tool',
      description: [
        'Execute ONE tool from get_tool_catalog FOR REAL, outside any workflow — the console’s tool playground. Not a simulation: the actual tool runs with the host’s live dependencies, so it can call external services, cost money and change real records. Nothing about a workflow or agent changes, and the call is not recorded as a run.',
        '',
        'Read the tool’s `inputSchema` and `requiresContext` first (get_tool_catalog with `toolIds`). `args` are the tool’s own arguments, validated and defaulted by its schema — the reply’s `args` is what actually ran. `context` is the ambient scope an agent never supplies (for example which client a search is limited to), keyed by the `requiresContext` keys; a tool whose scope is empty usually matches nothing rather than failing.',
        '',
        'A tool tagged `sideEffect: "write"`, or untagged, is refused unless `allowWrite: true`. Only pass that when the user has asked for the effect.',
      ].join('\n'),
      inputSchema: {
        toolId: z
          .string()
          .describe(
            'Tool id, from get_tool_catalog. A connector tool is `mcp:<connector>:<tool>`.',
          ),
        args: z
          .record(z.string(), z.unknown())
          .nullish()
          .describe('The tool’s arguments, matching its inputSchema.'),
        context: z
          .record(z.string(), z.string())
          .nullish()
          .describe(
            'Values for the tool’s `requiresContext` keys, as get_tool_catalog lists them.',
          ),
        allowWrite: z
          .boolean()
          .nullish()
          .describe(
            'Required true to run a tool whose sideEffect is "write" or untagged. Default false.',
          ),
      },
      readOnly: false,
      run: async (client, args) => {
        const toolId = reqString(args.toolId, 'toolId')
        const tool = (await client.listTools()).find(
          (t: ToolOption) => t.id === toolId,
        )
        if (!tool) {
          return {
            error: `No tool in the catalog with id ${toolId}. get_tool_catalog lists them; a connector tool disappears when its connector is disconnected — list_connectors says which.`,
          }
        }
        if (tool.sideEffect !== 'read' && args.allowWrite !== true) {
          return {
            error: `${toolId} is ${tool.sideEffect === 'write' ? 'tagged as a WRITE' : 'untagged, so not known to be safe'} — running it may change real records or call external services. Pass allowWrite: true only if the user asked for that effect.`,
            sideEffect: tool.sideEffect ?? null,
          }
        }

        const context = stringRecord(args.context)
        const required = (tool.requiresContext ?? []).length > 0
          ? (await client.listToolContextFields().catch(() => []))
              .filter(
                (f) => f.required === true &&
                  (tool.requiresContext ?? []).includes(f.key),
              )
              .map((f) => f.key)
          : []
        const missingContext = required.filter((k) => !Object.hasOwn(context, k))
        if (missingContext.length > 0) {
          return {
            error: `Missing required context: ${missingContext.join(', ')}. get_tool_catalog with toolIds describes each key.`,
          }
        }

        const toolArgs =
          args.args && typeof args.args === 'object' && !Array.isArray(args.args)
            ? (args.args as Record<string, unknown>)
            : {}
        try {
          const result = await client.runToolPreview({
            toolId,
            args: toolArgs,
            context,
          })
          return {
            toolId,
            sideEffect: tool.sideEffect ?? null,
            durationMs: result.durationMs,
            args: result.args,
            output: clip(result.output, TOOL_OUTPUT_CHARS),
          }
        } catch (err) {
          // A schema rejection or the tool's own throw — the reader's next move
          // is to fix the args, so it is an answer, not a transport failure.
          return {
            toolId,
            error: err instanceof Error ? err.message : String(err),
          }
        }
      },
    },
  ]
}

/** A context bag — strings only, as the handler maps them into the run scope. */
function stringRecord(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string' && v.length > 0) out[k] = v
  }
  return out
}
