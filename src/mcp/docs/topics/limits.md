---
title: Limits and defaults
summary: Every hard number an author can hit — turns, budgets, timeouts, retries, iteration widths, size caps, and how much an MCP result shows.
order: 95
---

Numbers are this build's defaults. A host can raise a few of them (noted), and per-node `execution` settings override the timeout and retry defaults (see [[execution]]).

## Agents

| setting | range | default | notes |
| ------- | ----- | ------- | ----- |
| `maxTurns` | 1–100 | 5 | Rounds of tool calling before a final answer is forced. One turn never offers tools. The editor warns above 20. |
| `toolTokenBudget` | ≥ 1000, or null | null (no cap) | Tokens spent *researching* before the answer is forced. The answer itself is not capped. |
| `answerReservePercent` | 2–50 | 10 | Share of the model's context window kept free for the answer. Tool calling stops before it would be eaten. |
| structured-output re-issue | — | 2 attempts | A malformed structured answer is re-requested once inside the node. |
| provider retries per model call | — | 1 | On top of the first attempt. |
| one model round trip | — | 8 min | Catches a stalled connection. |
| one tool call inside an agent | — | 90 s | |
| in-process budget | — | node timeout − slack, min 30 s | Slack is ¼ of the timeout, capped at 3 min: a 20 min node gets about 17 min of work, a 3 min node about 2¼ min. Hitting it aborts the node and is **not retried**. |

Sub-agent delegation (see [[agents/sub-agents]]):

| setting | range | default |
| ------- | ----- | ------- |
| `maxConcurrent` | 1–20 | 4 |
| `maxSpawns` | 1–50 | 10 |

## Nodes and runs

| limit | value | notes |
| ----- | ----- | ----- |
| Node timeout: `agent`, `workflow`, `iteration` (per item) | 20 min | Override with `execution.timeoutMs`. |
| Node timeout: everything else | 60 s | |
| Durable-engine step retries: AI kinds | 3, exponential from 5 s | Default when `execution.retries` is unset. |
| Durable-engine step retries: other kinds | 2, exponential from 3 s | |
| `execution.retries.limit` | 0–10 | Retries after the first attempt. The inline engine has no step retries. |
| Inline engine restarts survived | 2 | After that the run is failed. |
| Node executions per graph walk | 256 | Exceeding it fails the run. The host can raise it. |
| Nested workflow-call depth | 16 | Reference cycles are rejected outright. |
| Transform expression | 2 s, stack depth 200 | Per evaluation. |
| Text body / prompts | no schema limit | The whole graph or config is stored as one JSON value per version, so the database's row size is the practical bound. |
| Large step values | > 128 KB strings are spilled | On the durable engine, oversized strings become blob refs (if the host wired storage), because a step's result is capped near 1 MiB. Readers rehydrate them transparently. |
| Stored error detail | 16,000 chars | Raw model text inside it: 2,000 chars. |
| Run note | 8,000 chars | |

## Iteration

| setting | inline items | durable items |
| ------- | ------------ | ------------- |
| `maxItems` ceiling (lint) | 500 | 1000 |
| `maxItems` default on a new node | 100 | 500 |
| bound applied to a legacy node with none | 1000 | 1000 |
| `concurrency` | 1–20, default 4 | same |
| item title | 80 chars | same |

A list longer than `maxItems` fails the node with a too-many-items error, which is never retried. See [[nodes/iteration]].

## Evals

| limit | value |
| ----- | ----- |
| Cells one MCP-launched sweep may request (`run_eval`) | 100 |
| Concurrency choices | 1, 2, 4, 8 (default 2) |
| Circuit breaker | stops after 3 consecutive cell errors |
| Eval node timeout | 7 min per node (tightens only) |
| How long a cell is waited on | 15 min |
| Judge attempts | 2 |
| Fixture size when drafting a sample from a run (`draft_sample_from_run`) | 20,000 chars per fixture |
| Result rows returned in detail by `get_eval_run` | 60 (roll-ups always cover everything) |

## What MCP results show

Results are clipped so a trace fits in context. A clipped value says so. Open the narrower tool for the full value.

| tool | budget |
| ---- | ------ |
| any single value, default | 4,000 chars |
| `get_run` | last 60 steps, last 80 log entries, 1,000 chars per field |
| `get_run_step` | 60,000 chars per field |
| `validate_workflow_graph` | 40 issues listed |
| `list_agent_calls`, `list_tool_invocations` | default 10, max 50 |
| `list_models` | default 40, max 200 |
| `get_dashboard` | window up to 90 days, 8 series, 10 recent failures |
| run log feed (per read) | 500 entries |
| feedback list | 300 rows |
