// The parent↔child protocol for a workflow-call node running its callee as its
// own workflow instance (`calleeExecution: 'durable'`).
//
// Deliberately free of any `cloudflare:*` import: it is pure data shared by the
// two halves of the handshake — the parent parked on `waitForEvent` and the
// spawned child that wakes it — which also keeps it testable outside workerd.

/** What a spawned callee reports back, in engine terms. */
export type CalleeDoneEvent =
  | { ok: true; output: unknown }
  | { ok: false; error: string }

/**
 * The same thing on the wire. The output travels JSON-ENCODED because an event
 * payload must be structured-cloneable while a node's output is `unknown` — but
 * also because it keeps the boundary honest: this value already round-tripped
 * through JSON on the inline path (a `step.do` return is journaled as JSON), so
 * encoding changes nothing about what a callee may return, and the 1 MiB
 * event-payload cap matches the step-return cap it replaces.
 */
export type CalleeDoneWire =
  | { ok: true; outputJson: string }
  | { ok: false; error: string }

/**
 * The event type one calling node parks on. Keyed by node id because a parent
 * can have several durable callees in flight at once: a shared type would let
 * whichever finished first wake every waiter, handing each the wrong callee's
 * output — a silent data mix-up rather than a visible failure.
 */
export function calleeEventType(nodeId: string): string {
  return `wf-callee-done:${nodeId}`
}

export function toCalleeWire(payload: CalleeDoneEvent): CalleeDoneWire {
  return payload.ok
    ? { ok: true, outputJson: JSON.stringify(payload.output ?? null) }
    : payload
}
