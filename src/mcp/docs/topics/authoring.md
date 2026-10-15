---
title: Authoring through the MCP
summary: The safe loop for changing workflows and agents from an MCP session — patch ops, validation, publishing, rollback, what you cannot do, and the mistakes that lint catches.
order: 90
---

## Connections: read-only vs write

Which tools exist is decided by the scope the session was authorized with, not by anything you send. A read-only connection has **no** write tools registered at all — if a tool from the dictionary is missing, this session cannot write. Every write lands in the change feed (`list_changes`) attributed to the person who authorized the session, with `source: "mcp"` marking it as made through an AI client rather than a click. Say what you changed — your edit is attributed to them.

## What you can and cannot change

| thing | draft | publish | from here? |
| ----- | ----- | ------- | ---------- |
| workflow graph | `patch_workflow_draft`, `update_workflow_draft` | `publish_workflow` | **yes**, gated |
| workflow name / archive | — | immediate | `update_workflow` |
| agent config | `update_agent_draft` | — | `publish_agent` — dry run, then confirm (below) |
| new agent | `create_agent` (seeds a published v1 nobody references) | — | yes |
| agent name / icon / colour | — | immediate | `update_agent` |
| description of workflow, agent, Goal, Sample; a run's note | — | immediate, unversioned | `update_description` |

Why publishing an agent takes two calls: a published agent version floats into **every** workflow that references it without a pin, so one publish can change several live workflows at once (a workflow publish changes only what its own trigger runs next). `publish_agent` without `confirm` is a dry run: it publishes nothing, lists what changed, every published workflow that will pick the new version up (`affected.floating`) and the ones pinned to an older version that won't (`affected.pinned`), and returns a `confirm` token. Show the user that list. Calling again with `confirm` and a `changeNote` publishes; the token is bound to the exact draft and live version the dry run saw, so any edit or publish in between is refused and you dry-run again. `baseVersionNumber` is the live version number, as for `publish_workflow`. The version records the authorized user as its publisher; there is no structured approver field, so name a reviewer in `changeNote` if one signed off. There is no tool to archive or delete an agent.

There is **no tool that runs an unpublished workflow draft.** Agents can be previewed and evaluated as drafts; workflows are exercised after publishing (an eval Goal on the workflow, or `retry_run`).

## The workflow loop

1. **Read.** `get_workflow` — the published graph (`currentVersion`) and any draft (`draft`), which can differ. Note the published `versionNumber`; you need it to publish. If a draft already exists, someone has unpublished edits in progress — publishing ships them too.
2. **Understand** what the engine will do with the shape you plan: [[execution]], [[graph]], [[nodes]]. For a Tool node, read the tool's real argument schema with `get_tool_catalog({ toolIds: [...] })` — never guess argument names.
3. **Edit the draft** with `patch_workflow_draft` (preferred) or `update_workflow_draft`.
4. **Validate.** Every draft write already returns the lint; `validate_workflow_graph({ workflowId })` re-runs it on demand. Errors block publishing; warnings are advisory but usually real.
5. **Publish.** `publish_workflow({ workflowId, baseVersionNumber, changeNote })`.
6. **Exercise and watch.** Run an eval Goal against the workflow (`run_eval`), or `retry_run` a representative run in `restart` mode, then read it with `get_run` (see [[debugging]], [[evals]]).

To back out: `discard_workflow_draft` before publishing; after publishing, `update_workflow_draft({ fromVersion: N })` copies a known-good version into the draft, then publish that.

### `patch_workflow_draft` ops

`patch_workflow_draft({ workflowId, ops: [ … ] })`. Starts from the draft, or from the published graph if there is no draft. Ops apply **in order and all-or-nothing** — one bad op writes nothing. The result must still be a well-formed graph, or nothing is written. The reply lints the result, lists every node that differs from the published version, and flags `inheritedUnpublishedEdits` when the draft already differed before your patch.

| op | fields | effect |
| -- | ------ | ------ |
| `"add_node"` | `kind`, `toolId` (required for `tool`), `label?`, `subgraphOf?` | adds a node with its kind's default config and **no edges**; returns its new id. `trigger` and `output` can't be added. `subgraphOf` = an iteration node's id, to add inside its per-item subgraph |
| `"set_tool_arg"` | `nodeId`, `arg`, `binding` | sets one Tool-node argument: `{ "kind": "literal", "value": … }` (in the type the tool declares — a real boolean, not `"false"`) or `{ "kind": "ref", "nodeId": …, "path": "" }` |
| `"remove_tool_arg"` | `nodeId`, `arg` | removes one argument binding |
| `"set_node_label"` | `nodeId`, `label` | renames the node (display only) |
| `"merge_node_config"` | `nodeId`, `config` | **shallow** merge into `config`: each top-level key you send replaces that key whole; keys you don't send are kept |
| `"set_inform_user"` | `nodeId`, `informUser` | what the end user sees while the step runs (see [[streaming]]); `dynamic` is agent nodes only |
| `"set_node_execution"` | `nodeId`, `execution` | `{ continueOnError?, timeoutMs?, background?, retries?: { limit, delayMs?, backoff? } }`; `{}` clears it (see [[execution]]) |
| `"add_edge"` | `source`, `target`, `condition?` | `condition` is a branch's `"yes"`/`"no"` or a switch case key; both ends must be in the same graph |
| `"remove_edge"` | `edgeId`, or `source` + `target` | removes matching edges |
| `"remove_node"` | `nodeId` | removes the node and every edge touching it |

