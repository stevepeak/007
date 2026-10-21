---
title: Evals
summary: Goals, Samples and checks; how tools behave under an eval (mocked, live, neutralized); staging context and documents; sweeps, judges, drafts and resumable runs.
order: 85
---

An eval runs a **target** (one agent, or one whole workflow) against a set of authored inputs and grades each run with deterministic checks and/or judges. The vocabulary: a **Goal** (wire name `set`) is a named batch of **Samples** (wire name `row`) aimed at one target; an **eval run** is one sweep of one or more Goals; each Sample × matrix cell produces one graded **result**.

## The loop, as MCP calls

1. `create_eval_set` — pick the target (`targetKind` `"agent"` | `"workflow"`, `targetId`). The target is resolved first, and the reply's `target` contract tells you exactly what a Sample must look like: `sampleInputKind`, a ready-to-fill `inputTemplate`, the agent's `toolIds` (the only legal keys for per-tool settings) and its `outputSchema` (the legal `path`s for checks). `get_eval_set` returns the same contract.
2. `upsert_eval_sample` — one call per Sample. Omit `id` to create; pass it to edit. Editing is a patch at the top level, but `input`, `tools` and `checks` are each **replaced whole** when sent — resend the parts you want to keep. The reply carries lint `warnings` (empty variables, no checks, tool settings keyed on tools the target can't call, check paths that name no output field) and the Sample's `layer`.
3. `run_eval` — returns an `evalRunId` immediately; the sweep runs on the server.
4. `get_eval_run` — poll every 20–30 s until `status` is `completed`. Read `errored` separately from `failed`.
5. Optionally `draft_sample_from_run` to mine Samples from real runs, `delete_eval_sample` to archive (and `restore: true` to bring back), `update_eval_set` to repoint, pin or archive a Goal.

`list_eval_sets` and `list_eval_runs` list what exists. Everything except reads requires a write-authorized connection.

## Targets

- **Agent target.** The agent runs inside a hidden, auto-generated `trigger(manual) → agent → output` wrapper workflow on the **inline** engine, so it produces the same trace shape an agent node in a real workflow does. The Goal floats to the agent's latest published version unless `targetVersion` pins one. An agent with no published version has nothing to run.
- **Decision agent target.** No graph and no run: each cell is one decision-provider call, settled immediately. Grade with `decision_answers`. A single `run_eval` cannot mix decision-agent Goals with anything else — the reports are incomparable and the call is refused.
- **Workflow target.** The pinned (or latest) published version runs under its own trigger kind and its own `engine`. Workflow **drafts** cannot be evaluated — only published versions. Its tools are spread across many nodes, so the contract carries no `toolIds` and no `outputSchema`, and those lints don't run.

A Goal floats by default, which keeps it grading what ships. Pin `targetVersion` only to reproduce a historical result, and unpin with `floatTargetVersion: true` afterwards. A pin that resolves to nothing fails the run instead of silently floating.

## Sample input — one shape per target

| target | `input` |
| ------ | ------- |
| task agent | `{ "kind": "task", "variables": { … } }` — values for the agent's `${variables}` |
| conversation agent | `{ "kind": "conversation", "turns": [ … ], "variables": { … } }` |
| workflow | `{ "kind": "trigger", "payload": { … }, "variables": { … } }` |
| decision agent | `{ "kind": "decision", "state": <any JSON>, "variables": { … } }` |

- A **conversation** Sample's `turns` become the agent's message history; the run begins mid-conversation and only the model's next reply is produced and graded. A turn is `{ "role": "user" | "assistant", "text"?, "toolCalls"? }`.
- A **workflow** Sample's `payload` is the trigger payload, verbatim — the same object the host's event would have routed. `list_trigger_events` lists each event kind's `fields`; the Goal contract pre-fills them. `variables` are run-level prompt variables for agents nested in the workflow.
- An unfilled `${var}` renders literally into the prompt.
- Every input except `decision` also takes an optional `"context": { … }`: the run scope that **live** tools read (which client, firm or chat thread), keyed by the host's tool context fields. It is the same bag the agent playground collects, and the agent never sees it. A tool lists the keys it needs as `requiresContext` in `get_tool_catalog`; without them, a live scoped tool matches nothing.

## Tools under an eval

Every eval run is **simulated**. How each tool behaves depends on its side-effect tag (`sideEffect` in `get_tool_catalog`) and the Sample's per-tool setting:

| tool's tag | Sample says `mocked` (the default) | Sample says `live` |
| ---------- | ---------------------------------- | ------------------ |
| `write` | no-op, returns `{ simulated: true }` | still a no-op — **an eval never writes** |
| `read` | returns the pinned `output`, or `{}` if nothing is pinned | executes for real |
| untagged | **executes for real** | executes for real |

Untagged tools run for real in every eval; the tag is how a tool opts in to being mocked. Connector tools are tagged from the remote server's `readOnlyHint` annotation (absent or false → `write`).

The setting is per tool: `tools: { "fallback": "mocked", "byTool": { "<toolId>": { "mode": "mocked" | "live", "output": <canned result> } } }`. A tool with no entry takes `fallback`. There is no way to take a tool away — a mocked tool with nothing pinned returns `{}`.

Consequences worth knowing:

- **One canned result per tool id, for every call in the run.** Fixtures are keyed by tool id only, so a tool called three times returns the same pinned output three times.
- **The setting applies run-wide**: to agent tool calls, to Tool nodes, to sub-agents (they inherit the parent's simulate signal and fixtures), and to called child workflows (the child run inherits the parent's run context, simulate signal included).
- A Sample's derived **layer** names what it can claim: `io` (nothing pinned, nothing live), `trajectory` (something pinned), `integration` (anything live — no longer reproducible).

### Staging documents and other retrieved context

Pick by what you are testing:

- **Pin the reading tool's result.** If the tool that reads an attachment is tagged `read`, set `byTool["<that tool>"] = { "mode": "mocked", "output": <what it would have returned, document text included> }`. Deterministic, and the agent still has to decide to call it. Copy a real output from `get_run_step` so the shape is right.
- **Let it run live.** `"mode": "live"` and put real ids/references in the trigger `payload` (or variables) that the tool can resolve, plus whatever `context` it `requiresContext`. Grades the retrieval end to end; the Sample becomes `integration`.
- **Synthesis — stage it in the conversation** (conversation agents only). Add an assistant turn with `toolCalls: [{ "tool": "<toolId>", "args": …, "output": <document text> }]`. The model sees a completed tool call it can answer from, and the judges are shown these staged calls. The agent still has its tools; calling one returns `{}` unless pinned.
- **Workflow target:** there is no per-node input injection. Document text reaches the graph only through the trigger `payload`, a pinned tool output, or a live tool.

If the reading tool is **untagged**, it runs for real no matter what the Sample says — check `get_tool_catalog` before relying on a pin.

## Checks

`checks: { "op": "and" | "or", "checks": [ … ] }`. Deterministic checks read the trace; judges call a model.

| check | fields | passes when |
| ----- | ------ | ----------- |
| `tool_called` | `toolId`, `called` | the tool was (or wasn't) called |
| `tool_args_match` | `toolId`, `path?`, `match`, `value` | some call's args match |
| `node_visited` | `nodeId`, `visited` | the node ran (or didn't) |
| `node_input_match` | `nodeId`, `path?`, `match`, `value` | the node's recorded input matches |
| `output_match` | `path?`, `match`, `value` | the run output matches |
| `decision_answers` | `verdict?`, `expect: [{ questionId, yes? \| key?, minProbability? }]`, `nodeId?` | a decision agent's matrix matches, every miss reported. On a workflow Goal, set `nodeId` to the decision node: the workflow's output is what its Output returns, not the decision |
| `llm_judge` | `rubric`, `path?`, `modelId?` | a chat model writes a reason, then pass/fail, then a 0–10 confidence |
| `decision_judge` | `rubric`, `path?`, `modelId?`, `threshold?` | a decision model's P(yes) ≥ `threshold` (default 0.5) |

- `match` is `equals` (deep equality), `contains` (substring, or array membership), `regex`, or `jsonpath` (currently an alias for `equals` after `path` selection). `path` is a dot/bracket path (`a.b[0].c`) into the output, args or input; omit for the whole value. A path that resolves to nothing grades `undefined`, which reads as a wrong answer.
- **What checks can see:** the run output and the **top-level** steps — Tool nodes and each agent node's own tool calls (including the synthesized `spawn_*` / `await_subagents` calls of a delegating agent). Steps recorded under a parent — iteration items and a sub-agent's own internal tool calls — are not graded, and neither are a called child workflow's internal steps.
- Judges are shown the graded output plus every tool call the checks can see, with outputs, plus any staged synthesis calls — so a rubric can ask about groundedness.
- Row **status**: AND/OR over every check. **score**: the pass rate of the judge checks only (null with no judge). A Sample with **no checks** grades `error`, not pass or fail. A run that failed is not graded — its cell is `error`.
- Prefer a deterministic check wherever one can express the assertion; use a judge only for what cannot be asserted literally. Use `decision_judge` for anything that reduces to yes/no — a probability of 0.52 is visible, a judge's "8/10" is not.

## Mining Samples from real runs

`draft_sample_from_run({ runId, layer?, cursor? })` turns one agent step of a real run into a Sample **draft** — it writes nothing. Pair with `list_feedback` (a thumbs-down row names the run). Layers:

- `trajectory` (default): the run's real tool results become mocked pins, and `tool_called` checks are added for each tool used. A tool called more than once keeps only its **last** result. Large results are truncated — replace them.
- `synthesis`: the tool results are staged as an assistant turn in the conversation and nothing is pinned. The agent keeps its tools; a call returns `{}`, so pin a tool if the answer depends on calling it again. Conversation agents only.

Both seed an `llm_judge` rubric from the run (never from its answer). Rewrite the rubric, then save with `upsert_eval_sample`. A run with several agent steps answers with the list; pass `cursor` to choose.

## Running: sweeps, drafts, judges, cost

`run_eval({ setIds, … })`:

- `models` — sweep the target across these model ids (composite `provider:model`, from `list_models`). Each is checked against the target's needs (tools, structured output, reasoning, web search); one that can't run it is refused up front.
- `prompts: [{ label, body }]` — alternate system prompts; the saved prompt is always included as a baseline column. Requires `models`. Not available for decision agents (their questions are the prompt).
- `attempts` / `attemptsByModel` — best-of-N per model, to see variance. Requires `models`.
- `draftAgentId` — grade the agent's **unsaved draft** instead of its published version (every named Goal must target that agent). The draft config is frozen into the run's plan. If the draft is identical to the published version, the reply says so.
- `judgeModelId` — pin the judge model. Unpinned, the judge is the host default, else the first enabled catalog model — so enabling a model can silently re-grade a suite. Pin it whenever you will compare reports.
- `concurrency` — 1, 2, 4 or 8 in flight (default 2). This is the rate the sweep hits the provider.

Limits: at most **100 cells** (samples × models × prompts × attempts) per call. Each cell is a real, billed model call. Each node of an eval run is capped at a 12-minute timeout, about 9 minutes of agent work (applied run-wide, without changing the target's graph); a cell that takes longer than 15 minutes is given up on and recorded as `error`. After three consecutive provider failures a circuit breaker stops launching cells and records the rest.

The report (`get_eval_run`): per-sample verdicts with each check's reason, cost/tokens/model per cell, `matrix` (per model × prompt: pass rate, mean score, average cost, throughput, and `bestAccuracy` / `cheapest` / `fastest`), and a **drift** section comparing against the last comparable run — including whether the agent was republished since. `results` is bounded at 60 rows, worst first; narrow with `status`, `modelId`, `promptLabel`, page with `offset`, or pass `rowId` for one Sample unclipped. `pending` is cells not yet settled (or called off).

## Resumable runs

The plan (every cell) is frozen on the eval run at launch, so a sweep doesn't depend on the session that started it: `run_eval` launches the first batch and returns; the host's backstop (or an attached console tab) drives the rest. If a run sits at `queued` / `running` without progress, nothing is driving it — `resume_eval_run` settles what finished and launches the next batch (safe to repeat; in-flight cells are polled, not relaunched). `cancel_eval_run` stops launching new cells; cells already started finish and are graded.

Related: [[agents]], [[agents/decision]], [[agents/sub-agents]], [[tools]], [[debugging]], [[authoring]].
