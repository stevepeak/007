---
title: The graph — shape, edges and data flow
summary: The workflow JSON, what edges do (sequencing, never data), how bindings and ${variables} move data, and how a graph is validated.
order: 20
---

## TL;DR

- A workflow is `{ version: 1, nodes: [...], edges: [...] }`. It has exactly one `trigger` node and at least one `output` node.
- **Edges decide WHEN a node runs. Bindings decide WHAT it reads.** Agents, tools, Text, Transform, Branch/Switch values, Iteration lists and Outputs all read data through explicit bindings, never from an edge.
- A `ref` binding can read **any** earlier node's output by id, not only the node directly upstream. Any node output stays readable for the rest of the run.
- A ref also needs an edge path from the node it reads, or the read can race. See below.

## Shape

```json
{
  "version": 1,
  "nodes": [
    { "id": "t", "kind": "trigger", "label": "Start", "position": {"x":0,"y":0},
      "config": { "triggerKind": "manual" } },
    { "id": "a", "kind": "agent", "label": "Answer", "position": {"x":300,"y":0},
      "config": { "agentId": "…", "version": null,
                  "inputs": { "question": { "kind": "ref", "nodeId": "t", "path": "question" } } } },
    { "id": "o", "kind": "output", "label": "Reply", "position": {"x":600,"y":0},
      "config": { "source": { "kind": "ref", "nodeId": "a", "path": "" } } }
  ],
  "edges": [
    { "id": "e1", "source": "t", "target": "a", "condition": null },
    { "id": "e2", "source": "a", "target": "o", "condition": null }
  ]
}
```

Every node has `id` (unique across the whole graph, *including* iteration subgraphs), `kind`, `label`, `position` (canvas only) and `config` (kind-specific; see [[nodes]]). Two fields are optional on every node: `informUser` (what the end user sees while it runs, see [[streaming]]) and `execution` (timeout, retries, best-effort, background, see [[execution]]).

## Edges

| field | meaning |
| ----- | ------- |
| `id` | Unique edge id. |
| `source` | The node the edge leaves. |
| `target` | The node it enters. |
| `condition` | `null` on ordinary edges. Out of a decision node it names the arm: `"yes"`/`"no"` from a Branch (or a yes/no agent), a case key or `"else"` from a Switch. An unconditioned edge out of a Branch is always live, so it fires on both results, and the runtime gate rejects it. |
| `fastTrack` | Optional. Puts the edge on the priority path: the walk finishes the marked path, and whatever it needs, before starting unrelated ready nodes. This holds work back, so it is more than a scheduling preference. See [[execution]]. |

Edges carry readiness and routing only. How many incoming edges a node waits for (all of them, except Race) is covered in [[execution]].

## Bindings

A binding is one of two things:

- `{ "kind": "literal", "value": <any JSON> }`: a constant.
- `{ "kind": "ref", "nodeId": "<id>", "path": "<dotted.path>" }`: reads that node's output. `path` walks object keys and array indexes (`documents.0.id`). An empty `path` means the whole output. A missing key resolves to `undefined`.

Bindings live in node config: agent `inputs` / `conversation` / `source`, tool `args`, Text and Transform `inputs`, Branch/Switch/Iteration/Output `source`, Workflow-call `inputs`, Passthrough `value`/`fields`.

**What a ref can read.** The trigger's output is the run's validated input, so `{ nodeId: <trigger>, path: "messages" }` reads a field of the event payload. Every other node's output is documented on its page under [[nodes]]. Note that Branch and Switch output their *decision* (`{ result, reasoning }`), not the data they looked at. To read the data, ref the node that produced it.

**When a ref fails at run time.** If the referenced node never ran (a branch routed around it) or is not in this graph, the consuming node fails, and the error names both nodes. A ref to a node with **no edge path** to the consumer is a lint warning ("nothing connects that node to this one"). It may work when the producer happens to finish first and fail when it does not, so connect it upstream.

## `${variables}`

Agent prompts (system and user message) and Text bodies use `${name}` placeholders. A name is letters, digits, `_` and `-`, with no spaces.

- On an **agent node**, each `${name}` is filled from `config.inputs[name]` (a binding). Run-level prompt variables supplied by whoever started the run also fill names, and a node binding overrides a run-level value of the same name.
- A non-string value is JSON-stringified, and `null`/missing becomes `""`.
- An **unbound** `${name}` reaches the model as the literal text `${name}`. The editor raises it as an issue.
- The agent's input contract is the union of variables across its system prompt and its user message. `get_agent` lists them.

## What uses the edge's value

Most kinds ignore the edge-delivered value entirely. A few consume the "forwarded input". That value is the single upstream's output, or an object keyed by source node id when several edges are live:

- **Race** passes through the winner's value, and **Aggregate** passes through the list of every live upstream's output.
- **Passthrough** and **Feature request** can emit it unchanged.
- **Workflow-call** with empty `inputs` hands it to the callee as its trigger input.
- A **decision agent** node with no `source` judges it.

Prefer explicit refs. They survive the graph being rewired.

## Validation: two gates

1. **Shape** (on every draft save). Nodes and edges must be well formed, with known kinds and valid config shapes. A draft with integrity problems still saves.
2. **Integrity** (at publish over MCP, and when a run starts). The graph needs exactly one trigger and at least one Output, unique ids, no edges to missing nodes, and refs to existing nodes. Switch and Branch edges must carry valid conditions. Iteration subgraphs must start with an `iteration_item` trigger and contain no nested iteration. Joins must be legal:
   - An **Output may not merge parallel paths.** Only mutually exclusive branch arms may share one Output.
   - A **work node may not join both arms of one Branch.** It would wait forever for the dead arm.

`validate_workflow_graph` lints a draft, a published version or a graph you pass in. It runs the editor's Issues checks plus the runtime gate (prefixed "Runtime check:"), and adds checks only the server can make: Tool-node args against the live tool catalog, and agent pointers or pins that do not resolve. Errors are runs that will fail. Warnings are runs that might. `publish_workflow` refuses while any error stands. How to edit safely is in [[authoring]].
