---
title: On Failure node
summary: The workflow's failure handler — a detached root whose outgoing edges each name why the run stopped; the matching arm runs as a child run on its own engine.
order: 66
---

An `on-failure` node holds what should happen when the run **fails or is cancelled**: cleanup, a notification, a compensating write. It is a second root on the canvas, detached from the main graph. It never runs in the main walk. When the run stops, the engine cuts out the arm for that failure's route and runs it as a **child run** of the failed run, on the engine the node names.

## Config

| key | meaning |
| --- | ------- |
| `engine` | `durable` (default) or `inline`, the engine the handler run executes on. Independent of the trigger's engine. Cleanup that has to happen wants `durable`. |

## Routes

Every outgoing edge sets `condition` to one route. An unconditioned edge is rejected: there is no catch-all, so wire every route you care about. Connecting several routes to the same node is the way to handle them alike.

| route | when |
| ----- | ---- |
| `timeout` | A node ran past its timeout or its agent's time budget; a 408/504 from a provider. |
| `rate_limited` | A provider answered 429, or said "rate limit" / "too many requests". |
| `external_error` | A service the run depends on failed or refused: a 5xx, a network error, or a 4xx such as a bad key or an unknown model. |
| `internal_error` | Anything else, including a stalled graph. An error nobody classified lands here. |
| `invalid_output` | The model answered but the answer was unusable: no object generated, a parse failure, or an Output that broke the trigger's output contract. |
| `invalid_input` | Input failed schema validation (a `ZodError`). |
| `limit_exceeded` | A limit that retrying cannot fix: the node budget, an iteration over `maxItems`, a 402 or exhausted credits. |
| `cancelled` | Someone called `cancel_run` (or the host's `cancelRun`). This route always wins: a run that was asked to stop is `cancelled` whatever its last node threw. |

Each failure takes exactly one route. A route with no edge does nothing; no run is started. A tool can pick its own route by throwing an error whose `failureRoute` property is one of the names above.

## Output

The node's output, and so what its arm binds to with a `ref` to the node, is the failure:

```json
{
  "route": "cancelled",
  "error": "Run cancelled.",
  "runId": "<the failed run>",
  "failedNodeId": "<the node that failed, when one did>",
  "statusCode": 429,
  "cancelledBy": { "kind": "user", "id": "<host principal>" },
  "input": { "...": "the failed run's own trigger input" }
}
```

`statusCode` is present only when the live provider error was still in hand. On the durable engine it often is not, because an error that crosses a step boundary loses everything but its message.

## Behavior and gotchas

- **Detached.** At most one per workflow, never inside an iteration subgraph, no incoming edges. No edge may join a handler node to a main-graph node, and refs may not cross between them in either direction. The handler can read only the failure and its own nodes; take what you need from `input`.
- **No Output.** The handler has no answer. Its run ends `completed` when its arms finish, or `failed` if one of its nodes fails. A failed handler does not start another handler.
- **Pruned per route.** Only the nodes reachable from the fired route's edges are in the handler run. A node wired from both `timeout` and `cancelled` waits on just the edge that fired.
- **When it runs.** After the run is recorded as failed or cancelled, after any in-flight nodes have landed, and after the host's `onRunFailed`. Never for an eval run, and never for a failure in the drain after the answer was delivered: that run kept its answer.
- **Cancel is cooperative.** A cancelled run starts no new node. Nodes already running land first, so the handler sees everything they wrote. Child runs are cancelled with their parent.
- **Retries.** A `retry_run` of a failed run is a new run. If it fails too, the handler runs again, so write handler tools to be idempotent.
- The handler run shows up as a child of the failed run, under the reserved trigger kind run_failure.

```json
{
  "nodes": [
    { "id": "fail", "kind": "on-failure", "label": "On failure", "position": { "x": 0, "y": 400 }, "config": { "engine": "durable" } },
    { "id": "cleanup", "kind": "tool", "label": "Delete partial results", "position": { "x": 300, "y": 400 },
      "config": { "toolId": "delete_partial_results", "args": { "id": { "kind": "ref", "nodeId": "fail", "path": "input.id" } } } }
  ],
  "edges": [
    { "id": "e1", "source": "fail", "target": "cleanup", "condition": "cancelled" },
    { "id": "e2", "source": "fail", "target": "cleanup", "condition": "internal_error" }
  ]
}
```
