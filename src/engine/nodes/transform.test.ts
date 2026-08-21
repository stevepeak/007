import { describe, expect, test } from 'bun:test'

import type { TransformNode } from '../graph'
import { executeTransformNode } from './transform'

// Build a minimal Transform node with the given config.
function node(config: Partial<TransformNode['config']>): TransformNode {
  return {
    id: 't',
    kind: 'transform',
    label: 'Shape the thread',
    position: { x: 0, y: 0 },
    informUser: { mode: 'off' },
    config: { inputs: {}, expression: '', ...config },
  }
}

// The rows `find_or_create_chat` returns — the shape this node exists to fix.
const ROWS = [
  { id: 'm1', role: 'user', senderName: 'Dana', body: 'Can you review this?' },
  { id: 'm2', role: 'assistant', senderName: null, body: 'Yes — sending notes.' },
  { id: 'm3', role: 'firm', senderName: 'Alex', body: 'Flagging the indemnity.' },
]

// The expression an author would actually write for that mapping.
const TO_CONVERSATION = `[$.{
  "id": id,
  "role": role = "assistant" ? "assistant" : "user",
  "parts": [{
    "type": "text",
    "text": role = "firm" ? "[Firm — " & senderName & "]: " & body : body
  }]
}]`

describe('executeTransformNode', () => {
  test('runs the expression over the incoming input when no source is bound', async () => {
    const r = await executeTransformNode({
      node: node({ expression: '$.body' }),
      input: ROWS,
      nodeOutputs: new Map(),
    })
    expect(r.output).toEqual([
      'Can you review this?',
      'Yes — sending notes.',
      'Flagging the indemnity.',
    ])
  })

  test('a bound source wins over the incoming input', async () => {
    const outputs = new Map<string, unknown>([['tool', { messages: ROWS }]])
    const r = await executeTransformNode({
      node: node({
        source: { kind: 'ref', nodeId: 'tool', path: 'messages' },
        expression: '$count($)',
      }),
      input: 'ignored',
      nodeOutputs: outputs,
    })
    expect(r.output).toBe(3)
  })

  test('extra inputs are exposed to the expression as $name', async () => {
    const outputs = new Map<string, unknown>([['chat', { title: 'Indemnity' }]])
    const r = await executeTransformNode({
      node: node({
        inputs: { heading: { kind: 'ref', nodeId: 'chat', path: 'title' } },
        expression: '$heading & ": " & $count($) & " messages"',
      }),
      input: ROWS,
      nodeOutputs: outputs,
    })
    expect(r.output).toBe('Indemnity: 3 messages')
  })

  test('maps database rows to the AI-SDK message shape', async () => {
    const r = await executeTransformNode({
      node: node({ expression: TO_CONVERSATION, outputShape: 'conversation' }),
      input: ROWS,
      nodeOutputs: new Map(),
    })
    expect(r.output).toEqual([
      {
        id: 'm1',
        role: 'user',
        parts: [{ type: 'text', text: 'Can you review this?' }],
      },
      {
        id: 'm2',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Yes — sending notes.' }],
      },
      {
        // A firm staffer is not a role the model knows: it arrives as a user
        // turn wearing a voice label.
        id: 'm3',
        role: 'user',
        parts: [{ type: 'text', text: '[Firm — Alex]: Flagging the indemnity.' }],
      },
    ])
  })

  // The trap the `outputShape` assertion exists for. JSONata collapses a
  // single-element sequence to a bare value, so a one-message thread silently
  // produces an OBJECT where every longer thread produces an array — and the
  // agent node's `Array.isArray` check then reports the conversation as "not
  // bound" on a node that is plainly bound.
  test('a one-row thread still yields an array (the [ ] constructor holds)', async () => {
    const r = await executeTransformNode({
      node: node({ expression: TO_CONVERSATION, outputShape: 'conversation' }),
      input: [ROWS[0]],
      nodeOutputs: new Map(),
    })
    expect(Array.isArray(r.output)).toBe(true)
    expect(r.output).toHaveLength(1)
  })

  test('without the [ ] constructor a one-row thread collapses — and is caught', async () => {
    const collapsing = TO_CONVERSATION.slice(1, -1) // drop the outer brackets
    const promise = executeTransformNode({
      node: node({ expression: collapsing, outputShape: 'conversation' }),
      input: [ROWS[0]],
      nodeOutputs: new Map(),
    })
    // Names the node and points at the array constructor, rather than failing
    // later and elsewhere.
    await expect(promise).rejects.toThrow(/Shape the thread.*conversation/s)
    await expect(promise).rejects.toThrow(/array constructor/)
  })

  test('rejects a role the AI SDK cannot convert', async () => {
    // `role: 'firm'` reaching the model throws `Unsupported role: firm` deep in
    // the SDK, after the agent node has burned its retry schedule. Catch it here.
    const promise = executeTransformNode({
      node: node({
        expression: '[$.{ "role": role, "parts": [{"type":"text","text":body}] }]',
        outputShape: 'conversation',
      }),
      input: ROWS,
      nodeOutputs: new Map(),
    })
    await expect(promise).rejects.toThrow(/does not match at `2.role`/)
  })

  test('an unchecked transform emits whatever the expression returned', async () => {
    const r = await executeTransformNode({
      node: node({ expression: '{ "anything": true }' }),
      input: ROWS,
      nodeOutputs: new Map(),
    })
    expect(r.output).toEqual({ anything: true })
  })

  test('a syntax error names the node and the position', async () => {
    const promise = executeTransformNode({
      node: node({ expression: '$.{ "role": ' }),
      input: ROWS,
      nodeOutputs: new Map(),
    })
    await expect(promise).rejects.toThrow(/Shape the thread.*invalid JSONata/s)
  })

  test('an empty expression is refused rather than treated as identity', async () => {
    const promise = executeTransformNode({
      node: node({ expression: '   ' }),
      input: ROWS,
      nodeOutputs: new Map(),
    })
    await expect(promise).rejects.toThrow(/has no expression/)
  })

  test('non-tail recursion is stopped by the stack guard', async () => {
    const promise = executeTransformNode({
      // The recursive call sits inside an expression, so frames accumulate and
      // depth is measurable. This is the cheap guard — it fires in milliseconds.
      node: node({
        expression: '($f := function($x) { 1 + $f($x + 1) }; $f(0))',
      }),
      input: ROWS,
      nodeOutputs: new Map(),
    })
    await expect(promise).rejects.toThrow(/failed to evaluate.*[Ss]tack/s)
  })

  // Pins the second, weaker guard. JSONata turns a tail call into a loop, so the
  // stack stays flat and only the clock can stop it — which is exactly why this
  // one does NOT hold in a Worker (workerd freezes `Date.now()` between I/O, so
  // the timeout never trips and the platform CPU limit is what ends the step).
  // Costs the full timeout to run, hence the raised bun budget.
  test(
    'tail recursion escapes the stack guard and needs the timeout',
    async () => {
      const promise = executeTransformNode({
        node: node({ expression: '($f := function($x) { $f($x + 1) }; $f(0))' }),
        input: ROWS,
        nodeOutputs: new Map(),
      })
      await expect(promise).rejects.toThrow(/failed to evaluate.*timeout/s)
    },
    10_000,
  )

  test('rehydrate is applied to resolved values before the expression runs', async () => {
    const outputs = new Map<string, unknown>([['tool', { ref: 'blob://x' }]])
    const r = await executeTransformNode({
      node: node({
        source: { kind: 'ref', nodeId: 'tool', path: 'ref' },
        expression: '$ & "!"',
      }),
      input: undefined,
      nodeOutputs: outputs,
      rehydrate: async (v) => (v === 'blob://x' ? 'the real value' : v),
    })
    expect(r.output).toBe('the real value!')
  })
})
