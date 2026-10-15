---
title: Agent node
summary: Runs a reusable agent — pinned or floating version, `${var}` inputs, a bound conversation, decision agents — and what it outputs and streams.
order: 62
---

An `agent` node is a **pointer** at a reusable agent (a `wf_agent`); the prompt, model, tools and output kind live on the agent, not the node. The node says which agent, which version, and where each of the agent's inputs comes from. The same agent can be placed in many workflows with different bindings. Agent configuration itself is in [[agents]]; decision agents in [[agents/decision]].

## Config

| key | meaning |
| --- | ------- |
| `agentId` | The agent this node runs (`list_agents` / `get_agent`). Empty while unpicked in a draft; a run fails if it's empty. |
| `version` | `null` (default) **floats** to the agent's latest published version, resolved when each run starts. A number **pins** the node to that exact published version. Either way the resolved config is frozen into the run manifest at run start, so publishing mid-run changes nothing for that run. See [[versioning]]. |
| `inputs` | Map from each `${variable}` the agent's prompts use (system prompt **and** user message — one shared bag) to a binding: a `literal` or a `ref` into any upstream node's output. These bindings are the **only** way graph data reaches the model. Non-string values are JSON-stringified; `null`/missing become `""`. A ref with `path: ""` passes a node's whole output. A bound input overrides a run-level variable of the same name. |
| `conversation` | For a `conversation`-kind agent only: a binding that resolves to the message history (an array of `{ id, role, parts }` messages), usually a ref to the trigger's `messages`. **Required** for such agents — an unbound or non-array conversation throws. The agent's rendered user message, if any, is appended as the current turn. Ignored by `task` agents. |
| `source` | For a **decision** agent only: a ref to the value its questions judge. Unset judges the node's incoming input. Ignored by generation agents. |

`get_agent` shows an agent's `inputKind` and the `${variables}` it declares — bind every one. An unbound `${var}` reaches the model as the literal text `${var}` — the workflow editor flags it as a blocking issue, but nothing at run time stops it.

## Output

Depends on the agent's output kind ([[agents]]):

| agent output kind | node output |
| ----------------- | ----------- |
| `text` | `{ "text": "<final answer>" }` — ref `path: "text"` for the bare string |
| `object` | the object matching the agent's JSON Schema |
| `boolean` | `{ "answer": true/false, "confidence": 0–1, "reason": "…", "feedback": "…"|null }` — and the node **routes** like a Branch: outgoing edges with `condition: "yes"` / `"no"` are taken by `answer` |
| decision agent | `{ "answers": …, "reasoning": …, "verdict": …, "because": … }` — route on `verdict` with a downstream `switch` |

## Behavior and gotchas

- **No implicit input.** An incoming edge contributes nothing to the prompt; it only orders execution and makes the upstream output available to refs. If the agent needs data, bind it in `inputs`/`conversation`.
- **Timeout:** 20 minutes per attempt by default (`execution.timeoutMs` overrides). See [[execution]].
- **Version not in the manifest:** "references agent … which is not in the run manifest" means the agent (or the pinned version) has no published version. Publish the agent first.
- **Streaming the answer:** on the `inline` engine, if this node is the one the Output's `source` names and its output kind is `text`, its answer is streamed token by token to a waiting reader as it is generated — before any downstream node runs. Structured (`object`/`boolean`) agents never stream. The durable engine never streams answers. See [[streaming]].
- **`informUser`:** supports `off`, `static`, and `dynamic` (`reasoning` streams the model's thinking, `tools` announces each tool call). Dynamic is display-only; it never changes what the agent may call. Sub-agents spawned by this node inherit its display settings.
- **Sub-agents:** if the agent whitelists sub-agents, the node gains synthesized `spawn_*` / `await_subagents` tools at run time. See [[agents/sub-agents]].
- Under evals, tool calls the agent makes may be simulated or live per sample. See [[evals]].

```json
{
  "id": "reply-agent",
  "kind": "agent",
  "label": "Draft reply",
  "position": { "x": 300, "y": 0 },
  "informUser": { "mode": "dynamic", "reasoning": false, "tools": true },
  "config": {
    "agentId": "6f1c…",
    "version": null,
    "inputs": {
      "topic": { "kind": "ref", "nodeId": "classify", "path": "topic" },
      "tone": { "kind": "literal", "value": "brief" }
    },
    "conversation": { "kind": "ref", "nodeId": "trigger", "path": "messages" }
  }
}
```
