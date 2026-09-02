import { describe, expect, test } from 'bun:test'

import {
  MAX_ROUND_TRIP_MS,
  MIN_TOTAL_MS,
  modelBudgetFor,
  STEP_TIMEOUT_SLACK_MS,
} from '../engine/model-budget'

import { calleeEventType, toCalleeWire } from './callee-protocol'
import { AI_STEP_OPTS } from './graph-workflow-dispatch-step-opts'
import { runContextFor } from './run-context'

// Assertions that genuinely span the engine↔cloudflare seam.
//
// They live HERE, not in `src/engine`, because the dependency rule is one-way:
// cloudflare may import engine, never the reverse. These same three tests used
// to sit in engine/model-budget.test.ts and engine/execution-modes.test.ts
// reaching UP into ../cloudflare — the only two breaches of that rule anywhere
// in src/, and the kind of thing that reads as precedent once it exists. The
// coverage is worth keeping; the direction was what needed fixing.

describe('agent step timeout ↔ model budget', () => {
  test('the shipped agent step timeout leaves a usable budget', () => {
    // Guards the two constants drifting apart: if the step timeout were ever
    // lowered to at-or-below the slack, every agent node would silently collapse
    // to the floor budget.
    expect(AI_STEP_OPTS.timeout).toBeGreaterThan(STEP_TIMEOUT_SLACK_MS)
    const b = modelBudgetFor(AI_STEP_OPTS.timeout)
    expect(b.totalMs).toBeGreaterThan(MIN_TOTAL_MS)
    expect(b.stepMs).toBe(MAX_ROUND_TRIP_MS)
  })
})

describe('callee handshake', () => {
  // A parent can have several callees parked at once. Keying the event
  // type on the node id is what stops one node's completion waking a sibling —
  // which would hand that sibling the wrong workflow's output.
  test('each calling node parks on its own event type', () => {
    expect(calleeEventType('a')).not.toBe(calleeEventType('b'))
    expect(calleeEventType('a')).toBe(calleeEventType('a'))
  })

  // `undefined` is what a callee whose Output fizzled out returns. It must
  // survive as a JSON `null` rather than an absent field, or the parent's
  // `JSON.parse` gets an empty string and throws — turning a legitimately
  // empty result into a crash in the caller.
  test('an empty callee result crosses the wire as null', () => {
    const wire = toCalleeWire({ ok: true, output: undefined })
    expect(wire).toEqual({ ok: true, outputJson: 'null' })
    expect(JSON.parse((wire as { outputJson: string }).outputJson)).toBeNull()
  })
})

describe('every engine stamps the run it is executing', () => {
  // The failure this guards is silent. `RunContext.runId` was added so a host
  // tool could name its own run — which is how a generated document is linked
  // back to the chat turn that produced it — and only the DURABLE backend was
  // given it. The inline runner (which is what our chat workflow actually runs
  // on) handed every tool an undefined id: no error, no failed run, just a null
  // column and a file that never appeared in the thread.
  //
  // Both backends now build the context through one constructor, so the test is
  // of that constructor rather than of two call sites remembering.
  test('the run id reaches the context the host receives', () => {
    const ctx = runContextFor(
      {
        runContext: { triggerKind: 'chat_message', subjectId: 'chat-1' },
        workflowRunId: 'run-1',
      },
      { DB: 'binding' },
    )
    expect(ctx.runId).toBe('run-1')
    // …without disturbing anything the caller already put on it.
    expect(ctx.subjectId).toBe('chat-1')
    expect(ctx.triggerKind).toBe('chat_message')
    expect(ctx.env).toEqual({ DB: 'binding' })
  })

  test('the manifest is added only once it is resolved', () => {
    const source = {
      runContext: { triggerKind: 'chat_message' },
      workflowRunId: 'run-1',
    }
    // Before resolution: no `manifest` key at all, rather than an empty one —
    // an agent node reads its frozen prompt from there, and an empty manifest
    // is a different thing from an absent one.
    expect('manifest' in runContextFor(source, {})).toBe(false)
    const manifest = [
      { kind: 'agent' as const, id: 'a1', version: 3, name: 'A', config: {} },
    ]
    expect(
      runContextFor(source, {}, { manifest: manifest as never }).manifest,
    ).toEqual(manifest as never)
  })
})
