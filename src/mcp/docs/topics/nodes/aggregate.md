---
title: Aggregate node
summary: Wait-for-all join — fires when every incoming edge is live and emits their outputs as one ordered list.
order: 72
---

An Aggregate waits for **all** of its upstreams (the ordinary readiness rule), then emits a list with one element per incoming edge. It is the wait-for-all sibling of [[nodes/race]], and the simplest answer to "continue only after X, Y and Z have all finished".

## Config

None. `config` is `{}`.

## Output

An array: `[outputOfFirstEdge, outputOfSecondEdge, …]`, in **edge-declaration order** (the order of the edges in the graph's `edges` array). It does not follow completion order or node order. Each element is that producer's whole output, never flattened. Shapes need not match. A single producer gives a one-element list. The step's meta records `count`.

To pick one result back out downstream, ref the aggregate by index (`path: "0"`), or ref the producer directly.

## Behavior and gotchas

- **Dead arms block it.** An Aggregate needs every incoming edge alive. If one producer sits on an untaken Branch/Switch arm, or failed, the Aggregate **never fires**, and neither does anything after it. It is skipped silently, not failed. Wiring both arms of one decision into it is rejected at validation. Exceptions:
  - an upstream with `execution.continueOnError: true` that fails still completes, with output `null`, so the Aggregate fires with a `null` in that slot
  - to collect "whichever arm ran", merge the arms with a Race first, then feed the Race into the Aggregate
- To run checks in parallel and release the answer only when all pass: checks → Aggregate → Branch/Switch on the results → Output. The Output's `source` should bind a node after the gate (see [[execution]] and [[streaming]]).
- Order is by edges, so if you rewire, check that downstream index refs (`path: "1"`) still point at the right producer.
- An Aggregate is not an iteration. To run something once per element, feed the list into an [[nodes/iteration]] via its `source`.

```json
{ "id": "all-checks", "kind": "aggregate", "label": "All checks",
  "position": { "x": 0, "y": 0 }, "config": {} }
```
With edges `check-a → all-checks`, `check-b → all-checks`, `check-c → all-checks` declared in that order, the output is `[checkA, checkB, checkC]`.
