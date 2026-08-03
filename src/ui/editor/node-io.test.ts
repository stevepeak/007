import { describe, expect, test } from 'bun:test'

import type { WorkflowGraph } from '../../engine'
import { agentThreadSource, type IoMaps } from './node-io'

// Minimal builders — the helper only reads node id/kind/label/config and edge
// source/target, and pulls output shapes from the maps below, so we cast past the
// full discriminated-union schema (same approach as use-edit-history.test.ts).
function node(id: string, kind: string, label: string, config: object = {}) {
  return { id, kind, label, position: { x: 0, y: 0 }, config }
}

function edge(id: string, source: string, target: string) {
  return { id, source, target, condition: null }
}

function graph(
  nodes: ReturnType<typeof node>[],
  edges: ReturnType<typeof edge>[] = [],
): WorkflowGraph {
  return { version: 1, nodes, edges } as unknown as WorkflowGraph
}

// A chat trigger's payload carries `messages: array` (what `coerceToMessages`
// keys off); a tool reshapes to an object without `messages`; the manual trigger
// has no payload schema at all.
const maps = {
  toolsById: new Map([
    [
      'reshape',
      {
        outputSchema: {
          type: 'object',
          properties: { result: { type: 'string' } },
        },
      },
    ],
  ]),
  agentsById: new Map([['bot', { output: { kind: 'text' } }]]),
  triggersByKind: new Map([
    [
      'chat_message',
      {
        inputSchema: {
          type: 'object',
          properties: {
            messages: { type: 'array' },
            userText: { type: 'string' },
          },
        },
      },
    ],
    ['manual', {}],
  ]),
} as unknown as IoMaps

const chatTrigger = node('t', 'trigger', 'Chat message', {
  triggerKind: 'chat_message',
})
const agent = node('a', 'agent', 'Chat Bot', {
  agentId: 'bot',
  inputs: {},
  imageInputs: {},
})

describe('agentThreadSource', () => {
  test('linked: an explicit conversation binding is the message source', () => {
    // An agent fed by a reshaping tool would otherwise be `unlinked`, but an
    // explicit link to the trigger's messages makes it `linked`.
    const tool = node('tl', 'tool', 'Reshape', { toolId: 'reshape', args: {} })
    const boundAgent = node('a', 'agent', 'Chat Bot', {
      agentId: 'bot',
      inputs: {},
      imageInputs: {},
      conversation: { kind: 'ref', nodeId: 't', path: 'messages' },
    })
    const g = graph(
      [chatTrigger, tool, boundAgent],
      [edge('e1', 't', 'tl'), edge('e2', 'tl', 'a')],
    )
    expect(agentThreadSource(g, 'a', maps)).toEqual({
      status: 'linked',
      sourceId: 't',
      sourceLabel: 'Chat message',
    })
  })

  test('unlinked: a message source is reachable directly but not linked', () => {
    const g = graph([chatTrigger, agent], [edge('e', 't', 'a')])
    expect(agentThreadSource(g, 'a', maps)).toEqual({
      status: 'unlinked',
      sourceId: 't',
      sourceLabel: 'Chat message',
    })
  })

  test('unlinked: reachable through a transparent passthrough', () => {
    const pass = node('p', 'passthrough', 'Passthrough', {})
    const g = graph(
      [chatTrigger, pass, agent],
      [edge('e1', 't', 'p'), edge('e2', 'p', 'a')],
    )
    // An identity passthrough forwards `{ messages }`, so the source is reachable.
    expect(agentThreadSource(g, 'a', maps)).toMatchObject({
      status: 'unlinked',
    })
  })

  test('unlinked: a message source is one hop up behind a reshaping tool', () => {
    const tool = node('tl', 'tool', 'Reshape', { toolId: 'reshape', args: {} })
    const g = graph(
      [chatTrigger, tool, agent],
      [edge('e1', 't', 'tl'), edge('e2', 'tl', 'a')],
    )
    // The suggestion points at the actual message source (the trigger), not the
    // tool that sits between it and the agent.
    expect(agentThreadSource(g, 'a', maps)).toEqual({
      status: 'unlinked',
      sourceId: 't',
      sourceLabel: 'Chat message',
    })
  })

  test('none: no message source anywhere upstream', () => {
    const manual = node('m', 'trigger', 'Manual', { triggerKind: 'manual' })
    const g = graph([manual, agent], [edge('e', 'm', 'a')])
    expect(agentThreadSource(g, 'a', maps)).toEqual({ status: 'none' })
  })

  test('none: fan-in hides the thread behind a source-keyed object', () => {
    const tool = node('tl', 'tool', 'Reshape', { toolId: 'reshape', args: {} })
    const g = graph(
      [chatTrigger, tool, agent],
      [edge('e1', 't', 'a'), edge('e2', 'tl', 'a')],
    )
    // Two live predecessors → runtime input is `{ [id]: output }`, which hides the
    // top-level `messages` array; nothing to link automatically.
    expect(agentThreadSource(g, 'a', maps)).toEqual({ status: 'none' })
  })

  test('none: the node is not an agent', () => {
    const g = graph([chatTrigger, agent], [edge('e', 't', 'a')])
    expect(agentThreadSource(g, 't', maps)).toEqual({ status: 'none' })
  })
})
