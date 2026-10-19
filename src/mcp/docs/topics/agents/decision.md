---
title: Decision agents
summary: Question-set agents judged by a decision provider and rolled up into one verdict — config, how to run one from a node, model ids and pinning, and what the run records.
order: 52
---

A **decision agent** (`kind: "decision"`, fixed at creation) asks a decision provider a set of questions about one value and rolls the answers up into **one named verdict**. It has no prompt, no user turn, no tools, no turn loop and no reasoning toggle. It is versioned exactly like a generation agent (draft, published versions, float-to-latest, frozen into the run manifest). See [[agents]] and [[versioning]].

## Config

```json
{
  "modelId": "<provider>:<model>",
  "questions": [
    { "id": "urgent", "type": "boolean", "prompt": "Is this urgent?", "yesMeans": "Mentions a deadline within 48h", "threshold": 0.7 },
    { "id": "topic", "type": "category", "prompt": "What is it about?", "choices": [{ "key": "billing", "label": "Billing" }, { "key": "other", "label": "Other" }] },
    { "id": "risk", "type": "scale", "prompt": "How risky?", "choices": [{ "key": "low" }, { "key": "medium" }, { "key": "high" }] }
  ],
  "verdicts": ["escalate", "route_billing", "default"],
  "rules": [
    { "id": "r1", "verdict": "escalate", "conditions": [{ "questionId": "urgent", "op": "is", "yes": true }, { "questionId": "risk", "op": "atLeast", "keys": ["medium"] }] },
    { "id": "r2", "verdict": "route_billing", "conditions": [{ "questionId": "topic", "op": "equals", "keys": ["billing"] }] },
    { "id": "fallback", "verdict": "default", "conditions": [] }
  ]
}
```

- **Question types**: `boolean` (provider returns a probability; `threshold` 0–1 is that question's yes cut; optional `yesMeans` / `noMeans` define what counts as yes and as no, for when the prompt leaves the boundary open), `category` (≥2 `choices`, provider returns a distribution), `scale` (2–10 `choices`, ordered **lowest first** — the order is the scale). A category takes at most 255 choices; past either limit the provider refuses the request. A choice's `description`, else `label`, else `key` is what the provider sees.
- **Rules**: ordered; all of a rule's conditions must hold (AND); the **first** matching rule names the verdict; the **last** rule must have no conditions (the fallback) and only the last may. Every rule's `verdict` must be declared in `verdicts`.
- **Condition ops by type**: boolean `gte`/`lt` (with `probability`) or `is` (with `yes`, using the question's own threshold); category `equals`/`in` (with `keys`); scale `atLeast`/`atMost` (with `keys`, compared by declared order).
- `${variables}` in question text bind through the node's `config.inputs`, like a generation agent's.

## Running one in a workflow

Use an ordinary [[nodes/agent]] node: set `config.agentId` to the decision agent and bind `config.source` to the value to judge (a `ref`; without it the node judges its incoming input). The node makes one provider call (chunked sequentially if the provider caps questions per call) and outputs:

```json
{ "answers": { "<questionId>": { ... } }, "reasoning": "one line per answer", "verdict": "escalate", "because": "which rule fired and what it read" }
```

It does **not** route by itself. Put a [[nodes/switch]] after it with `source` bound to the node's `verdict` and one case per verdict. (A generation agent with `output.kind: "boolean"` is different: it routes yes/no edges directly — see [[agents]].)

Each `answers.<questionId>` is shaped by its question's type: a boolean has `value` (yes/no at its threshold), `probability`, `threshold`; a category has `value` (the option key); a scale has `level` (the nearest level key) and `value` (the probability-weighted index, a **number**). All three carry `confidence` and `distribution`. To route on a scale, bind `answers.<id>.level` — its `value` never equals a level key.

## Providers and model ids

- `modelId` is resolved by the host's decision provider (`getDecider`). Ids come from `list_decision_models` — a **different catalog** from `list_models`.
- A host may instead turn on `decisionsViaChatModels`, which runs decisions on its chat models with structured output ("chat-emulated": slower, less calibrated; thresholds mean something different). A real provider always wins when both exist.
- With neither wired, a node pointing at a decision agent fails with a clear error.

## Pinning the model, and what the run records

- **Pinning**: the engine passes `modelId` to the host's decider verbatim. Whether a specific, non-floating build can be chosen depends entirely on what ids the host's decision catalog offers — if it only lists a floating alias (a `-latest` style id), there is nothing to pin to from 007. The **agent version** can always be pinned (node `config.version`), but that freezes the questions and rules, not the provider's model.
- **Recording**: each step's meta records `modelId`, `questionIds`, token usage, `agentId`, `agentName` and `agentVersion`. The recorded `modelId` is the id the provider **reported** in its response when it reports one, otherwise the configured id. So a floating alias is resolved to a concrete build in the run record only if the host's provider adapter returns it. `run_decision_preview` shows the same value as `answeredBy`.

## Tooling

- `create_agent({ kind: "decision", config })`, then `update_agent_draft` (the config is validated against the agent's stored kind). Publish with `publish_agent` (a dry run, then a confirmed publish). A draft may be incomplete, but publishing — from MCP or the editor — is refused while the matrix has any issue (a rule op its question type doesn't support, an unknown choice key, an `is` with no side, a missing fallback), because a rule that cannot hold evaluates false and silently falls through to the fallback.
- `validate_workflow_graph` and the editor's Issues panel check a decision node against its agent's latest published matrix: every `${variable}` its questions use must be bound in `inputs`; refs into the node must name a real field (`answers.<id>` for a question that exists, and a field that question's type has); and a Switch case, or a Branch `equals`/`not_equals`, on `verdict`, a category's `.value` or a scale's `.level` must compare against a value the agent can produce. Each is an error, because none of them fails a run: the run takes a different arm instead. Nodes pinned to a version are not checked.
- `run_decision_preview` judges one value with the draft (or `usePublished`). Read the distributions, not just the verdict.
- Grade with a `decision_answers` eval check. See [[evals]].

**Legacy `considerations`.** Questions saved before `yesMeans`/`noMeans` existed may carry `considerations`, a map of named factors. No provider reads that shape, so it never reached the model. When such a question is read, the factors are folded into the end of its `prompt` as a "Take these into account:" list, which every provider reads. Rewriting them into `yesMeans`/`noMeans` usually works better.
