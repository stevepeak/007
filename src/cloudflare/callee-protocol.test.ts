import { describe, expect, test } from 'bun:test'

import {
  assertValidEventType,
  calleeEventType,
  toCalleeWire,
  WF_EVENT_TYPE_PATTERN,
} from './callee-protocol'

// NEW-179. Production Cloudflare rejects a `sendEvent` type containing a colon
// with `(workflow.invalid_event_type)`; local miniflare accepts one. That gap
// is why `wf-callee-done:${nodeId}` shipped and sat latent — nothing local
// could have caught it. These tests are the local thing that now does.

const NODE_ID = '7f3a1c2e-9b04-4d15-8a6f-2e5c0b71d934'

describe('calleeEventType', () => {
  test('separates with a hyphen, never a colon', () => {
    const type = calleeEventType(NODE_ID)

    expect(type).toBe(`wf-callee-done-${NODE_ID}`)
    // The specific character that failed in production, asserted by name so a
    // future edit that reintroduces it fails here rather than six hours into a
    // child instance's retry backoff.
    expect(type).not.toInclude(':')
    expect(type).toMatch(WF_EVENT_TYPE_PATTERN)
  })

  test('an indexed type is distinct per item and still valid', () => {
    const types = [0, 1, 2, 99].map((i) => calleeEventType(NODE_ID, i))

    expect(new Set(types).size).toBe(4)
    for (const t of types) expect(t).toMatch(WF_EVENT_TYPE_PATTERN)
    expect(types[0]).toBe(`wf-callee-done-${NODE_ID}-0`)
  })

  test('index 0 is not the same type as no index', () => {
    // A shared type lets whichever child finishes first wake the wrong waiter,
    // which is a silent wrong-output bug rather than a failure.
    expect(calleeEventType(NODE_ID, 0)).not.toBe(calleeEventType(NODE_ID))
  })

  test('stays well inside the 100-character cap at realistic widths', () => {
    expect(calleeEventType(NODE_ID, 999).length).toBeLessThanOrEqual(100)
  })

  test('refuses to mint a type from a node id that would be rejected', () => {
    // Node ids are UUIDs in practice, but an imported spec supplies them and
    // the schema only says `string` — so this is reachable, and failing at the
    // parent beats a child that retries silently.
    expect(() => calleeEventType('has:colon')).toThrow(
      'is not a valid Cloudflare Workflows event type',
    )
    expect(() => calleeEventType('a'.repeat(200))).toThrow('not a valid')
  })
})

describe('assertValidEventType', () => {
  test('accepts what production accepts', () => {
    expect(() => assertValidEventType('wf-callee-done-abc-1', 'ctx')).not.toThrow()
  })

  test.each([
    ['a colon', 'wf-callee-done:abc'],
    ['a slash', 'wf/callee'],
    ['a dot', 'wf.callee'],
    ['an underscore', 'wf_callee'],
    ['a space', 'wf callee'],
    ['empty', ''],
  ])('rejects %s', (_label, candidate) => {
    // Only `-` and alphanumerics are verified against a real deploy. The rest
    // are unverified, so they are rejected rather than assumed — widening this
    // needs evidence from production, not from a local run.
    expect(() => assertValidEventType(candidate, 'ctx')).toThrow()
  })

  test('names the offending type and the context in the message', () => {
    expect(() => assertValidEventType('bad:type', 'Reporting to parent')).toThrow(
      /Reporting to parent: "bad:type"/,
    )
  })
})

describe('toCalleeWire', () => {
  test('JSON-encodes a success payload and passes a failure through', () => {
    expect(toCalleeWire({ ok: true, output: { a: 1 } })).toEqual({
      ok: true,
      outputJson: '{"a":1}',
    })
    expect(toCalleeWire({ ok: false, error: 'boom' })).toEqual({
      ok: false,
      error: 'boom',
    })
  })
})
