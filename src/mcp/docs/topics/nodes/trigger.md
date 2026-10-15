---
title: Trigger node
summary: How a run starts — the trigger kind, cron schedule, and which engine executes the run; its output is the run's input.
order: 60
---

Every graph has exactly one `trigger` node, created with the workflow; you cannot add or remove one. It does not execute: at run start the engine marks it complete and sets its output to the run's input. Every other node reaches the run input by a `ref` to the trigger's id.

## Config

| key | meaning |
| --- | ------- |
| `triggerKind` | How the workflow starts. `manual` (a person starts it; no payload schema), `periodic` (a cron schedule; requires `cron`), or a host-declared **event** kind. `list_trigger_events` lists the event kinds this host declares, with each one's input fields and output contract. `iteration_item` is reserved for the trigger inside an iteration subgraph — never author it. |
| `cron` | Cron expression. Required when `triggerKind` is `periodic`, ignored otherwise. A periodic trigger without one fails validation. |
| `engine` | `durable` or `inline`. Absent means `durable`. Applies to the **whole run**. `durable`: every node is a journaled step — survives eviction, retries replay, a failed run can be resumed; slower to start, and cannot stream the answer. `inline`: one process walks the graph — much lower latency, can stream the answer token by token, no step-level replay. Interactive work (chat) wants `inline`; long batch work wants `durable`. See [[execution]] and [[streaming]]. |

## Output

The run's input, after validation:

- **Event kinds:** the input is validated against the event's input schema before any node fires; the trigger's output is the parsed value. Ref its fields by path, e.g. `{ "kind": "ref", "nodeId": "trigger", "path": "messages" }`.
- **`manual` / `periodic`:** the input is passed through untouched (no schema).
- **When this workflow is called by another workflow** (a `workflow` node), the input is seeded raw — the event schema is not re-checked. See [[nodes/workflow]].
- **Inside an iteration subgraph** (`iteration_item`): the output is the current list element.

## Behavior and gotchas

- The trigger kind also decides the **output contract**: an event may declare a schema the final answer must satisfy (for example `{ text }`). The run fails at the end if the Output's value doesn't match. See [[nodes/output]] and [[triggers]].
- Changing `engine` is a graph change — it is versioned with the workflow and takes effect for runs of the newly published version.
- `informUser` and `execution` have no effect here.

```json
{
  "id": "trigger",
  "kind": "trigger",
  "label": "New message",
  "position": { "x": 0, "y": 0 },
  "config": { "triggerKind": "chat_message", "engine": "inline" }
}
```
