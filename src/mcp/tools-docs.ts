import { z } from 'zod'

import {
  type DocToolEntry,
  docTopics,
  findTopic,
  OVERVIEW_TOPIC,
  renderTopic,
  searchDocs,
  suggestTopics,
} from './docs/registry'
import { optString, type WfMcpTool } from './tools'

// `get_docs` — how the system works, as opposed to what is in it.
//
// Every other tool answers "what is the state of X". None of them can answer
// "what will the engine DO with X" — whether a node with two incoming edges
// waits for both, whether a losing race branch keeps running, what a Transform
// can express. Without this a model authoring a workflow over MCP either guesses
// or stops and asks a person, and a wrong guess about join semantics ships a
// workflow that misbehaves only under load.
//
// One tool with three modes rather than list/get/search tools: each catalog
// entry costs every session context, and the three are one reading activity.
// The answer is Markdown, not JSON — it is prose to read, and a JSON-escaped
// page of Markdown is harder for a model to follow than the page itself.

/** What the server tells a client before any tool is called. Kept short — it rides in every session's context. */
export const WF_MCP_INSTRUCTIONS = `007 is a workflow engine: workflows are graphs of nodes (agents, tools, routing, joins, iteration) that run when a trigger fires; agents are reusable, versioned LLM configurations those nodes point at.

Before authoring or changing a workflow or agent — or explaining what one will do — read the docs: call \`get_docs\` with no arguments for the TL;DR, the dictionary of node kinds and tools, and the topic index; then \`get_docs({ topic })\` for a page (e.g. "execution", "nodes/race", "agents") or \`get_docs({ query })\` to search (e.g. "fastTrack", "continueOnError"). The docs describe engine semantics the data tools cannot show you, such as when a node with several incoming edges fires.`

/** Total characters a search answer may carry before later hits are cut. */
const SEARCH_BUDGET = 16_000

export function docsTools(listTools: () => DocToolEntry[]): WfMcpTool[] {
  return [
    {
      name: 'get_docs',
      title: 'Read the 007 documentation',
      description: [
        'How 007 works: the engine semantics, every node kind and its config, agents, evals, versioning, limits, and how to author through this MCP. Read it before building or changing a workflow — the other tools show what exists, this shows what the engine will do with it.',
        'No arguments: the TL;DR, a dictionary of node kinds and MCP tools, and the topic index. `topic`: one page in full (`execution`, `nodes/race`, or just `race`). `query`: the best-matching sections across all pages, for a config key or a question ("fastTrack", "wait for all").',
      ].join('\n\n'),
      inputSchema: {
        topic: z
          .string()
          .nullish()
          .describe(
            'A topic id from the index, e.g. "execution", "agents", "nodes/aggregate". A bare node kind ("race") works too.',
          ),
        query: z
          .string()
          .nullish()
          .describe(
            'Words to search every page for. Returns the matching sections, best first. Ignored when `topic` is given.',
          ),
      },
      readOnly: true,
      run: (_client, args) => {
        const tools = listTools()
        const topicArg = optString(args.topic)
        if (topicArg) {
          const topic = findTopic(topicArg)
          if (!topic) {
            const close = suggestTopics(topicArg)
            throw new Error(
              [
                `No docs topic "${topicArg}".`,
                close.length > 0 ? `Closest: ${close.join(', ')}.` : null,
                `All topics: ${docTopics()
                  .map((t) => t.id)
                  .join(', ')}.`,
                'Or pass `query` to search.',
              ]
                .filter(Boolean)
                .join(' '),
            )
          }
          return Promise.resolve(renderTopic(topic, tools))
        }

        const query = optString(args.query)
        if (query) return Promise.resolve(renderSearch(query))

        const overview = findTopic(OVERVIEW_TOPIC)
        if (!overview) throw new Error('The overview topic is missing.')
        return Promise.resolve(renderTopic(overview, tools))
      },
    },
  ]
}

function renderSearch(query: string): string {
  const hits = searchDocs(query)
  if (hits.length === 0) {
    return `# Search: ${query}\n\nNothing matched. Call \`get_docs\` with no arguments for the topic index.\n`
  }
  const parts = [`# Search: ${query}`, '']
  let used = 0
  for (const hit of hits) {
    const block = `## ${hit.heading}\n_From \`${hit.topic}\` — \`get_docs({ topic: "${hit.topic}" })\` for the whole page._\n\n${hit.text}\n`
    if (used > 0 && used + block.length > SEARCH_BUDGET) {
      parts.push(
        `_More matches were cut for length; open \`${hit.topic}\` or narrow the query._`,
      )
      break
    }
    parts.push(block)
    used += block.length
  }
  return parts.join('\n')
}
