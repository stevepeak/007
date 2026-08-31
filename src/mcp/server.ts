import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import type { WfDataClient } from '../server/protocol'

import { allTools, selectTools } from './catalog'
import type { WfMcpTool } from './tools'

// Assembling the MCP server from the tool definitions.
//
// The definitions themselves are in `tools*.ts` and the catalog in
// `catalog.ts`, shared with the System Copilot — a tool description is prompt,
// and two lists of it would diverge in behavior, not just in wording. This file
// owns only the stdio registration.

// Re-exported: this was their home before the copilot needed them without the
// MCP SDK attached, and every caller still asks the server for its catalog.
export { allTools, selectTools } from './catalog'

export type CreateWfMcpServerOptions = {
  client: WfDataClient
  /** Register mutating tools. Off is the default everywhere it is read from. */
  write?: boolean
  /** Override the tool set (tests). Defaults to the built-in catalog. */
  tools?: WfMcpTool[]
}

/**
 * Render a tool's return value as MCP content.
 *
 * Always JSON, always in a single text block: the value is being read by a
 * model, and a stable envelope is worth more than per-tool prettiness.
 */
function toContent(value: unknown): {
  content: { type: 'text'; text: string }[]
} {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  }
}

export function createWfMcpServer(opts: CreateWfMcpServerOptions): McpServer {
  const server = new McpServer({
    name: 'wf',
    title: '007 workflows',
    version: '0.1.0',
  })

  const tools = selectTools(opts.tools ?? allTools(), opts.write === true)

  for (const t of tools) {
    server.registerTool(
      t.name,
      {
        title: t.title,
        description: t.description,
        inputSchema: t.inputSchema,
        annotations: { readOnlyHint: t.readOnly },
      },
      async (args: Record<string, unknown>) => {
        try {
          return toContent(await t.run(opts.client, args ?? {}))
        } catch (err) {
          // Answered as tool CONTENT rather than thrown, so the model reads the
          // reason and can act on it. The overwhelmingly common failure is an
          // auth or connectivity one, which is not about the arguments at all
          // and needs to be legible as such.
          const message = err instanceof Error ? err.message : String(err)
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `${t.name} failed: ${message}`,
              },
            ],
          }
        }
      },
    )
  }

  return server
}
