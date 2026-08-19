import { MockLanguageModelV3 } from 'ai/test'
import { describe, expect, test } from 'bun:test'

import type { AgentNode, WfRunManifestEntry } from '../graph'
import type { StreamSink } from '../stream-sink'

import { executeAgentNode } from './agent'

// A structured (`generateObject`) call can come back unusable without the AI
// SDK retrying it: `maxRetries` covers transport rejections, not a response
// that arrives intact and isn't the object the schema asked for. Sentry WEB-C
// is the live case — the `titles` agent got back a lone `{`, one parse error
// short of a whole document's worth of work, and the only recovery was the
// dispatch replaying the entire node closure after a backoff.
//
// So the call is re-issued in place, once. These tests pin both halves: a flake
// recovers without the caller ever seeing it, and a failure that survives the
// re-issue still propagates rather than looping.

const MANIFEST: WfRunManifestEntry[] = [
  {
    kind: 'agent',
    id: 'lister',
    pinnedVersion: null,
    versionId: 'v1',
    versionNumber: 1,
    name: 'Lister',
    config: {
      modelId: 'mock',
      prompt: 'List the titles.',
      userPrompt: 'Go.',
      inputKind: 'task' as const,
      toolIds: [],
      maxTurns: 1,
      output: {
        kind: 'object',
        schema: {
          type: 'object',
          properties: { titles: { type: 'array', items: { type: 'string' } } },
          required: ['titles'],
          additionalProperties: false,
        },
      },
    },
  },
]

const NODE: AgentNode = {
  id: 'titles',
  kind: 'agent',
  label: 'List titles',
  position: { x: 0, y: 0 },
  informUser: { mode: 'off' },
  config: { agentId: 'lister', version: null, inputs: {}, imageInputs: {} },
}

const GOOD = JSON.stringify({ titles: ['Bitterballen', 'Stamppot'] })

/** A model that hands back `replies` in order, one per call. `finishReason`
 * follows the content: a truncated body is what `length` looks like.
 *
 * It goes back as `{ unified }`, not the bare string most of this suite's mocks
 * use — the SDK reads `finishReason.unified`, so a string silently arrives as
 * `undefined`, which is exactly the field under test here. */
function scripted(replies: string[], calls: { n: number }) {
  return new MockLanguageModelV3({
    doGenerate: async () => {
      const text = replies[calls.n] ?? replies[replies.length - 1] ?? ''
      calls.n++
      return {
        content: [{ type: 'text' as const, text }],
        finishReason: { unified: text === GOOD ? 'stop' : 'length' },
        usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 },
        warnings: [],
      } as never
    },
  })
}

function run(replies: string[], calls: { n: number }, sink?: StreamSink) {
  return executeAgentNode<unknown>({
    node: NODE,
    input: 'a menu',
    getModel: () => scripted(replies, calls),
    toolRegistry: new Map(),
    toolDeps: {},
    promptVariables: {},
    nodeOutputs: new Map(),
    manifest: MANIFEST,
    sink,
  })
}

describe('structured agent — re-issues an unusable response', () => {
  test('a truncated body is re-issued and the node succeeds', async () => {
    const calls = { n: 0 }
    const logs: string[] = []
    const sink: StreamSink = {
      log: async ({ message }) => {
        logs.push(message)
      },
    }

    const r = await run(['{', GOOD], calls, sink)

    expect(r.output).toEqual({ titles: ['Bitterballen', 'Stamppot'] })
    expect(calls.n).toBe(2)
    // The retry is otherwise invisible — `runGuarded` only logs the outcome of
    // the last attempt, so a run that flaked and recovered would look identical
    // to one that worked first time.
    expect(logs.some((m) => m.includes('re-issuing'))).toBe(true)
    expect(logs.some((m) => m.includes('finish: length'))).toBe(true)
  })

  // The dispatch's step-level retry is the backstop for a failure that isn't a
  // flake. Looping here instead would burn the node's whole budget re-asking a
  // model that is deterministically not answering.
  test('a second failure propagates instead of looping', async () => {
    const calls = { n: 0 }
    const err = await run(['{', '{'], calls).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(Error)
    expect((err as Error).name).toBe('AI_NoObjectGeneratedError')
    expect(calls.n).toBe(2)
  })

  test('a first-attempt success issues exactly one call', async () => {
    const calls = { n: 0 }
    const r = await run([GOOD], calls)

    expect(r.output).toEqual({ titles: ['Bitterballen', 'Stamppot'] })
    expect(calls.n).toBe(1)
  })
})
