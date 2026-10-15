---
title: Sub-agents (delegation)
summary: How an agent spawns other agents or workflows mid-generation — the targets format, the synthesized tools, what is traced, and how evals treat them.
order: 51
---

A generation agent can delegate work to other agents or workflows **during its own tool loop**. This is configured on the agent (`config.subAgents`), not in the graph: the sub-runs execute inline inside the primary agent node's step, and the workflow graph never shows them.

## Config

```json
"subAgents": {
  "targets": [
    { "kind": "agent", "id": "<agent id>", "version": null, "toolName": "spawn_researcher", "label": "Researcher" },
    { "kind": "workflow", "id": "<workflow id>" }
  ],
  "maxConcurrent": 4,
  "maxSpawns": 10,
  "allowStopSignal": true
}
```

- `targets` — a list of **objects**, not bare ids. `kind` is `agent` or `workflow`; `id` is the agent/workflow id. `version` (agents only) is `null` to float to the latest published version or a number to pin; workflow targets always float. `toolName` (optional, `^\w+$`) overrides the synthesized tool name, else it is `spawn_<slug of the target's name>` (duplicates get `_2`, `_3`). `label` (optional) is used in the tool's description. Empty `targets` = delegation off.
- `maxConcurrent` (1–20, default 4) — how many sub-runs execute at once; extra spawns queue.
- `maxSpawns` (1–50, default 10) — total spawns per execution of the node. Past it, a `spawn_*` call returns an error object (it does not throw), so the model can adapt.
- `allowStopSignal` (default true) — gives text sub-agents a `signal_stop(reason)` tool. See below.

## The tools the primary agent gets

When `targets` is non-empty, the engine adds to the primary's tool set:

- **`spawn_<name>`** per target. Non-blocking: returns `{ spawnId, target }` immediately and the sub-run starts in the background.
  - Agent target input: `{ message, ...vars }`. `message` (string) becomes the sub-agent's **single user turn**. Each other key is an optional string for one `${variable}` found in the sub-agent's **system prompt** (`prompt`); values override run-level variables. Non-string values are JSON-stringified.
  - Caveat: the sub-agent's own `userPrompt` template and `inputKind` are **not used** when it is spawned — `message` replaces the user turn, and variables used only in `userPrompt` are not offered on the spawn tool.
  - Workflow target input: `{ input }`, used as the workflow's trigger payload; the workflow runs inline as a subgraph and returns its Output value.
- **`await_subagents({ spawnIds? })`** — waits for the listed spawns (all, if omitted) and returns `{ completed[], pending[], stopped }`. Each completed entry has `status` (`completed`/`failed`), `output`, `error`, `stopSignalled`, `reason`.
- **`check_subagents()`** — non-blocking status of every spawn.

A name colliding with a registered tool in the agent's `toolIds` fails the node. Delegation is **one level deep**: a sub-agent gets its own registry tools but never delegation tools of its own.

## Stop signal

With `allowStopSignal`, a text sub-agent can call `signal_stop(reason)`; an object/boolean sub-agent signals by returning a truthy `__stop` field. `await_subagents` then returns as soon as that sub-agent completes, listing the rest under `pending` with `stopped: true`. **Pending sub-runs are not cancelled** — they keep running in the background of the primary's step; the engine simply stops waiting on them.

## Execution and budgets

- Each sub-agent uses its **own** config: model, `reasoning`, `toolIds`, `maxTurns`, `toolTokenBudget`, `requireToolFirstTurn`, context window. Its token budget is not a share of the primary's — `maxSpawns` is the guard on total spend.
- It shares the primary node's **wall-clock budget** (it runs inside that step) and its run context (prompt variables, eval simulation settings).
- What the end user sees is inherited from the primary node's `informUser` — a sub-agent has no node of its own. See [[streaming]].
- Sub-agent output is never streamed as the answer; only the primary's final text can be.

## Versioning

Targets are frozen into the run manifest at run start, transitively (a target's own sub-agents, a workflow target's agents), so a run replays against exact versions even if a target is republished mid-run. A target pointing at a version that does not exist fails the spawn with "not in the run manifest".

## What the trace shows

Each spawned **agent** is recorded as a child step of the primary node (node id `sub:<primaryNodeId>:<ordinal>`, with the ordinal as its item index) carrying its full trace: model, prompt, messages, every turn's tool calls with inputs and outputs, usage, `agentId`, `agentVersion`. A failed spawn records a failed child step. A spawned **workflow** records its inner nodes' steps under the primary node. In the primary's own trace, the `spawn_*` and `await_subagents` calls appear as tool calls. Use `get_run_step` on the primary node to drill in; `list_agent_calls` lists synthesized tools by name. See [[debugging]].

## Evals

Sub-agents run under the **same** eval settings as the primary — there is no separate setting per sub-agent:

- A sample's per-tool mode (`mocked`/`live`) and pinned output are keyed by **tool id**, so a pin applies to every agent that calls that tool, primary and sub-agents alike, and every call returns the same pinned output.
- Write tools are neutralized in every mode; tools the host did not tag as read or write run for real. See [[tools]].
- A synthesis sample stages tool results in the conversation and pins nothing. The primary keeps its tools — delegation tools included — and an unpinned mocked call returns `{}`.
- A sample cannot pin a sub-agent's *answer* directly; pin the tools it calls instead. See [[evals]].