Notes:

- `informUser` and `execution` are siblings of `config`, so `"merge_node_config"` can't reach them — use their dedicated ops.
- Ops reach into iteration subgraphs by inner node id. An iteration subgraph is a closed scope: no edge crosses it. Feed an iteration from one node through its `config.source` ref.
- `"add_edge"` cannot set `fastTrack`. To mark an edge fast-track, use `update_workflow_draft` with the full graph.
- Positions are editor-only; new nodes are placed below the existing ones.
- Binding the Output is a `"merge_node_config"` on the Output node: `{ "source": { "kind": "ref", "nodeId": "<answer node>", "path": "" } }`.

### `update_workflow_draft`

Replaces the whole draft graph (`{ version: 1, nodes, edges }`) — anything you omit is gone. Use it only for a structural rewrite the ops can't express, or with `fromVersion: N` (no graph) to roll the draft back to an exact copy of a published version, read server-side.

### `publish_workflow` gates

- `baseVersionNumber` must equal the version live **right now** (`0` for a never-published workflow). If someone published since you read, it is refused — re-read, re-check your draft on top of theirs, retry.
- The draft must lint with zero errors, and must differ from the live version.
- `changeNote` is required (one line, like a commit subject). An AI summary of the change is generated by default (`summarize: false` skips it).
- Runs already in flight finish on the version they started with; the next run uses the new one.

### `create_workflow`

Creates a workflow whose v1 is the minimal graph — the chosen trigger (`manual`, `periodic` with `cron`, or an event `kind` from `list_trigger_events`) wired straight to an Output. That v1 is **published but deliberately broken**: the Output has no value bound, which is an error, so build the graph with patches, bind the Output last, then publish v2. A `periodic` workflow starts firing on its schedule as soon as a version is published. `update_workflow({ archived: true })` retires a workflow (it stops firing; history survives).

## The agent loop

1. `get_agent` — check `agent.kind` (`generation` or `decision`; immutable) and read both `currentVersion.config` and `draft.config`.
2. `update_agent_draft({ agentId, config })` — **the whole config, not a patch.** Any field you omit is lost. The ones most often lost because nothing prompts for them: `subAgents`, `toolTokenBudget`, `answerReservePercent`, `requireToolFirstTurn`, `webCitations`, `referenceKinds`. Check `removed` in the reply. The config is validated against the agent's kind, the model id against the enabled catalog, every tool id against the tool catalog, and the model's capabilities against what the config needs. `fromVersion: N` restores a published version into the draft instead.
3. Try it: `run_agent_preview` (generation) runs the **draft** once. **All tools are simulated** — the model invents plausible results — so it checks prompt, format and tool choice, not correctness. Pass `promptVariables` for `${…}` tokens, and `messages` for a conversation agent. `run_decision_preview({ agentId, state })` runs a decision agent's draft for real (one provider call); read the per-question distributions, not just the verdict.
4. Measure it: `run_eval({ setIds, draftAgentId })` grades the draft against the agent's Goals ([[evals]]).
5. `publish_agent({ agentId, baseVersionNumber })` — the dry run. Put `affected` in front of the user.
6. `publish_agent({ agentId, baseVersionNumber, confirm, changeNote })` — publishes. Or `discard_agent_draft` to throw the draft away. Roll back with `update_agent_draft({ fromVersion })` and publish again.

`create_agent` makes a new agent with a published v1 and a matching draft. Generation configs need `modelId` (from `list_models`, composite `provider:model`), `prompt` and `userPrompt`; decision configs need `modelId` (from `list_decision_models`), `questions`, `verdicts`, `rules`. Nothing runs a new agent until a workflow's agent node points at it. See [[agents]], [[agents/decision]].

There is one draft row per workflow and per agent. Every draft write — and every discard — replaces whatever a person had unsaved in the editor.

## Mistakes the lint catches (and some it can't)

- **Output with no value bound** — error. The incoming edge decides *when* the Output fires; `config.source` decides *what* it returns.
- **A ref to a node that isn't upstream** — warning ("nothing connects that node to this one"). A ref without a sequencing edge path races: the referenced node may not have run yet. Data never flows along edges; edges only order work ([[graph]]).
- **Tool-node args out of step with the tool's schema** — error from the server-side check: an arg the tool no longer declares, a required arg unbound, a literal of the wrong type.
- **Several parallel paths into one Output**, or a node joining both arms of a branch — errors; that join can never complete ([[execution]]).
- **Agent node with no agent selected**, iteration with no list, text with no body, transform with no or invalid expression, switch cases without edges.
- **Task agent with an empty `userPrompt`** — refused when the agent config is saved: the user prompt is the only way data reaches a task agent. A **conversation** agent whose node doesn't bind `conversation` fails at run time.
- **Inform-user set on a step inside an iteration** — warning; nothing it reports reaches the user.

Not caught: a ref `path` that names a field the upstream node never produces (it resolves to nothing at run time). Read the upstream node's output shape from a real run with `get_run_step` before binding into it.

Related: [[overview]], [[versioning]], [[debugging]], [[evals]].
