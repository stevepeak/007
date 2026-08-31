import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import type { WfDataClient } from '../server/protocol'

import { readTools, type WfMcpTool } from './tools'

// Assembling the MCP server from the tool definitions.
//
// The write gate is REGISTRATION, not a check inside a handler. A read-only
// session doesn't merely refuse writes — it has no write tools at all, so
// nothing in the model's context suggests one exists and no amount of prompting
// can produce a call to one. Refusing at call time would leave the affordance
// visible and the refusal a matter of the handler being reached.

export type CreateWfMcpServerOptions = {
  client: WfDataClient
  /** Register mutating tools. Off is the default everywhere it is read from. */
  write?: boolean
  /** Override the tool set (tests). Defaults to the built-in catalog. */
  tools?: WfMcpTool[]
}

/** Every tool this build knows about, read and write alike. */
export function allTools(): WfMcpTool[] {
  return [...readTools()]
}

export function selectTools(tools: WfMcpTool[], write: boolean): WfMcpTool[] {
  return write ? tools : tools.filter((t) => t.readOnly)
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
