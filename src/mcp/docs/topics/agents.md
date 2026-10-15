---
title: Agents
summary: What an agent is, every config field, how data reaches it, its output shapes, versioning, and how to edit one over MCP.
order: 50
---

An **agent** is a reusable, versioned LLM configuration (a model, prompts, tools, an output contract). Workflows never embed one: an `agent` node is a pointer at an agent by id (see [[nodes/agent]]). There are two kinds, fixed at creation and never convertible:

- **generation** — a system prompt, one user turn (or a bound chat thread), an optional tool loop, and an answer. Everything on this page.
- **decision** — a question set judged by a decision provider and rolled up into one verdict. No prompt, no tools. See [[agents/decision]].

## Versions, drafts and what a run actually uses

- An agent is an entity + one **draft** + immutable published **versions** (v1, v2, …).
- An agent node's `version` is `null` by default, which **floats to the latest published version**. A number pins that exact version.
- At run start the engine resolves every agent reachable from the graph (including sub-agent targets and agents inside called workflows, transitively) into the **run manifest** and freezes it. Publishing a new version mid-run changes nothing for that run; the next run picks it up.
- The draft is never run by a workflow. It is what `run_agent_preview` and `run_eval` with `draftAgentId` measure.
- **Publishing.** `create_agent` creates v1 (so a brand-new agent is immediately runnable once a node points at it). After that, `update_agent_draft` edits the draft and `publish_agent` publishes it — a dry run first (it names every workflow that will pick the version up), then a confirmed publish. See [[authoring]]. `discard_agent_draft` throws the draft away; `update_agent_draft({ fromVersion })` restores an old version into the draft for a rollback. `list_agent_versions` shows history. See [[versioning]].

## How data reaches an agent

There is **no implicit channel**. An incoming edge is sequencing only; it never becomes the agent's message.

- `${name}` tokens in `prompt` and `userPrompt` are the agent's **input contract** (the union of both). Each workflow node maps them in its `config.inputs` to a literal or a `ref` into an upstream node's output. Non-string values are JSON-stringified; null becomes empty. An unbound `${var}` reaches the model as the literal token (the editor flags it).
- Run-level prompt variables supplied by the host are also available; a node-bound value overrides them.
- `inputKind: "task"` (default) — the model gets exactly one user turn: the rendered `userPrompt`. It must be non-empty (save-time error otherwise).
- `inputKind: "conversation"` — the node **must** bind `config.conversation` to a message list (usually the trigger's `messages`); an unbound or non-array conversation throws at run time. A non-empty `userPrompt` is appended after the thread as the current turn.
- Spilled large values (blob refs) are rehydrated before interpolation.

## Config fields

| field | default | meaning |
| ----- | ------- | ------- |
| `modelId` | required | Composite `provider:model` id from `list_models`. |
| `prompt` | required | System prompt. Put **instructions only** here: it is the provider's cache prefix, so per-call data in it defeats prompt caching. |
| `userPrompt` | `""` | The user turn. Required for `task`; optional for `conversation`. Per-call data goes here. |
| `toolIds` | `[]` | Registry tool ids (from `get_tool_catalog`). Only `ai-tool` entries; a function-only tool cannot be given to an agent. See [[tools]]. |
| `maxTurns` | 5 (1–100) | Rounds of tool calling before the model must answer. One turn never offers tools. |
| `toolTokenBudget` | `null` | Tokens (summed across turns) the agent may spend researching; reaching it denies tools on the next turn, forcing the answer. Bounds research, not the final answer. `null` = no ceiling. |
| `answerReservePercent` | 10 (2–50) | Share of the model's context window kept free for the answer. The loop stops calling tools when one more turn (measured from real per-turn growth) would eat into it. |
| `requireToolFirstTurn` | false | Turn 1 must call a tool. Inert with no tools or `maxTurns: 1`. |
| `reasoning` | false | Whether the model thinks before answering (costly; worth it for judgement and multi-step analysis, not extraction). Distinct from the node's display-only `informUser.reasoning`. Ignored by models that cannot reason. |
| `webSearch` | `"off"` | Provider-side web search: `off`, `auto` (provider decides), `on` (every reply). The query leaves unscreened — use a search tool instead when that matters. |
| `webCitations` | false | Ask the provider to footnote claims with pages read. Meaningless when `webSearch` is off. |
| `output` | `{ kind: "text" }` | See below. |
| `inputKind` | `"task"` | See above. |
| `subAgents` | empty | Delegation whitelist and guardrails. See [[agents/sub-agents]]. |
| `referenceKinds` | `[]` | Host-defined inline reference kinds this agent writes. Non-empty appends the reference grammar to the prompt and **checks every reference against what the run actually saw** (prompt, messages, every tool result including sub-agents'); an unsourced reference is stripped to its label and a warning logged. Text output only. |

## Output kinds

- `{ kind: "text" }` → node output `{ text }` (plus `references` when `referenceKinds` is set). The only kind that can stream to the end user — see [[streaming]].
- `{ kind: "boolean" }` → `{ answer, confidence, reason, feedback }`. The node **also routes** its outgoing `yes`/`no` edges like a Branch, while its whole output still flows to refs downstream.
- `{ kind: "object", schema }` → an object matching the JSON Schema. Strict-mode providers ignore unsupported constructs; prefer nullable over optional fields.

The node's output is only the answer. Tool calls, reasoning, the rendered prompt and token usage are recorded in the step's trace (`get_run_step`), **not** in the output — a downstream `ref` cannot read them.

## Model requirements

The chosen model must support what the config needs: tool calling when `toolIds` is non-empty, structured output for `boolean`/`object`, reasoning when `reasoning` is on, web search when `webSearch` is not off. `create_agent` and `update_agent_draft` check these, plus that `modelId` and every tool id exist, before writing.

## Editing over MCP

- `get_agent` first, then `update_agent_draft` with the **whole** config — it replaces the draft outright. Fields easy to lose by omission: `subAgents`, `toolTokenBudget`, `answerReservePercent`, `requireToolFirstTurn`, `webCitations`, `referenceKinds`. The reply's `removed` names anything that disappeared.
- `run_agent_preview` runs the draft once with **simulated** tools (the model invents tool results): checks prompt, format and tool choice, not correctness.
- `run_eval({ draftAgentId })` grades the draft against its eval sets. See [[evals]].
- `list_agent_calls` shows real executions (turns, tokens, cost, tool usage, early stops) — read it before tuning `maxTurns` or budgets.
- `update_agent` changes name/icon/colour only; `update_description` the description.
