import { resolveBinding } from '../binding'
import type { ToolNode } from '../graph'
import type { ToolRegistry, ToolRegistryEntry } from '../tool-registry'

export type ToolNodeResult = {
  output: unknown
  meta: {
    toolId: string
    args: Record<string, unknown>
  }
}

export type ExecuteToolNodeDeps<TDeps> = {
  node: ToolNode
  /** Per-node output cache. Keys are node ids, values are the node's `output`. */
  nodeOutputs: Map<string, unknown>
  toolRegistry: ToolRegistry<TDeps>
  toolDeps: TDeps
  /**
   * Deep-rehydrates blob-ref args (a large upstream value spilled to storage) to
   * their real text before schema validation. Omitted → args pass through
   * unchanged.
   */
  rehydrate?: (value: unknown) => Promise<unknown>
}

export async function executeToolNode<TDeps>(
  deps: ExecuteToolNodeDeps<TDeps>,
): Promise<ToolNodeResult> {
  const { node, nodeOutputs, toolRegistry, toolDeps, rehydrate } = deps
  const entry: ToolRegistryEntry<TDeps> | undefined = toolRegistry.get(
    node.config.toolId,
  )
  if (!entry) {
    throw new Error(`Tool '${node.config.toolId}' is not registered.`)
  }

  // Materialize args from the bindings. `literal` resolves to its value;
  // `ref` walks into the prior node's cached output.
  const rawArgs: Record<string, unknown> = {}
  for (const [name, binding] of Object.entries(node.config.args)) {
    const value = resolveBinding(binding, nodeOutputs, {
      nodeId: node.id,
      name,
    })
    // Rehydrate blob-ref args (a large upstream value spilled to storage) to
    // their real text here — inside this node's step — before validation.
    rawArgs[name] = rehydrate ? await rehydrate(value) : value
  }
  // Validate/coerce the bound args through the tool's declared input schema when
  // it has one — this applies defaults (e.g. an omitted `maxResults`) and surfaces
  // a clear error before the tool runs. Function tools without a schema pass raw.
  const args = (
    entry.inputSchema ? entry.inputSchema.parse(rawArgs) : rawArgs
  ) as Record<string, unknown>

  // Function tools are plain `(args) => Promise<result>`. AI tools are AI SDK
  // `Tool`s whose `execute` the agent loop normally calls; a Tool node invokes
  // that same `execute` directly with the bound args (no LLM in the loop), so an
  // AI tool can run deterministically as a workflow step.
  if (entry.kind === 'function') {
    const fn = entry.build(toolDeps)
    const output = await fn(args)
    return { output, meta: { toolId: entry.id, args } }
  }

  const built = entry.build(toolDeps)
  const execute = (
    built as {
      execute?: (
        input: unknown,
        options: { toolCallId: string; messages: never[] },
      ) => unknown
    }
  ).execute
  if (typeof execute !== 'function') {
    throw new TypeError(
      `Tool '${entry.id}' has no execute function and cannot run as a Tool node.`,
    )
  }
  const output = await execute(args, {
    toolCallId: crypto.randomUUID(),
    messages: [],
  })
  return { output, meta: { toolId: entry.id, args } }
}
