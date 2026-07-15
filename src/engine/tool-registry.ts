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
  /**
   * Side-effect classification, consulted ONLY under `simulate` (evals). `write`
   * → the tool no-ops with a canned marker; `read` → the tool returns the run's
   * fixture for this id (or `{}`). Untagged tools run for real even under
   * simulate — reserve that for pure/compute tools with no external effect.
   */
  sideEffect?: ToolSideEffect
}

/** How a tool behaves under the eval `simulate` signal. See {@link ToolMeta}. */
export type ToolSideEffect = 'read' | 'write'

/** The `simulate` slice of the run context threaded to the tool dispatch. */
export type SimulateContext = {
  simulate?: boolean
  fixtures?: Record<string, unknown>
}

/**
 * The canned result a side-effecting tool yields under `simulate`, or
 * `undefined` when the tool should execute for real (not simulating, or the tool
 * is untagged). One policy, shared by both dispatch paths (Agent tool set and
 * Tool node) so neutering can never diverge between them.
 */
export function simulatedToolOutput(
  meta: Pick<ToolMeta, 'id' | 'sideEffect'>,
  ctx: SimulateContext | undefined,
): { output: unknown } | undefined {
  if (!ctx?.simulate || !meta.sideEffect) return undefined
  if (meta.sideEffect === 'write') return { output: { simulated: true } }
  return { output: ctx.fixtures?.[meta.id] ?? {} }
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
  simulate?: SimulateContext,
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
    const built = entry.build(deps)
    // Under simulate, swap a side-effecting tool's `execute` for the canned
    // outcome, leaving its schema/description intact so the model still "sees"
    // and can call it (the run then records the call for grading).
    const sim = simulatedToolOutput(entry, simulate)
    set[id] = sim
      ? { ...built, execute: () => Promise.resolve(sim.output) }
      : built
  }
  return set
}
