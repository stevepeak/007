---
title: Workflow (call) node
summary: Call another published workflow as its own child run and use its Output as this node's output.
order: 74
---

A Workflow node calls another workflow and waits for its answer. Like an agent node it is a pointer by id. It floats to the callee's **latest published version**, which is frozen into the run manifest when the parent run starts (see [[versioning]]).

## Config

| Key | Default | Meaning |
| --- | ------- | ------- |
| `workflowId` | `""` | The callee's workflow id (from `list_workflows`). Empty is an authoring error. |
| `inputs` | `{}` | The callee's trigger input. **Empty:** the node's raw incoming input is passed through as-is (a single upstream's output, or `{ [sourceId]: output }` with several edges; see [[execution]]). **Non-empty:** an object built field by field, each value a binding, `{ kind: "literal", value }` or `{ kind: "ref", nodeId, path }`. Prefer explicit `inputs`. |

## Output

The callee's Output value, exactly as its Output's `source` resolved. Step meta records the callee's `workflowId`, `versionId`, `versionNumber`, `name`, and, when it ran as its own run, `childRunId` and the `engine` it ran on.

## Behavior and gotchas

- **The callee is always its own child run**: its own `wf_run`, linked back to the parent run and node, executing on the engine **the callee's own trigger** declares (`inline` or `durable`). The caller cannot choose the engine; there is deliberately no per-call setting. Open the child with `get_run` on `childRunId`.
- Exception: a Workflow node inside an `inline` iteration item can't start a run, so there the callee's graph runs inline as a subgraph of the item, with no child run.
- **Boundary checks are skipped for a callee.** Its trigger input is not validated against its trigger's input schema, and its Output is not checked against its trigger's output contract. It answers to the calling node, not to a host. Make sure the `inputs` you build match what the callee's nodes read.
- The parent waits until the callee **answers** (reaches its Output). The callee's own background arms may still be draining when the parent moves on.
- Reference cycles (A calls B calls A) are rejected when the run manifest is resolved, before anything executes.
- Timeout defaults to 20 minutes, like an agent, and covers the whole callee. The wait on the child is not retried. A callee that fails fails this node, and `continueOnError` applies as usual.
- Identity: the child derives its own actor from its trigger where the host supports that; otherwise it inherits the parent's.

```json
{ "id": "call-enrich", "kind": "workflow", "label": "Enrich contact",
  "position": { "x": 0, "y": 0 },
  "config": { "workflowId": "<workflow id>",
              "inputs": { "email": { "kind": "ref", "nodeId": "trigger", "path": "email" } } } }
```
