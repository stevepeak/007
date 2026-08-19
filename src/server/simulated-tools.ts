import {
  generateObject,
  generateText,
  jsonSchema,
  tool,
  type LanguageModel,
} from 'ai'
import { z } from 'zod'

import type { JsonSchema } from '../engine/agent-output'
import type { ToolRegistry, ToolRegistryEntry } from '../engine/tool-registry'

// Playground tool dispatch. Each tool an agent can call is either *simulated*
// (an LLM fabricates a plausible result from the tool's description + the
// arguments the agent passed) or *live* (the real implementation runs against
// the host's real per-run deps).
//
// Simulation is the safe default and the only mode this file used to have: a
// playground runs on scratch input with no real client context, and several
// tools mutate the vector store / DB (`embed_and_upsert`, `update_document`) or
// bill external calls (`tavily_search`). Either way the model sees the same tool
// *schemas* and decides which to call with which arguments — only execution
// differs, so the trace reads the same in both modes.
//
// Live tools are opt-in per tool from the playground UI, which defaults
// `sideEffect: 'read'` tools on and everything else off. When nothing is live,
// no deps are built at all and real data stays untouchable by construction.

// Fallback stub when the simulator model call fails — keeps the agent loop alive
// rather than surfacing an error for a tool the author only wanted to exercise.
function stub(id: string, args: unknown) {
  return {
    simulated: true,
    tool: id,
    args,
    note: 'Tool execution was simulated in the playground; the live tool did not run.',
  }
}

// Asks the model to stand in for one tool call: given the tool's purpose and the
// arguments the agent chose, invent a realistic result. When the tool declares
// an output schema we constrain the shape with `generateObject` so the agent
// receives data in the form the real tool would return; otherwise free text.
async function simulateToolResult(
  model: LanguageModel,
  entry: Extract<ToolRegistryEntry<unknown>, { kind: 'ai-tool' }>,
  args: unknown,
): Promise<unknown> {
  const prompt = [
    `You are standing in for a tool named "${entry.name}" (id: ${entry.id}).`,
    `Tool purpose: ${entry.description}`,
    'It was just called with these arguments:',
    JSON.stringify(args ?? {}, null, 2),
    'Produce a single realistic result this tool would plausibly return for these arguments.',
    'Invent specific but believable details, keep it concise and internally consistent, and do not mention that this is simulated.',
  ].join('\n')

  try {
    if (entry.outputSchema) {
      // `unrepresentable: 'any'` so a transform/pipe anywhere in the output
      // schema degrades to `{}` instead of throwing (which would drop us to the
      // `stub` fallback for every call).
      const schema = z.toJSONSchema(entry.outputSchema, {
        io: 'output',
        unrepresentable: 'any',
      }) as JsonSchema
      const { object } = await generateObject({
        model,
        schema: jsonSchema(schema),
        prompt,
      })
      return object
    }
    const { text } = await generateText({ model, prompt })
    return { result: text }
  } catch {
    return stub(entry.id, args)
  }
}

/**
 * Wraps a host tool registry for a playground run. Every AI-tool is rebuilt as a
 * mock whose `execute` calls the simulator, EXCEPT the ids in `liveToolIds`,
 * which are bound to the real `deps` and execute for real.
 *
 * Both variants close over what they need, so the caller passes `{}` as the
 * node's `toolDeps`. Function tools aren't usable inside an agent node, so
 * they're dropped.
 */
export function buildPlaygroundRegistry<TDeps>(opts: {
  registry: ToolRegistry<TDeps>
  /** The model that fabricates results for simulated tools. */
  model: LanguageModel
  /** Tool ids the author opted into running FOR REAL. */
  liveToolIds?: readonly string[]
  /**
   * The host's real per-run deps. Only built by the caller when at least one
   * tool is live; a live id without deps falls back to simulation.
   */
  deps?: TDeps
}): ToolRegistry<unknown> {
  const { registry, model, deps } = opts
  const live = new Set(opts.liveToolIds ?? [])
  const built: ToolRegistry<unknown> = new Map()
  for (const [id, entry] of registry) {
    if (entry.kind !== 'ai-tool') continue
    const isLive = live.has(id) && deps !== undefined
    built.set(id, {
      id: entry.id,
      name: entry.name,
      description: entry.description,
      icon: entry.icon,
      iconName: entry.iconName,
      color: entry.color,
      sideEffect: entry.sideEffect,
      statusLabel: entry.statusLabel,
      inputSchema: entry.inputSchema,
      outputSchema: entry.outputSchema,
      kind: 'ai-tool',
      build: isLive
        ? () => entry.build(deps)
        : () =>
            tool({
              description: entry.description,
              inputSchema: entry.inputSchema ?? jsonSchema({ type: 'object' }),
              execute: (args: unknown) =>
                simulateToolResult(
                  model,
                  entry as Extract<
                    ToolRegistryEntry<unknown>,
                    { kind: 'ai-tool' }
                  >,
                  args,
                ),
            }),
    })
  }
  return built
}
