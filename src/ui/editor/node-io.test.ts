import { describe, expect, test } from 'bun:test'

import type { WorkflowGraph } from '../../engine'
import {
  agentThreadSource,
  outputContractIssue,
  type IoMaps,
} from './node-io'

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
  // `bot` declares it works on a conversation (so its nodes get the input);
  // `summarizer` is a step agent that takes a single value.
  agentsById: new Map([
    ['bot', { output: { kind: 'text' }, inputKind: 'conversation' }],
    ['summarizer', { output: { kind: 'text' }, inputKind: 'task' }],
  ]),
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
        // The chat trigger accepts a bare string OR a `{ text }` object.
        outputContract: {
          anyOf: [
            { type: 'string' },
            {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
            },
          ],
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

  test('idle: no message source anywhere upstream', () => {
    const manual = node('m', 'trigger', 'Manual', { triggerKind: 'manual' })
    const g = graph([manual, agent], [edge('e', 'm', 'a')])
    // The agent still declares a conversation, so the input exists — there's just
    // nothing upstream to suggest linking it to.
    expect(agentThreadSource(g, 'a', maps)).toEqual({ status: 'idle' })
  })

  test('idle: fan-in hides the thread behind a source-keyed object', () => {
    const tool = node('tl', 'tool', 'Reshape', { toolId: 'reshape', args: {} })
    const g = graph(
      [chatTrigger, tool, agent],
      [edge('e1', 't', 'a'), edge('e2', 'tl', 'a')],
    )
    // Two live predecessors → runtime input is `{ [id]: output }`, which hides the
    // top-level `messages` array; nothing to suggest linking automatically.
    expect(agentThreadSource(g, 'a', maps)).toEqual({ status: 'idle' })
  })

  test('none: the agent does not work on a conversation', () => {
    // The declaration — not graph topology — decides whether the input exists:
    // the chat trigger's messages are right there, and the step agent still gets
    // no conversation input.
    const step = node('a', 'agent', 'Summarizer', {
      agentId: 'summarizer',
      inputs: {},
      imageInputs: {},
    })
    const g = graph([chatTrigger, step], [edge('e', 't', 'a')])
    expect(agentThreadSource(g, 'a', maps)).toEqual({ status: 'none' })
  })

  test('unsupported: a link on an agent that takes no conversation', () => {
    const step = node('a', 'agent', 'Summarizer', {
      agentId: 'summarizer',
      inputs: {},
      imageInputs: {},
      conversation: { kind: 'ref', nodeId: 't', path: 'messages' },
    })
    const g = graph([chatTrigger, step], [edge('e', 't', 'a')])
    expect(agentThreadSource(g, 'a', maps)).toEqual({
      status: 'unsupported',
      sourceId: 't',
      sourceLabel: 'Chat message',
    })
  })

  test('none: the node is not an agent', () => {
    const g = graph([chatTrigger, agent], [edge('e', 't', 'a')])
    expect(agentThreadSource(g, 't', maps)).toEqual({ status: 'none' })
  })
})

describe('outputContractIssue', () => {
  // An Output bound to a text agent's whole output satisfies the chat trigger's
  // `{ text }` contract — no issue.
  test('clean: output bound to a text agent satisfies the { text } contract', () => {
    const out = node('o', 'output', 'Output', {
      source: { kind: 'ref', nodeId: 'a', path: '' },
    })
    const g = graph(
      [chatTrigger, agent, out],
      [edge('e1', 't', 'a'), edge('e2', 'a', 'o')],
    )
    expect(outputContractIssue(g, out as never, maps)).toBeUndefined()
  })

  // Binding the agent's `text` FIELD directly (a bare string) is a natural author
  // choice and satisfies the string branch of the contract — no issue.
  test('clean: output bound to the agent text field (a string) satisfies it', () => {
    const out = node('o', 'output', 'Output', {
      source: { kind: 'ref', nodeId: 'a', path: 'text' },
    })
    const g = graph(
      [chatTrigger, agent, out],
      [edge('e1', 't', 'a'), edge('e2', 'a', 'o')],
    )
    expect(outputContractIssue(g, out as never, maps)).toBeUndefined()
  })

  // An Output bound to a reshaping tool that emits `{ result }` (no `text`) fails
  // the contract — a clear error mentioning what text the Output must send.
  test('mismatch: output bound to a non-text value flags a contract error', () => {
    const tool = node('tl', 'tool', 'Reshape', { toolId: 'reshape', args: {} })
    const out = node('o', 'output', 'Output', {
      source: { kind: 'ref', nodeId: 'tl', path: '' },
    })
    const g = graph(
      [chatTrigger, tool, out],
      [edge('e1', 't', 'tl'), edge('e2', 'tl', 'o')],
    )
    const msg = outputContractIssue(g, out as never, maps)
    expect(msg).toBeString()
    expect(msg).toContain('text')
  })

  // No contract declared (manual trigger) → nothing to enforce.
  test('no contract: a contract-less trigger yields no issue', () => {
    const manual = node('m', 'trigger', 'Manual', { triggerKind: 'manual' })
    const out = node('o', 'output', 'Output', {
      source: { kind: 'ref', nodeId: 'a', path: '' },
    })
    const g = graph(
      [manual, agent, out],
      [edge('e1', 'm', 'a'), edge('e2', 'a', 'o')],
    )
    expect(outputContractIssue(g, out as never, maps)).toBeUndefined()
  })

  // Unbound is handled by the engine's collectGraphIssues, not here.
  test('unbound: no source yields no contract issue (handled elsewhere)', () => {
    const out = node('o', 'output', 'Output', {})
    const g = graph([chatTrigger, agent, out], [edge('e', 'a', 'o')])
    expect(outputContractIssue(g, out as never, maps)).toBeUndefined()
  })
})
