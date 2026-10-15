---
title: Branch node
summary: Deterministic yes/no routing — a code predicate over one upstream value, no LLM.
order: 69
---

A Branch tests one value with a fixed operator and routes the run down its `yes` or `no` edge. It runs in plain code: no model, no I/O, fully reproducible. For a judgement call ("is this request in scope?") use an agent first and branch on its result, or use a Yes/No agent, which routes on its own (see [[agents]]).

## Config

| Key | Type | Meaning |
| --- | ---- | ------- |
| `source` | ref binding, optional | The value to test, as `{ kind: "ref", nodeId, path }` into any node that has already run. If omitted, the node's raw incoming input is tested (see [[execution]] for what that is with several incoming edges). Prefer binding it explicitly. |
| `operator` | enum, default `is_not_empty` | One of the operators below. |
| `value` | any, optional | The operand. Ignored by `is_empty` and `is_not_empty`. A missing operand on a value-taking operator is flagged as an issue. |

| `operator` | `yes` when… |
| ---------- | ----------- |
| `is_empty` | the value is `null`/missing, `""`, `[]` or `{}`. `0` and `false` are **not** empty. |
| `is_not_empty` | the opposite of `is_empty` |
| `equals` | loose equality: if both sides parse as finite numbers they compare numerically (`"3"` equals `3`); otherwise they compare as strings, with objects and arrays as their JSON |
| `not_equals` | the opposite of `equals` |
| `contains` | the value's string form (JSON for objects) contains the operand's string form. Case-sensitive. |
| `greater_than` / `less_than` | both sides parse as numbers and compare. Non-numeric gives `no`. |

Large values that were spilled to storage are rehydrated before the comparison, so the test sees the real text, not the storage pointer.

## Output

`{ result: "yes" | "no", reasoning: string }`, for example `reasoning: "classify.label equals \"urgent\" → yes"`. A Branch does **not** forward the data it tested. Downstream nodes that need that data should ref its producer directly.

## Behavior and gotchas

- Every outgoing edge must carry `condition: "yes"` or `"no"`. An edge with no condition is **rejected**: it would be live on both results, so the Branch would route nothing.
- Leaving one arm unconnected is legal. If that result comes up, the path fizzles (see [[execution]]).
- Nodes on the untaken arm never run. A node with edges from **both** arms is rejected because it could never fire. Merge the arms with a [[nodes/race]], or give each arm its own Output.
- `continueOnError` is ignored on a Branch. A routing decision has no safe default, so a failure fails the run.
- For more than two outcomes use [[nodes/switch]].

```json
{ "id": "is-urgent", "kind": "branch", "label": "Urgent?",
  "position": { "x": 0, "y": 0 },
  "config": { "source": { "kind": "ref", "nodeId": "classify", "path": "label" },
              "operator": "equals", "value": "urgent" } }
```
Edges: `{ "source": "is-urgent", "target": "page-oncall", "condition": "yes" }` and `{ "source": "is-urgent", "target": "reply", "condition": "no" }`.
