import { tool } from 'ai'
import { z } from 'zod'

import type { ToolRegistryEntry } from '../engine/tool-registry'

import { TAVILY_ICON_SVG } from './icons'

// Built-in web-search tool (Tavily — https://tavily.com). An LLM-friendly search
// API: one call returns ranked results with extracted content plus an optional
// synthesized answer. Self-contained (just `fetch` + an API key), so it ships
// with the SDK; the host wires the key out of its deps.

export type TavilyResult = {
  title: string
  url: string
  content: string
  score: number
}

type TavilyResponse = {
  answer?: string
  results?: Array<{
    title?: string
    url?: string
    content?: string
    score?: number
  }>
}

// Declared once and shared between the registry metadata (surfaced to the
// workflow editor) and the live `tool()` the agent calls, so the documented
// shape and the enforced shape can never drift.
const TAVILY_INPUT_SCHEMA = z.object({
  query: z.string().min(1).describe('The web search query.'),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(10)
    .default(5)
    .describe('How many results to return (1–10).'),
})

const TAVILY_OUTPUT_SCHEMA = z.object({
  answer: z
    .string()
    .nullable()
    .describe('A synthesized answer to the query, if Tavily produced one.'),
  results: z
    .array(
      z.object({
        title: z.string().describe('Result page title.'),
        url: z.string().describe('Result page URL — cite this.'),
        content: z.string().describe('Extracted page content snippet.'),
        score: z.number().describe('Relevance score (0–1).'),
      }),
    )
    .describe('Ranked search results.'),
})

export type CreateTavilyToolOptions<TDeps> = {
  /** Pull the Tavily API key (`tvly-…`) out of the run deps. */
  getApiKey: (deps: TDeps) => string
  /** Override the registry id (default `tavily_search`). */
  id?: string
  /** Override the endpoint (tests). */
  endpoint?: string
}

/**
 * Build a `tavily_search` registry entry (metadata + `build`). Register it in a
 * host `toolRegistry`, wiring `getApiKey` to wherever the host keeps the key.
 */
export function createTavilyTool<TDeps>(
  opts: CreateTavilyToolOptions<TDeps>,
): ToolRegistryEntry<TDeps> {
  const endpoint = opts.endpoint ?? 'https://api.tavily.com/search'
  return {
    id: opts.id ?? 'tavily_search',
    name: 'Tavily Web Search',
    description:
      'Search the public web for current information, with ranked results and citations.',
    icon: TAVILY_ICON_SVG,
    kind: 'ai-tool',
    inputSchema: TAVILY_INPUT_SCHEMA,
    outputSchema: TAVILY_OUTPUT_SCHEMA,
    build: (deps) => {
      const apiKey = opts.getApiKey(deps)
      return tool({
        description:
          'Search the public web for current information. Returns ranked results with extracted page content and a synthesized answer. Use for facts that may be recent or outside the client’s own documents; cite the result URLs.',
        inputSchema: TAVILY_INPUT_SCHEMA,
        execute: async (
          args,
        ): Promise<{ answer: string | null; results: TavilyResult[] }> => {
          const { query, maxResults } = args as {
            query: string
            maxResults: number
          }
          if (!apiKey) {
            throw new Error(
              'Tavily search is not configured — set the Tavily API key.',
            )
          }
          const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              api_key: apiKey,
              query,
              max_results: maxResults,
              search_depth: 'basic',
              include_answer: true,
            }),
          })
          if (!res.ok) {
            const detail = await res.text().catch(() => '')
            throw new Error(
              `Tavily search failed (${res.status})${detail ? `: ${detail}` : ''}`,
            )
          }
          // `res.json()` is `any`; assert the response shape we rely on.
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
          const data = (await res.json()) as TavilyResponse
          const results: TavilyResult[] = (data.results ?? []).map((r) => ({
            title: r.title ?? '',
            url: r.url ?? '',
            content: r.content ?? '',
            score: r.score ?? 0,
          }))
          return { answer: data.answer ?? null, results }
        },
      })
    },
  }
}
