import { tool, type Tool, type ToolSet } from 'ai'
import { z } from 'zod'

// Deferred tools: the agent sees a tool's NAME up front and its schema only once
// it asks for it.
//
// An agent can attach a whole connector, and a connector can advertise eighty
// tools. Sending eighty schemas on every turn spends the context on tools the
// agent will never call, so the agent's author can mark entries searchable
// (`deferredToolIds`). Those tools are still REGISTERED in the loop's tool set —
// a loaded tool is then called exactly like any other, by its own id, so
// simulate, evals, side-effect classification and status labels see nothing
// new. What changes is only which tools each turn sends: `prepareStep` returns
// `activeTools`, which this module grows as the model loads tools.

/** The synthesized loader's tool name. */
export const TOOL_SEARCH_NAME = 'search_tools'

/** How many tools one keyword search may load. */
const MAX_MATCHES = 5

const toolSearchInput = z.object({
  names: z
    .array(z.string())
    .nullish()
    .describe('Exact tool names from the list to load.'),
  query: z
    .string()
    .nullish()
    .describe('Keywords to match against tool names and descriptions.'),
})

export type ToolSearch = {
  tool: Tool
  /** The tools the next turn may call: every up-front tool, the loader, and
   * whatever has been loaded so far. */
  activeTools: () => string[]
}

/**
 * The loader for a tool set's deferred entries, or null when nothing is
 * deferred — an agent with every tool up front gets no extra tool.
 */
export function createToolSearch(args: {
  tools: ToolSet
  deferred: readonly string[]
}): ToolSearch | null {
  const deferred = args.deferred.filter((id) => Object.hasOwn(args.tools, id))
  if (deferred.length === 0) return null
  if (Object.hasOwn(args.tools, TOOL_SEARCH_NAME)) {
    throw new Error(
      `Tool '${TOOL_SEARCH_NAME}' collides with the deferred-tool loader. Rename the tool, or attach every tool up front.`,
    )
  }
  const deferredSet = new Set(deferred)
  const upFront = Object.keys(args.tools).filter((id) => !deferredSet.has(id))
  const loaded = new Set<string>()

  // A description may be a function of call context; only a plain string is
  // worth matching against or handing back.
  const descriptionOf = (id: string): string => {
    const d = args.tools[id]?.description
    return typeof d === 'string' ? d : ''
  }

  const search = tool({
    description: [
      'Load tools that are available to you but not yet loaded. A loaded tool can be called from your next turn on.',
      'Pass `names` to load exact tools, or `query` (keywords) to load the closest matches.',
      `Tools you can load: ${deferred.join(', ')}`,
    ].join('\n'),
    // Typed loosely, as the sub-agent tools are: `ai` checks a schema against
    // its own zod copy. The args are parsed back below instead.
    inputSchema: toolSearchInput as z.ZodType,
    execute: (input: unknown) => {
      const { names, query } = toolSearchInput.parse(input)
      const wanted = (names ?? []).filter((n) => deferredSet.has(n))
      const terms = (query ?? '').toLowerCase().split(/\W+/).filter(Boolean)
      if (terms.length > 0) {
        const scored = deferred
          .map((id) => {
            const text = `${id} ${descriptionOf(id)}`.toLowerCase()
            return { id, score: terms.filter((t) => text.includes(t)).length }
          })
          .filter((m) => m.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, MAX_MATCHES)
        wanted.push(...scored.map((m) => m.id))
      }
      for (const id of wanted) loaded.add(id)
      const unknown = (names ?? []).filter((n) => !deferredSet.has(n))
      return Promise.resolve({
        loaded: [...new Set(wanted)].map((id) => ({
          name: id,
          description: descriptionOf(id),
        })),
        ...(unknown.length > 0 ? { notFound: unknown } : {}),
      })
    },
  })

  return {
    tool: search,
    activeTools: () => [...upFront, TOOL_SEARCH_NAME, ...loaded],
  }
}
