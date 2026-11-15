import { tool } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { describe, expect, test } from 'bun:test'
import { z } from 'zod'

import { makeAgentConfig } from '../agent-test-helpers'
import type { AgentNode, WfRunManifestEntry } from '../graph'
import { mockFinish, mockUsage } from '../model-test-helpers'
import type { ToolRegistry } from '../tool-registry'

import { executeAgentNode } from './agent'

// A whole connector attached as searchable: the model sees its tools' names
// through `search_tools`, loads the one it wants, and calls it on the next turn
// by its own id — the same call any up-front tool gets.

const NODE: AgentNode = {
  id: 'agent',
  kind: 'agent',
  label: 'Poster',
  position: { x: 0, y: 0 },
  informUser: { mode: 'off' },
  config: { agentId: 'bot', version: null, inputs: {} },
}

function manifest(deferredToolIds: string[]): WfRunManifestEntry[] {
  return [
    {
      kind: 'agent',
      id: 'bot',
      pinnedVersion: null,
      versionId: 'v1',
      versionNumber: 1,
      name: 'Poster',
      config: makeAgentConfig({
        modelId: 'mock',
        prompt: 'Post it.',
        userPrompt: 'Go.',
        inputKind: 'task' as const,
        toolIds: ['lookup', 'mcp:acme:*'],
        deferredToolIds,
        maxTurns: 4,
        output: { kind: 'text' },
      }),
    },
  ]
}

function registry(called: string[]): ToolRegistry<unknown> {
  const entry = (id: string, description: string) => { return [
      id,
      {
        id,
        kind: 'ai-tool' as const,
        name: id,
        description,
        build: () => { return tool({
            description,
            inputSchema: z.object({}),
            execute: async () => {
              called.push(id)
              return { ok: true }
            },
          }) },
      },
    ] as const }
  return new Map([
    entry('lookup', 'Looks something up.'),
    entry('mcp:acme:search', 'Searches Acme.'),
    entry('mcp:acme:post', 'Publishes a post to Acme.'),
    entry('mcp:other:thing', 'Not attached.'),
  ])
}

/** Loads `mcp:acme:post`, calls it, then answers — recording what each turn
 * was offered. */
function loader(offered: string[][]) {
  let call = 0
  return new MockLanguageModelV3({
    doGenerate: async (opts) => {
      const tools = (opts.tools ?? []).map((t) => t.name)
      offered.push(tools)
      call++
      const content =
        call === 1
          ? [
              {
                type: 'tool-call' as const,
                toolCallId: 'c1',
                toolName: 'search_tools',
                input: JSON.stringify({ query: 'publish post' }),
              },
            ]
          : call === 2
            ? [
                {
                  type: 'tool-call' as const,
                  toolCallId: 'c2',
                  toolName: 'mcp:acme:post',
                  input: '{}',
                },
              ]
            : [{ type: 'text' as const, text: 'Posted.' }]
      return {
        content,
        finishReason: mockFinish(call <= 2 ? 'tool-calls' : 'stop'),
        usage: mockUsage(1, 1),
        warnings: [],
      }
    },
  })
}

function run(model: MockLanguageModelV3, m: WfRunManifestEntry[], called: string[]) {
  return executeAgentNode<unknown>({
    node: NODE,
    getModel: () => model,
    toolRegistry: registry(called),
    toolDeps: {},
    promptVariables: {},
    nodeOutputs: new Map(),
    manifest: m,
  })
}

describe('agent node — deferred tools', () => {
  test('a searchable connector is loaded on demand, then called by its id', async () => {
    const offered: string[][] = []
    const called: string[] = []
    const result = await run(loader(offered), manifest(['mcp:acme:*']), called)

    expect((result.output as { text: string }).text).toBe('Posted.')
    // Turn 1: the up-front tool and the loader — none of Acme's schemas.
    expect(offered[0]?.sort()).toEqual(['lookup', 'search_tools'])
    // Turn 2: the loaded tool joined; the one nobody asked for did not.
    expect(offered[1]).toContain('mcp:acme:post')
    expect(offered[1]).not.toContain('mcp:acme:search')
    expect(called).toEqual(['mcp:acme:post'])
  })

  test('in context: every tool of the connector up front, and no loader', async () => {
    const offered: string[][] = []
    await run(loader(offered), manifest([]), [])
    expect(offered[0]?.sort()).toEqual([
      'lookup',
      'mcp:acme:post',
      'mcp:acme:search',
    ])
  })
})
