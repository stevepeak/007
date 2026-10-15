---
title: Output node
summary: Names the run's answer with an explicit source ref; fires on the first live incoming edge; the run is `done` there and `completed` after the rest drains.
order: 61
---

The `output` node ends the answer phase of a run and names **the value the caller receives**. Every workflow is created with one. The value comes from `config.source` — an explicit ref into any upstream node's output — not from whatever is wired into it. The incoming edge only decides *when* it fires.

## Config

| key | meaning |
| --- | ------- |
| `source` | A ref binding `{ "kind": "ref", "nodeId": "<id>", "path": "<path>" }` naming the answer. Required in practice: an Output with no `source` is flagged by `validate_workflow_graph` and throws if a run reaches it. `path: ""` returns that node's whole output. |

## Output

The resolved `source` value becomes the run's output (`wf_run.output`, what `get_run` shows, what a calling workflow receives). If the trigger declares an **output contract**, the value is parsed against it at the end of the run and the run fails if it doesn't match — e.g. a contract of `{ text }` is satisfied by binding `path: ""` on a text agent (whose output is `{ text }`), or `path: "text"` if the contract wants a bare string. A workflow entered as a callee skips the contract check; the caller gets the raw value.

## Behavior and gotchas

- **Fires on ANY live incoming edge, not all.** Unlike work nodes (which wait for every live parent), an Output becomes reachable as soon as one incoming edge is live. Several edges into one Output are only for converging **mutually exclusive** branch arms, where only one is ever live; an Output that merges parallel paths is a validation error ("Merges parallel paths"). If you need "release only after X, Y and Z", make the Output's only parent a node that itself depends on X, Y and Z (an `aggregate`, or any work node with all three as parents) — see [[execution]].
- **Several Outputs are legal** (one per branch arm). The first reachable one in graph declaration order wins; the others are ignored.
- **`done` vs `completed`.** Reaching the Output marks the run `done`: the answer is final and whoever is waiting is released immediately. Nodes that don't feed the Output keep running (the *drain*), and only then is the run `completed`. A failure during the drain does not fail the run — the answer already went out; it is reported as a drain error. Anything waiting for the answer must treat `done` as finished.
- **Streaming.** On the `inline` engine, the agent named by `source` (the "answer node") streams its text to a waiting reader as it is generated — *before* the Output fires and before any later checks run. To hold an answer until checks pass, point `source` at a node downstream of the checks (for example a `text` or `passthrough` node that copies the agent's text), so the drafting agent is not the answer node. See [[streaming]].
- A run whose routing sends every live path away from all Outputs ends with no output (an intentional "fizzle"); if no routing decision ever fired, that is reported as a stalled graph.
- `informUser` and `execution` have no effect here.

```json
{
  "id": "output",
  "kind": "output",
  "label": "Answer",
  "position": { "x": 900, "y": 0 },
  "config": { "source": { "kind": "ref", "nodeId": "reply-agent", "path": "" } }
}
```
