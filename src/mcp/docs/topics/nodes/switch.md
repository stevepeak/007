---
title: Switch node
summary: Multi-way deterministic routing — the first case whose value matches wins, otherwise `else`.
order: 70
---

A Switch is the multi-way sibling of [[nodes/branch]]. It reads one value and compares it to each case **in order**. The first match picks that case's outgoing edge; if nothing matches, the `else` edge is taken. No LLM, fully reproducible. It is the normal way to route on a decision agent's `verdict` ([[agents/decision]]).

## Config

| Key | Type | Meaning |
| --- | ---- | ------- |
| `source` | ref binding, optional | The value to match. If omitted, the raw incoming input is used. Prefer binding it. |
| `cases` | array, default `[]` | Ordered `{ key, label?, value }` entries. `key` is the routing identity, and the outgoing edge's `condition` must equal it. The editor mints `A`, `B`, `C`…; keys must be unique and may not be `else`. `label` is purely cosmetic: it is the name shown on the edge, and renaming it never re-points anything. `value` is a binding: `{ kind: "literal", value }` or a `ref` to another upstream value the input must equal. |

## Matching rules

- The comparison is the same loose equality as Branch's `equals`: numeric if both sides parse as finite numbers, otherwise string comparison (JSON for objects).
- Cases are tested **in array order**. The first match wins, even if a later case would also match.
- Both the subject and any ref-valued case are rehydrated if they were spilled to storage.
- No match routes to `else`. If there is no `else` edge, that path fizzles. The editor flags a missing `else` as a warning, not an error.

## Output

`{ result: <winning case key or "else">, reasoning: string }`. Like Branch, a Switch does not forward its input.

## Behavior and gotchas

- Validation rejects: duplicate case keys, a case named `else`, a case with no outgoing edge, and an outgoing edge whose `condition` matches no case and isn't `else`.
- Only the edges of the winning case come alive. Nodes on the other arms never run, and the dead-arm rules in [[execution]] apply. In particular, a node fed by two arms of the same Switch can never fire; merge arms with a [[nodes/race]].
- `continueOnError` is ignored. A failure fails the run.

```json
{ "id": "route", "kind": "switch", "label": "Route by verdict",
  "position": { "x": 0, "y": 0 },
  "config": {
    "source": { "kind": "ref", "nodeId": "triage", "path": "verdict" },
    "cases": [
      { "key": "A", "label": "answer", "value": { "kind": "literal", "value": "answer" } },
      { "key": "B", "label": "escalate", "value": { "kind": "literal", "value": "escalate" } }
    ] } }
```
Edges: `condition: "A"`, `condition: "B"`, and `condition: "else"` for the fallback.
