---
title: Feature Request node
summary: A placeholder for a node that doesn't exist yet — records the idea and passes its input straight through.
order: 66
---

A `feature-request` node marks a spot in a graph where the author wants a capability that 007 doesn't have yet. It does no work: it forwards its input unchanged so the run continues. The description captures the idea so it isn't lost.

## Config

| key | meaning |
| --- | ------- |
| `description` | Free text describing the wished-for behavior. An empty description is a validation warning. |

## Output

Its incoming input, untouched. With one live parent that is the parent's output; with several live parents it is an object keyed by parent node id (the default multi-parent join shape — see [[execution]]). The run step records the description in its meta.

## Behavior and gotchas

- It does not appear in run progress counts.
- Since nodes read data by `ref`, a downstream node can usually ref the producer directly; the pass-through matters only for sequencing.
- `informUser`: `off` or `static`.

```json
{
  "id": "fr-1",
  "kind": "feature-request",
  "label": "Dedupe results",
  "position": { "x": 300, "y": 0 },
  "config": { "description": "Drop search results already shown earlier in the thread." }
}
```
