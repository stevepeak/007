import type { Tool } from 'ai'
import type { z } from 'zod'

// The SDK is generic over an opaque per-run dependency bundle `TDeps`. The host
// supplies `TDeps` (via `WfSdkConfig.buildRunDeps`) and the tools that consume
// it. The engine never inspects `TDeps` — it only threads it from the run
// context into each tool's `build`. This is the seam that keeps the SDK free of
// any provider/vector-store/domain coupling.

// Shared, end-user-facing metadata every tool carries. `id` is the stable key
// referenced by agents/graphs; `name`/`icon`/`description` are what the UI shows
// a human choosing tools — never the raw id.
export type ToolMeta = {
  /** Stable registry key (e.g. `tavily_search`) — referenced by agents. */
  id: string
  /** Human-readable name shown to end users (e.g. "Tavily Web Search"). */
  name: string
  /** One-line description of the service/capability. */
  description: string
  /**
   * Optional inline SVG markup for the tool's brand/icon, rendered in the tool
   * picker. Trusted content (SDK- or host-defined), not user input.
   */
  icon?: string
  /**
   * Zod schema of the tool's input arguments. Surfaced to the workflow editor
   * (converted to JSON Schema) so authors see what a tool *requires* and can map
   * upstream data into each argument. Use `.describe()` on fields to document
   * them for end users.
   */
  inputSchema?: z.ZodType
  /**
   * Zod schema of the value the tool returns. Surfaced to the workflow editor as
   * the mappable shape a downstream node can consume. Use `.describe()` on
   * fields to document them.
   */
  outputSchema?: z.ZodType
}

// AI-tool entries are exposed inside an Agent node's tool set.
// Function entries are called directly as a Tool node (no LLM in the loop).
export type ToolRegistryEntry<TDeps> =
  | (ToolMeta & {
      kind: 'ai-tool'
      build: (deps: TDeps) => Tool
    })
  | (ToolMeta & {
      kind: 'function'
      build: (deps: TDeps) => (args: unknown) => Promise<unknown>
    })

export type ToolRegistry<TDeps> = Map<string, ToolRegistryEntry<TDeps>>

/**
 * Resolves the AI-tool subset of the registry into an AI SDK ToolSet
 * (`Record<string, Tool>`) bound to the given deps. Tool nodes (function kind)
 * are dispatched by `nodes/tool.ts` directly and do not go through this helper.
 */
export function buildAgentToolSet<TDeps>(
  registry: ToolRegistry<TDeps>,
  toolIds: readonly string[],
  deps: TDeps,
): Record<string, Tool> {
  const set: Record<string, Tool> = {}
  for (const id of toolIds) {
    const entry = registry.get(id)
    if (!entry) {
      throw new Error(`Tool '${id}' is not registered.`)
    }
    if (entry.kind !== 'ai-tool') {
      throw new Error(
        `Tool '${id}' is a function tool and cannot be used inside an Agent node.`,
      )
    }
    set[id] = entry.build(deps)
  }
  return set
}
