#!/usr/bin/env bun
/**
 * `wf-mcp` — a Model Context Protocol server over the 007 data API.
 *
 * Ships with @stevepeak/007, so any host gets it with no per-project script. It
 * exposes agents, workflows, runs, feedback (and, behind `--write`, authoring)
 * to an MCP client — Claude Code, Claude Desktop, anything that speaks stdio.
 *
 *   WF_BASE_URL=http://localhost:3000 WF_MCP_TOKEN=… bunx wf-mcp
 *   bunx wf-mcp --base-url=https://app.example.com --token=… --write
 *
 * Env (flags of the same name win):
 *   WF_BASE_URL        origin of the host app, or the full data-API URL
 *   WF_API_PATH        route the SDK handlers are mounted at (default /api/wf)
 *   WF_MCP_TOKEN       bearer credential; matches the host Worker's secret
 *   WF_MCP_TIMEOUT_MS  per-call budget (default 120000)
 *
 * Flags:
 *   --write            also register mutating tools (default: reads only)
 *
 * Register it with Claude Code:
 *
 *   claude mcp add wf --env WF_BASE_URL=http://localhost:3000 \
 *     --env WF_MCP_TOKEN=… -- bunx wf-mcp
 *
 * ── Why HTTP, and not D1 directly ────────────────────────────────────────────
 *
 * `wf-spec` and `wf-dump-run` reach D1 directly, and copying that here would be
 * a mistake. Direct-DB bypasses the dispatcher, and with it the per-method input
 * validation, the `wf_change` audit log, and every host-wired hook. Eval runs in
 * particular are structurally impossible on that path: `startEvalRun` is a HOST
 * hook that needs live Workers bindings and rejects with "not configured"
 * without them. Going through the mounted route keeps all ~70 `WfDataClient`
 * methods working identically, local or remote.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { resolveWfMcpConfig } from '../mcp/config'
import { createWfMcpServer } from '../mcp/server'
import { createHttpWfDataClient } from '../server/http-client'

async function main(): Promise<void> {
  const config = resolveWfMcpConfig(process.argv.slice(2), process.env)

  const client = createHttpWfDataClient({
    baseUrl: config.apiUrl,
    headers: { authorization: `Bearer ${config.token}` },
    timeoutMs: config.timeoutMs,
  })

  const server = createWfMcpServer({ client, write: config.write })

  // stdout is the protocol channel — anything written to it that is not a JSON-RPC
  // frame corrupts the session. Every diagnostic here goes to stderr.
  process.stderr.write(
    `[wf-mcp] ${config.apiUrl} (${config.write ? 'read+write' : 'read-only'})\n`,
  )

  await server.connect(new StdioServerTransport())
}

main().catch((err: unknown) => {
  process.stderr.write(
    `[wf-mcp] ${err instanceof Error ? err.message : String(err)}\n`,
  )
  process.exit(1)
})
