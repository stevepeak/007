import { tool, type ToolSet } from 'ai'
import { z } from 'zod'

import { strictifyToolSet } from '../engine/strict-schema'
import type { WfDataClient } from '../server/protocol'

import type { WfMcpTool } from './tools'

// The second way to register the tool definitions: as an `ai` `ToolSet`, for a
// caller that runs its own agent loop rather than speaking MCP — today the
// System Copilot.
//
// A tool description is PROMPT. Two hand-maintained lists of the same tools
// would not merely drift in wording, they would drift in behavior, and the
// divergence would be invisible because each list reads fine on its own. So
// there is one list (`server.ts`'s catalog) and two adapters: `registerTool` for
// stdio, this for `streamText`.

/**
 * Build an `ai` ToolSet from tool definitions bound to a data client.
 *
 * `tools` is passed rather than defaulted so the caller states which set it is
 * exposing — and so the read-only gate stays the same one the MCP server uses
 * (`selectTools(allTools(), write)`), not a second judgement about which tools
 * are safe.
 */
export function createWfToolSet(
  client: WfDataClient,
  tools: WfMcpTool[],
): ToolSet {
  const set: ToolSet = {}
  for (const t of tools) {
    set[t.name] = tool({
      description: t.description,
      inputSchema: z.object(t.inputSchema),
      execute: async (args: unknown) => {
        try {
          return await t.run(client, (args ?? {}) as Record<string, unknown>)
        } catch (err) {
          // Returned as a RESULT rather than thrown, matching what the MCP
          // server does with `isError` content: the overwhelmingly common
          // failure is auth or connectivity, which the model can neither fix
          // nor retry blindly, and an agent loop that reads the reason can say
          // so instead of stalling.
          return { error: err instanceof Error ? err.message : String(err) }
        }
      },
    })
  }
  // Same treatment the engine gives an agent's tool set: what the model is shown
  // is the strict JSON Schema dialect, what validates the call is still the zod
  // schema above. Applied here rather than at each definition because this is
  // the adapter that hands these tools to a model — the stdio MCP server speaks
  // its own protocol and is not affected.
  return strictifyToolSet(set)
}
