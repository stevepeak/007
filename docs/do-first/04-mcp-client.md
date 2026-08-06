# 4 — MCP client support

**Impact: High · Effort: M · Status: greenfield.**

Let 007 consume external **MCP (Model Context Protocol) servers** as tools. This
is the highest-ROI item for closing the connector-breadth gap: instead of
hand-building N connectors (Slack, Notion, HubSpot, GDrive…), one MCP client
integration turns 007's tool node into a gateway to the thousands of tools
already published as MCP servers. MCP is now the de-facto standard tool protocol.

## Current state (audit)

- Tool registry (`engine/tool-registry.ts`) has exactly two entry kinds:
  `'ai-tool'` (a Vercel-AI-SDK `Tool` built from deps) and `'function'` (a plain
  function tool for tool nodes). Both are host-injected, static, in-process.
- No MCP client, transport, or dynamic tool discovery anywhere.

## Design

MCP tools are **discovered at run start**, not authored statically, so the
cleanest fit is a new registry entry kind that *expands* into ai-tools at build
time.

### A. MCP as a tool source

Add a registry entry kind `'mcp-server'` (or a host-level `mcpServers` config on
`WfSdkConfig`):

```ts
{
  kind: 'mcp-server',
  id: 'notion',
  transport: { type: 'http' | 'sse' | 'stdio', url/command, headers? },
  // optional allowlist of tool names to expose
  tools?: string[],
}
```

- The Vercel AI SDK ships an MCP client (`experimental_createMCPClient`) that
  lists a server's tools and adapts them to AI-SDK `Tool`s — reuse it rather than
  implement MCP transport from scratch. Engine stays provider-agnostic; MCP
  client wiring lives in a new `tools/mcp.ts` (SDK built-in tools already live in
  `tools/`, e.g. `tools/tavily.ts`).
- At **run start / manifest resolution**, connect to each referenced MCP server,
  list its tools, and register them into the effective `ToolRegistry` under
  namespaced ids (e.g. `mcp:notion/search`). Freeze the discovered tool list into
  the run manifest so a run replays against a stable tool set even if the server
  later changes (consistent with how agent versions freeze).

### B. Node/authoring surface

- An agent node's `toolIds` can reference `mcp:<server>/<tool>` ids like any
  other tool — no new node kind needed. The tools list UI (`ui/tools-list.tsx`)
  gains an MCP-sourced group.
- Tool metadata (name/icon) — reuse the existing tool name/icon metadata path so
  MCP tools render like native ones in the palette/inspector.

### C. Credentials & transport

- MCP servers often need auth headers / OAuth. Route secrets through a host
  secret store (Cloudflare Secrets Store / Workers secrets) referenced by the
  server config — do **not** persist raw credentials in `wf_*` tables. This
  overlaps with the secrets work needed for connectors generally.
- Transport on Cloudflare Workers: HTTP/SSE MCP servers work directly; `stdio`
  servers do not run in Workers — support HTTP/SSE first, treat stdio as
  local-dev-only.

### D. (Optional, later) 007 as an MCP *server*

Expose published 007 workflows/agents *as* MCP tools so external agents can call
them. Symmetric to A; defer past v1.

## Determinism / durability notes

- MCP tool *discovery* (network `list`) must happen where live bindings exist —
  inside run setup, and the result frozen into the manifest — not at module load.
- A tool *call* to an MCP server is I/O inside a node's `step.do`, already durable
  and retried by the existing execution policy ([01](./01-execution-policy.md)).
- Connection lifecycle: open per-run, close on run finalize; handle a server
  being unreachable via `continueOnError` / fallback semantics already in place.

## Effort & risks

- **M.** Bounded by reusing the AI-SDK MCP client. The real work is
  discovery-into-manifest, namespaced tool ids, and credential plumbing.
- Risk: unbounded/unknown tools from a third-party server — the `tools?`
  allowlist and manifest freeze contain this.
- Risk: latency/reliability of remote MCP servers — mitigated by per-node
  retry/timeout and (if built) fallback.

## Acceptance criteria

- Configuring an HTTP MCP server makes its tools appear (namespaced) in the tool
  palette and callable from an agent node.
- A run using an MCP tool records the call in the step trace and freezes the
  discovered tool set in its manifest.
- A published workflow replays deterministically even after the MCP server's tool
  list changes (manifest freeze holds).
