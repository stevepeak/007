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

// Playground tool simulation. The agent editor's playground runs an agent
// against a *scratch* input with no real client data, so we must never execute
// real tools — several of them mutate the vector store / DB (`embed_and_upsert`,
// `update_document`), bill external calls (`tavily_search`), or need bindings
// absent in the web worker. Instead we present the same tool *schemas* to the
// model (so it still decides to call the right tool with the right arguments —
// visible in the trace) but replace execution with an LLM that fabricates a
// plausible result from the tool's description + the arguments the agent passed.
// No real deps are ever constructed, so real data is untouchable by design.

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

// Wraps a host tool registry so every AI-tool builds a mock whose `execute`
// calls the simulator instead of the real implementation. Deps are ignored (the
// mock closes over the simulator model), so the caller can pass `{}` and skip
// `buildRunDeps` entirely. Function tools aren't usable inside an agent node, so
// they're dropped.
export function buildSimulatedRegistry<TDeps>(
  registry: ToolRegistry<TDeps>,
  model: LanguageModel,
): ToolRegistry<unknown> {
  const simulated: ToolRegistry<unknown> = new Map()
  for (const [id, entry] of registry) {
    if (entry.kind !== 'ai-tool') continue
    simulated.set(id, {
      id: entry.id,
      name: entry.name,
      description: entry.description,
      icon: entry.icon,
      inputSchema: entry.inputSchema,
      outputSchema: entry.outputSchema,
      kind: 'ai-tool',
      build: () =>
        tool({
          description: entry.description,
          inputSchema: entry.inputSchema ?? jsonSchema({ type: 'object' }),
          execute: (args: unknown) =>
            simulateToolResult(
              model,
              entry as Extract<ToolRegistryEntry<unknown>, { kind: 'ai-tool' }>,
              args,
            ),
        }),
    })
  }
  return simulated
}
