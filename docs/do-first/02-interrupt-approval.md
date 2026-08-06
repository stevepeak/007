# 2 — Interrupt / approval-gate node (human-in-the-loop)

**Impact: High · Effort: M · Status: greenfield.**

The single biggest structural capability gap. Every serious agent platform
treats "pause the run, wait for a human, resume" as a first-class primitive
(LangGraph `interrupt()`/`Command(resume)`, Temporal signals). 007 has durable
execution and a live run viewer but no way to suspend a run pending a human
decision and resume it — so approvals, human-in-the-loop review, and
edit-then-continue are all impossible today.

**Leverage:** Cloudflare Durable Objects already hold run state and support the
`waitForEvent` / alarms APIs, so the hard part (durable suspension that survives
hibernation for hours/days at $0 idle cost) is nearly free. Stateless
competitors pay far more for this.

## Scope for v1

- A **`gate` node kind** (interrupt) that suspends the run, persists a pending
  request, and resumes when a human submits a payload.
- **Approval mode** as the first gate flavor: approve / reject / edit-and-approve
  a proposed value before downstream runs.
- **TTL + timeout behavior**: auto-approve / auto-reject / escalate on expiry
  (uses DO alarms).
- Run-viewer **actionable card** + a resume RPC.

Out of scope for v1 (later): human-as-a-tool (agent decides mid-loop to ask),
cross-run approval inbox, edit-arbitrary-state.

## Design

### Node kind

Add `'gate'` to `WF_NODE_KINDS` in `engine/graph-kinds.ts` and a
`gateNodeSchema` in `engine/graph-schema.ts`:

```ts
// config
{
  mode: 'approval',                 // v1 has one mode; leave room for more
  source?: RefBinding,              // the value being approved (data-picker ref)
  prompt?: string,                  // what the reviewer is asked
  timeout?: {
    afterMs: number,
    onExpiry: 'approve' | 'reject' | 'escalate',
  },
  // routing: like a decision node, a gate emits 'approved' | 'rejected'
  // so the two outgoing edges route on edge.condition (reuse the branch/switch
  // routing machinery in the scheduler — see DECISION_NODE_KINDS).
}
```

Add `'gate'` to `DECISION_NODE_KINDS` so its two arms route through the existing
conditional-edge mechanism — this reuses the scheduler routing already validated
for branch/switch instead of inventing new edge semantics.

### Scheduler / engine

- The gate is the first node that **does not resolve synchronously**. The
  scheduler's `next()` currently returns `execute | output | stall`. Add a
  `suspend` instruction (`{ type: 'suspend', node, pendingId }`) that the backend
  handles by parking the run — the pure scheduler stays I/O-free; it just knows
  "this node is awaiting an external event and is not stalled".
- On resume, the backend feeds the human payload back via `scheduler.report()`
  exactly like a normal node result, and the walk continues. Determinism holds:
  the resume payload is recorded, so replay is identical.

### Cloudflare runtime

- In `GraphWorkflow.run`, a gate node maps to `step.waitForEvent(name, { timeout })`
  keyed by the pending id, rather than `step.do`. Workflows' `waitForEvent`
  natively suspends the instance at $0 until the event or timeout — this is the
  whole reason the feature is cheap here.
- On timeout, apply `onExpiry` (approve/reject/escalate) deterministically.
- Escalate = re-arm with a new approver + fresh alarm (v1 can stub escalate as
  reject-with-note if an approver hierarchy doesn't exist yet).

### Storage

New table `wf_pending_input`:

```
id · run_id · node_id · mode · prompt · proposed_value (json)
status ('pending'|'resolved'|'expired') · resolution (json)
assigned_to (opaque host ref, nullable) · created_at · expires_at · resolved_at
```

- Written when the gate suspends; updated on resume/expiry.
- `(run_id, node_id)` unique → idempotent with the existing recorder discipline.

### Server / RPC

- `getPendingInputs(runId)` and `resolvePendingInput({ pendingId, resolution })`
  on `WfDataClient`.
- `resolvePendingInput` validates the payload, writes `wf_pending_input`, then
  fires the Workflow event (`instance.sendEvent`) that unblocks `waitForEvent`.
- Host gates auth on the resolve route (who may approve) — same pattern as the
  rest of the server layer.

### UI

- **RunViewer**: when a run is parked on a gate, render an actionable card
  (approve / reject / edit-and-approve) showing `proposed_value` and `prompt`.
  The run is already watched live over `RunRoom`, so the card appears without a
  reload; resolving posts the RPC and the run resumes.
- Editor: gate node in the palette + inspector (source ref, prompt, timeout).

## Effort & risks

- **M.** The new `suspend`/`waitForEvent` seam is the only architecturally novel
  part; everything else (node kind, table, RPC, card) follows existing patterns.
- Risk: the scheduler must distinguish "suspended, awaiting event" from "stalled"
  (a real dead-end) — get `WorkflowStalledError` vs. suspend right, with tests
  mirroring `scheduler-routing.test.ts` / `scheduler-join.test.ts`.
- Risk: resume must be replay-safe — record the resolution as the node output so
  a `step.do` replay after resume is deterministic.

## Acceptance criteria

- A workflow with a gate node parks at the gate; `getPendingInputs` returns it;
  `resolvePendingInput({ resolution: 'approved' })` resumes the run down the
  `approved` edge; the resolution is visible in the step trace.
- A gate with `timeout.onExpiry: 'reject'` auto-routes the `rejected` edge after
  `afterMs` with no human action.
- The in-process eval executor can drive a gate deterministically by supplying a
  canned resolution (so gates are testable without Cloudflare).
