---
title: Wait node
summary: Holds the walk until a list of other workflow runs has finished, or a time limit passes.
order: 63.5
---

A `wait` node holds the walk until other runs are done — "don't answer until those background jobs have finished". `config.runIds` refs a list of `wf_run` ids; the engine re-reads their status every 5 seconds until every one has finished (`completed`, `failed`, `cancelled`, or `done` — answered and draining) or `timeoutMs` runs out. Downstream nodes wait on it like on any other node.

An empty or unset list continues immediately with no read, so a graph can route every run through a Wait node and let whoever starts the run decide whether there is anything to wait for.

## Config

| key | meaning |
| --- | ------- |
| `runIds` | A `ref` to a list of run ids. Typically a trigger input the host fills in. |
| `timeoutMs` | How long to wait. Default 300000 (5 min), maximum 900000 (15 min). |
| `onTimeout` | `continue` (default): emit the result with `satisfied: false`. `fail`: fail the node. |
| `progress` | Optional user-facing line, emitted each time the count of finished runs changes while some are still pending. `${done}` and `${total}` are filled in, e.g. `"${done} of ${total} documents ready"`. |

## Output

```json
{ "satisfied": true, "waitedMs": 12000, "total": 3, "done": 3, "pending": [] }
```

`pending` lists the runs still unfinished when the wait ended — empty unless it timed out. Route on `satisfied` with a Branch when the timed-out path needs different handling.

## Behavior and gotchas

- **What "finished" means.** Any terminal status counts, including `failed` and `cancelled`: the wait is for the work to stop, not for it to succeed. Check the runs' own results downstream if success matters.
- **A run id with no row** is not waited on — it can never finish.
- **Timeout.** The node's own timeout is 20 minutes (like an agent), so `timeoutMs` — capped at 15 — is what ends the wait. A run-scoped timeout that is tighter (an eval) ends the wait at that budget instead, with `satisfied: false`.
- **Restarts start the wait over.** An inline restart or a durable retry re-runs the node from a fresh read. Safe — the wait only reads — but the time already waited is not credited.
- **Cancellation.** On the inline engine a cancelled run stops waiting at the next read. On the durable engine the step runs until the runs finish or the time runs out.
- **Keeps the run visibly alive** while it waits only through `progress` lines; without one a long wait writes nothing to the run's feed.
- **Evals:** under simulation nothing is waited on — the node reports `satisfied: true` at once.

```json
{
  "id": "wait-ingest",
  "kind": "wait",
  "label": "Wait for processing",
  "position": { "x": 300, "y": 0 },
  "config": {
    "runIds": { "kind": "ref", "nodeId": "trigger", "path": "awaitRunIds" },
    "timeoutMs": 900000,
    "onTimeout": "continue",
    "progress": "${done} of ${total} jobs finished"
  }
}
```
