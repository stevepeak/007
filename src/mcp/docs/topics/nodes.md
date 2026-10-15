---
title: Nodes
summary: What every node carries, how nodes are addressed by refs, the full node-kind dictionary, and which node to reach for.
order: 59
---

A workflow graph is a list of nodes and a list of edges. **Edges carry sequencing, never data**: a node reads upstream values only through explicit bindings (a `ref` into some upstream node's output, or a `literal`). See [[graph]] for bindings and [[execution]] for when a node fires.

## Fields every node carries

| field | meaning |
| ----- | ------- |
| `id` | Stable, unique string. This is what refs, edges and the run trace use. Never reuse an id for a different node. |
| `kind` | One of the kinds below. Decides the `config` shape. |
| `label` | Display name. Shown in the run viewer, progress feed and error messages ("`"Extract text" (tool)`"). Required, non-empty. |
| `position` | `{ x, y }` on the canvas. Editor-only; no effect on execution. |
| `config` | Kind-specific. Each `nodes/<kind>` page lists every key. |
| `informUser` | What the end user sees while this node runs: `{ mode: 'off' }` (default), `{ mode: 'static', note }` (a fixed line, may use run-level `${vars}`), or `{ mode: 'dynamic', reasoning, tools }` — **agents only** — streaming the agent's reasoning and/or tool-call announcements. See [[streaming]]. |
| `execution` | Optional per-node policy: `continueOnError`, `timeoutMs`, `background`, `retries`. See [[execution]]. |

Bookend kinds (`trigger`, `output`, `note`) never execute as steps, so `informUser` and `execution` mean nothing on them. `informUser` on a node *inside* an iteration subgraph never reaches the user either — set it on the iteration node.

## Addressing a node from a binding

A ref binding is `{ "kind": "ref", "nodeId": "<id>", "path": "<dotted path>" }`.

- `path: ""` means the node's **whole** output.
- `path` walks object keys and numeric array indices: `"documents.0.id"`, `"messages"`, `"text"`.
- A missing key resolves to `undefined` (no error); a ref to a node that has **not produced an output** in this run (a dead branch arm, a node not yet run) throws, naming both nodes.
- Any upstream node's output is reachable, not only the immediate parent's. Outputs are global to the run.

A literal binding is `{ "kind": "literal", "value": <any JSON> }`.

## The node kinds

{{node-kinds}}

## Choosing a node

| you need to… | use |
| ------------ | --- |
| call an LLM (generate text, a structured object, a yes/no, or a rubric decision) | `agent` → [[nodes/agent]] |
| call a registered tool directly, no LLM | `tool` → [[nodes/tool]] |
| write deterministic prose with `${values}` filled in | `text` → [[nodes/text]] |
| reshape data (map rows to messages, concatenate, pick the last N items) | `transform` → [[nodes/transform]] |
| re-emit an upstream value in a chosen shape, e.g. to make two arms match | `passthrough` → [[nodes/passthrough]] |
| route yes/no on a deterministic test | `branch` → [[nodes/branch]] |
| route many ways on one value | `switch` → [[nodes/switch]] |
| wait for **all** of several producers, then continue | `aggregate` → [[nodes/aggregate]] (or simply give the next node several incoming edges — every work node already waits for all live parents) |
| continue as soon as the **first** of several producers finishes | `race` → [[nodes/race]] |
| run a subgraph once per list item | `iteration` → [[nodes/iteration]] |
| call another workflow and use its answer | `workflow` → [[nodes/workflow]] |
| name the run's answer | `output` → [[nodes/output]] |
| leave a comment on the canvas | `note` → [[nodes/note]] |
| park an idea for a node that doesn't exist yet | `feature-request` → [[nodes/feature-request]] |

**The Output does not wait for everything.** It fires as soon as *any* of its incoming edges is live, and its value is whatever its `config.source` names. If the answer must only be released after several checks pass, put a join (or a node that depends on every check) between the checks and the Output, and point `config.source` at a node downstream of that join. See [[nodes/output]] and [[execution]].
