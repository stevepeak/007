import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { errorMessage } from '../engine/error-message'
import { toText } from '../engine/text'
import type { WfDataClient } from '../server/protocol'

import { allTools, selectTools } from './catalog'
import { docTopics, renderTopic } from './docs/registry'
import type { WfMcpTool } from './tools'
import { WF_MCP_INSTRUCTIONS } from './tools-docs'

// Assembling the MCP server from the tool definitions.
//
// The definitions themselves are in `tools*.ts` and the catalog in
// `catalog.ts`; this file owns only the stdio registration.

// Re-exported: this was their home before `describe.ts` needed the catalog
// without the MCP SDK attached, and every caller still asks the server for it.
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
  // A string is already prose (`get_docs` answers in Markdown). Stringifying it
  // would hand the model one escaped line of `\n`s instead of the page.
  const text = toText(value, { indent: 2, nullText: 'null' })
  return { content: [{ type: 'text', text }] }
}

export function createWfMcpServer(opts: CreateWfMcpServerOptions): McpServer {
  const server = new McpServer(
    { name: 'wf', title: '007 workflows', version: '0.1.0' },
    // Shown to the client before any tool is called — the pointer to
    // `get_docs`, so a session learns the engine before it edits a graph.
    { instructions: WF_MCP_INSTRUCTIONS },
  )

  const tools = selectTools(opts.tools ?? allTools(), opts.write === true)

  for (const t of tools) {
    server.registerTool(
      t.name,
      {
        title: t.title,
        description: t.description,
        // This used to need a cast across a dual-zod boundary: the lockfile
        // resolved one zod for this package and nested another under
        // `@modelcontextprotocol/sdk`, making our `ZodType` and the SDK's
        // `$ZodType` two structurally identical types TS refused to unify. The
        // dependency bump collapsed that, so the raw shape assigns directly —
        // if a future bump splits the copies again, the assignment is where it
        // will show up.
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
          const message = errorMessage(err)
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

  // The same pages as resources, for clients that let a person attach one
  // (an `@`-mention in Claude Code). `get_docs` stays the primary path — resources
  // are not something a model reaches for on its own in most clients.
  for (const topic of docTopics()) {
    const uri = `wf-docs://${topic.id}`
    server.registerResource(
      `docs/${topic.id}`,
      uri,
      { title: topic.title, description: topic.summary, mimeType: 'text/markdown' },
      () => ({
        contents: [
          {
            uri,
            mimeType: 'text/markdown',
            text: renderTopic(topic, tools),
          },
        ],
      }),
    )
  }

  return server
}
