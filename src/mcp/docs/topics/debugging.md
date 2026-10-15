---
title: Reading runs and debugging
summary: How to find a run, read its trace without blowing your context, what each status means, where failures hide (child runs, iteration items, drained branches), and how to act on what you find.
order: 92
---

## The reading path

1. **Find it.** `list_runs` — newest first. Filter by `status`, `workflowId`, `triggerKind`, `workflowVersionId` ("did failures stop after v7?"), `since` / `until` (epoch ms), or `search` (matches workflow name, trigger kind, subject, correlation id and the run's note). Page with `limit` / `offset`. A pasted run URL or a feedback row's `runId` skips this step.
2. **Overview.** `get_run({ runId })` — the run summary (status, error, cost, tokens, workflow), `versionNumber` / `workflowVersionId` it ran, the log feed, every step, and `children` when it called other workflows.
3. **Drill in.** `get_run_step({ runId, cursor })` — one step with `input`, `output` and `meta` essentially whole (up to ~60k characters each). `meta` holds an agent step's full system and user prompt, its reasoning, every tool call's arguments and result, and the agent version that actually ran.

`get_run` does not include the graph — read it with `get_workflow`, or `get_workflow_version` for the exact version the run used.

## What `get_run` clips

The overview is deliberately lossy so it fits in context:

- Each step's `input`, `output` and `meta` are cut to ~1000 characters of JSON. A clipped value turns into a **string** ending in `… [truncated N chars …]` — on any real agent step, `meta` arrives this way. Never conclude "the field is missing" from a clipped overview; open the step.
- Only the last 60 steps and the last 80 log entries are returned; a leading note says how many were dropped. The tail is kept because that is where failures are. `get_run_step` can still open any step by `cursor`.
- `logsTruncated` / `stepsPartial` mean the server itself could not return everything.

Per step you get: `cursor` (the id to drill in by), `sequence` (the order the engine ran things — read a concurrent graph against this), `nodeId`, `nodeKind`, `parentNodeId`, `itemIndex`, `status`, `error`, `costUsd`, `branchResult` (the arm a branch or switch took), `startedAt` / `finishedAt` / `durationMs`, and for agent steps `agentTiming` — per turn its model time, reasoning time, tool-phase time, each tool call's duration, and a one-line `slowest`.

Step statuses: `running`, `completed`, `failed`, `skipped` (an iteration item that never ran because `stopOnError` stopped the loop).

## Run statuses

| status | meaning |
| ------ | ------- |
| `queued` | created; the walk has not started |
| `running` | nodes are executing |
| `done` | the Output was reached — the answer is final and readable — but branches that don't feed the Output are **still running** |
| `completed` | nothing left to run |
| `failed` | the run failed before delivering an answer |
| `cancelled` | in the vocabulary, but nothing in the engine currently sets it on a workflow run (eval runs use it — see `cancel_eval_run`) |

A run with no side branches goes straight to `completed` without passing through `done`. Anything waiting for "the answer" should accept `done`. A failure in a branch that drains **after** the answer was delivered does not fail the run — the answer stands and the broken branch is recorded beside it (check the step errors). See [[execution]].

### A run stuck at `queued`

No error and no log lines usually means it died before the walk began. On the durable engine, the run's references (the agents and workflows it uses) are frozen into its manifest before the run is marked `running`, and a failure there is not recorded on the run — so the run stays `queued` with nothing to read. Check that every agent the graph references exists and has a published version, and every called workflow resolves. The inline engine records such failures on the run normally.

## The log feed

`get_run`'s `logs` is the persisted progress feed. Levels: `node-start` / `node-end` (a node was entered / finished), `progress` (the user-facing "what's happening" lines — what an end user's progress view shows; see [[streaming]]), `info`, `thinking` (an agent's reasoning), `tool` (an agent called a tool), `warn`, `error`, and `state` (run-level lifecycle markers: queued, running, done, completed, failed — the only place the real settle time of a `done`-then-drain run is visible). Step errors, not log lines, are the authoritative failure detail.

## Where failures hide

- **Child runs.** A Workflow node's callee is its own run with its own steps. The parent trace shows only the call; the callee's insides are in `children` on `get_run` (each with `status` and `error`) — open one with `get_run(childRunId)`. A parent can read green while a child failed. Durable iteration items also run as child runs.
- **Iteration items.** Each item's inner steps are recorded with `parentNodeId` = the iteration node's id and `itemIndex` = the item's position (top-level steps carry no parent and item index `-1`). Filter by those to read one item.
- **Sub-agents.** A delegating agent's spawned sub-agents are recorded as child steps under the agent's node (`parentNodeId` = that node, `itemIndex` = spawn order), node id `sub:<nodeId>:<n>`, with the sub-agent's own tool calls in their `meta`. See [[agents/sub-agents]].
- **`continueOnError` nodes** fail quietly by design: the step is `failed`, the run continues, and refs to it resolve to `null`.
- **Thin or cut-off answers** are often budget stops, not prompt problems: `list_agent_calls({ agentId })` reports `stoppedOnTokenBudget` / `stoppedOnContextLimit` per real execution.

## Cross-run views

- `list_tool_invocations` — recent real calls of one tool across all runs, with arguments, results and failures. The way to spot a systematically wrong argument; compare against `get_tool_catalog({ toolIds })`.
- `list_agent_calls` — one agent's recent real executions: turns, tokens, cost, tools called, early stops. Eval runs are excluded; an iteration fan-out folds into one row.
- `list_trigger_events` — what each trigger kind hands a workflow (`fields`) and the shape it must return (`outputContract`).
- `get_dashboard` — aggregate health; `list_changes` — who changed what, and when (to correlate a regression with a publish).

## Feedback triage

1. `list_feedback({ rating: "down", ackState: "unacknowledged" })` — end-user ratings with the `runId` that produced the rated answer.
2. `get_feedback_context({ subjectId })` — the rating, the note and the producing run's trace in one call (`subjectId` is the rated message's id, not the run id).
3. Fix, then turn the failure into a test: `draft_sample_from_run({ runId })` → review → `upsert_eval_sample` ([[evals]]).
4. `triage_feedback({ subjectId, acknowledged: true, internalNote })` — marks it dealt with and records what was done (staff-only; the rater never sees it). Otherwise the same row comes back next session.

## Acting on a run

- **Leave the finding on the run.** `update_description({ kind: "run", id: runId, description })` writes the run's shared note (Markdown, last write wins, searchable from `list_runs`).
- **Retry.** `retry_run({ runId, mode })` executes **real side effects** — it is a real run, not a dry run. `restart` (default) is a fresh run from the start on the **latest published** version — what you want after publishing a fix. `resume` keeps the original version and picks up from the failed step — for transient failures (rate limits, timeouts) where the completed work is worth keeping. Nodes that already succeeded run again under `restart`, so only idempotent nodes are safe to repeat. It refuses a run that is still `queued` / `running`, and needs the host to have wired retries.
- The usual diagnose loop: `list_runs({ status: "failed" })` → `get_run` → `get_run_step` → `patch_workflow_draft` → `publish_workflow` → `retry_run` ([[authoring]]).

Related: [[execution]], [[streaming]], [[evals]], [[authoring]], [[limits]].
