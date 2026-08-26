import type { WfRunManifestEntry } from '../engine/graph'

import type { GraphWorkflowParams } from './graph-workflow'

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
 * What Cloudflare accepts as a `sendEvent` type, as far as we have established
 * it empirically.
 *
 * Production rejects a colon — `(workflow.invalid_event_type) Provided event
 * type is invalid` — while local miniflare accepts one, which is exactly how a
 * colon shipped in the first place (NEW-179). `-` and alphanumerics are
 * verified working; everything else is unverified, so this pattern is
 * deliberately narrower than whatever the real charset turns out to be. Widen
 * it only against evidence from a real deploy, never from a local run.
 *
 * The 100-char cap is documented. `wf-callee-done-` (15) + a UUID (36) + an
 * item suffix leaves ample room.
 */
export const WF_EVENT_TYPE_PATTERN = /^[A-Z0-9-]{1,100}$/i

/**
 * Refuse to mint or send an event type production would reject.
 *
 * Worth the check because of HOW the rejection surfaces: the error is thrown in
 * the CHILD's `report-to-parent` step, which then retries on the standard
 * backoff for hours, while the parent — the instance anyone would actually go
 * look at — sits on `waitForEvent` and eventually reports a generic
 * `WorkflowTimeoutError` naming nothing. The real cause lives in a different
 * instance's step history. Failing here instead makes it say what it is.
 */
export function assertValidEventType(eventType: string, context: string): void {
  if (!WF_EVENT_TYPE_PATTERN.test(eventType)) {
    throw new Error(
      `${context}: "${eventType}" is not a valid Cloudflare Workflows event type. ` +
        'It must be 1–100 characters of letters, digits and hyphens — a colon in ' +
        'particular is accepted locally and rejected in production.',
    )
  }
}

/**
 * The event type one waiting parent parks on.
 *
 * Keyed by node id because a parent can have several durable callees in flight
 * at once: a shared type would let whichever finished first wake every waiter,
 * handing each the wrong callee's output — a silent data mix-up rather than a
 * visible failure. A durable ITERATION extends the same reasoning one level
 * down, so `index` distinguishes the items of one iteration node from each
 * other. Node ids are fixed-length UUIDs, so an indexed type can't collide with
 * some other node's unindexed one.
 *
 * The separator is `-`, NOT `:`. See {@link WF_EVENT_TYPE_PATTERN}.
 */
export function calleeEventType(nodeId: string, index?: number): string {
  const eventType =
    index === undefined
      ? `wf-callee-done-${nodeId}`
      : `wf-callee-done-${nodeId}-${index}`
  assertValidEventType(eventType, `Workflow node ${nodeId}`)
  return eventType
}

/**
 * The params one iteration-item child instance is started with.
 *
 * Pure and exported for its test: two of the fields it sets are OPTIONAL on
 * {@link GraphWorkflowParams}, so omitting either compiles cleanly and then goes
 * quietly wrong at run time —
 *
 *   • no `subRun.iterationNodeId` → the child runs the parent's WHOLE graph
 *     instead of the one item's subgraph,
 *   • no `inheritedManifest` → the child re-resolves every floating reference,
 *     so a publish landing mid-run splits one logical run across two prompt
 *     versions.
 *
 * Neither announces itself. Building the object in one named place, with a test
 * that asserts both are present, is what stops that.
 */
export function iterationItemParams(args: {
  /** The PARENT run's params — the child takes its version and run context. */
  parent: GraphWorkflowParams
  manifest: WfRunManifestEntry[]
  parentInstanceId: string
  /** The iteration container's node id, in the parent's graph. */
  nodeId: string
  /** This item's element of the list. */
  item: unknown
  eventType: string
  childRunId: string
  roomId: string
}): GraphWorkflowParams {
  return {
    runId: args.roomId,
    workflowRunId: args.childRunId,
    // The PARENT's version. The child digs this iteration's subgraph out of it
    // by node id rather than being handed the graph — see `iterationSubgraphOf`.
    workflowVersionId: args.parent.workflowVersionId,
    // The item IS the subgraph's trigger output, exactly as `executeSubgraph`
    // seeds it inline. A sub-run is seeded raw, so the two paths hand the
    // subgraph the identical value.
    triggerInput: args.item,
    runContext: args.parent.runContext,
    inheritedManifest: args.manifest,
    subRun: {
      parentInstanceId: args.parentInstanceId,
      eventType: args.eventType,
      iterationNodeId: args.nodeId,
    },
  }
}

export function toCalleeWire(payload: CalleeDoneEvent): CalleeDoneWire {
  return payload.ok
    ? { ok: true, outputJson: JSON.stringify(payload.output ?? null) }
    : payload
}
