---
title: Passthrough node
summary: Re-emits an upstream value — one binding unwrapped, an object of bindings, or its input untouched — so branch arms feed a join the same shape.
order: 67
---

A `passthrough` node produces a value in a shape the author controls, with no LLM, tool or I/O. Its main job is converging branch arms: a Branch emits its decision, not its input, and a Race forwards whichever arm wins — so an arm that "already has the data" needs a node that re-surfaces that data in the same shape the sibling arm produces. It is also the simplest way to copy a value into a new node, e.g. so the Output's `source` can name a node that sits downstream of a set of checks.

## Config

Three modes, checked in this order. Setting both `value` and `fields` is a validation error.

| key | meaning |
| --- | ------- |
| `value` | One binding (`ref` or `literal`). The output is that value, **unwrapped** — use it when the sibling arm emits a bare string, array or object. |
| `fields` | Map of key → binding. The output is an object with one key per binding — use it to match a sibling's `{ name, kind }`-style shape. |
| *(neither)* | Identity: the output is the node's incoming input. With one live parent that is the parent's output; with several, an object keyed by parent node id. |

## Output

As above. Blob-spilled values are read back first, so the output holds real values.

## Behavior and gotchas

- A passthrough does not wait any differently from other work nodes: it fires once **every** live incoming edge is complete. That makes it a cheap "gate": give it the checks as parents and bind `value` to the answer, and it emits the answer only after all checks finished. See [[execution]].
- It doesn't evaluate anything — to compute or reshape, use [[nodes/transform]]; to write text, [[nodes/text]].
- `informUser`: `off` or `static`.

```json
{
  "id": "release",
  "kind": "passthrough",
  "label": "Release answer",
  "position": { "x": 700, "y": 0 },
  "config": { "value": { "kind": "ref", "nodeId": "reply-agent", "path": "" } }
}
```
