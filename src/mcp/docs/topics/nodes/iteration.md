---
title: Iteration node
summary: Run an embedded subgraph once per element of a list, in parallel up to a bound, and collect the results in order.
order: 73
---

An Iteration resolves a list from one upstream node and runs its own embedded **subgraph** once per element. Items run in parallel up to `concurrency`, and the output is the ordered list of per-item results. Use it for per-item LLM work: put an [[nodes/agent]] node inside the subgraph rather than writing a tool that loops.

## Config

| Key | Default | Meaning |
| --- | ------- | ------- |
| `source` | none | **Required.** A ref binding to the list, `{ kind: "ref", nodeId, path }`, pointing at any upstream node (for example `path: "documents"`). It must resolve to an array, or the node fails. It feeds from ONE node: to loop over several producers' results, put an [[nodes/aggregate]] (or a [[nodes/transform]]) in front. |
| `concurrency` | `4` | 1–20 items in flight at once. With `inline` items this bounds the shared CPU/subrequest budget. With `durable` items it throttles what the items hit (provider rate limits, the database). |
| `stopOnError` | `false` | `false`: a failed item's slot gets `{ "__iterationError": "<message>" }` and the rest run. `true`: the first failure stops new items from starting, waits for running ones (they are not killed), then fails the node. |
| `itemExecution` | `inline` | How ONE item runs (see below). |
| `itemTitle` | `""` | A `${path}` template naming each item in progress lines and the run viewer, resolved against the item, for example `${title}` or `${customer.name}`. Empty means "Item N". |
| `maxItems` | seeded `100` (inline) / `500` (durable) | The fence. A list longer than this fails the node **before any item runs**, and is not retried. Authoring ceiling: 500 inline, 1000 durable. Going over is flagged as an issue but still saves. A node with no value (only very old versions) runs with a permissive fallback of 1000. |
| `subgraph` | starter subgraph | A full graph (`version`, `nodes`, `edges`) whose trigger has `triggerKind: "iteration_item"` and whose Output names the per-item result. Nested iterations are not allowed. |
| `itemSchema` | none | Editor-only: the inferred JSON Schema of one element, used for binding pickers. The engine ignores it. |
| `width` / `height` | none | Editor-only canvas size of the container. |

### `itemExecution`

| | `inline` | `durable` |
| -- | -- | -- |
| One item runs as | one unit: a single step on the durable engine, a plain await on the inline engine | its own child run (its own instance and `wf_run`) |
| Failure partway through an item | the whole item repeats from the start, side effects included | per-node durable steps, so only the failed node retries |
| Inner nodes' `execution` (`timeoutMs`, `retries`, `continueOnError`) | **ignored** | applied |
| Inner nodes run | one at a time, in a simple walk | as a normal run |
| "Item finished" means | the item's whole subgraph drained | the item **answered**; its background arms may still be running |
| Cost | cheap per item | one run start per item |

Many items over a small subgraph favor `inline`. A few items over an agent plus several nodes favor `durable`. The issues panel flags a subgraph that is heavy for `inline`.

## Output

An array with one entry per input element, **in input order** regardless of finish order. Each entry is that item's Output value (from the subgraph Output's `source`), or `{ "__iterationError": "…" }` for a failed item when `stopOnError` is false. Step meta records `total`, `limit` and per-item status (`completed` / `failed` / `skipped`).

## Behavior and gotchas

- **An item sees only itself.** Inside the subgraph, the trigger's output IS the current element. Refs resolve only against nodes in the same item's subgraph; a ref to a node in the parent graph fails ("sits outside this subgraph"). To give items shared context, put it into each element upstream, for example with a [[nodes/transform]] that maps the list into `{ item, context }` objects.
- Node ids must be unique across the whole tree, including inside subgraphs.
- Per-item, per-node steps are recorded under the iteration node. In `get_run` they carry `parentNodeId` and `itemIndex`; open one with `get_run_step` by its cursor. The run viewer has an item picker. A `durable` item is also its own child run. Agents inside the subgraph are frozen into the run manifest like top-level ones.
- `informUser` on steps **inside** the subgraph never reaches the user (it is flagged). Set `static` on the iteration node itself: its note may use `${n}` / `${total}` for the item count, and it then reports "Processing <title> (i of n)" per item.
- The node's timeout (default 20 minutes) applies **per item**, not to the whole loop.
- An empty list is not an error: the output is `[]`.

```json
{ "id": "per-doc", "kind": "iteration", "label": "Summarize each document",
  "position": { "x": 0, "y": 0 },
  "config": {
    "source": { "kind": "ref", "nodeId": "fetch-docs", "path": "documents" },
    "concurrency": 4, "stopOnError": false, "itemExecution": "inline",
    "itemTitle": "${title}", "maxItems": 100,
    "subgraph": {
      "version": 1,
      "nodes": [
        { "id": "item", "kind": "trigger", "label": "Item", "position": { "x": 0, "y": 0 },
          "config": { "triggerKind": "iteration_item" } },
        { "id": "summarize", "kind": "agent", "label": "Summarize", "position": { "x": 0, "y": 100 },
          "config": { "agentId": "<agent id>", "inputs": { "doc": { "kind": "ref", "nodeId": "item", "path": "text" } } } },
        { "id": "item-out", "kind": "output", "label": "Result", "position": { "x": 0, "y": 200 },
          "config": { "source": { "kind": "ref", "nodeId": "summarize", "path": "" } } }
      ],
      "edges": [
        { "id": "e1", "source": "item", "target": "summarize" },
        { "id": "e2", "source": "summarize", "target": "item-out" }
      ] } } }
```
