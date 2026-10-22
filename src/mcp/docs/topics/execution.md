---
title: How a run executes
summary: The scheduler's rules — when a node fires, how joins and routing work, fastTrack, done vs completed, failures, retries, timeouts and the two engines.
order: 30
---

Read this before wiring anything with more than one incoming edge. Most "why did X start late / never start / start too early" questions are answered by the six rules in the first section.

## The rules in one screen

1. **Edges gate, refs carry data.** An edge says *when* a node may run. The value a node reads comes from a `ref` binding (`{ kind: "ref", nodeId, path }`) into any node that has already run. Nodes do not forward their input. See [[graph]].
2. **An ordinary node waits for ALL its incoming edges.** It becomes ready only when every incoming edge is *alive*. An edge is alive when its source node has **completed**, and, if the edge has a `condition`, when that source's decision matched it.
3. **A `race` node waits for ANY one incoming edge.** It fires once, on the first live edge. The Output node uses the same any-edge rule.
4. **Everything that is ready starts at once.** There is no concurrency cap between nodes, only a per-run node budget (default 256 node executions). Dispatch is *rolling*: after each node settles, the engine re-checks for newly ready nodes and for a reachable Output.
5. **An edge from a node that never ran stays dead forever.** A node on an untaken decision arm never runs. A node that failed never completes. Any ordinary node waiting on such an edge therefore never runs either. It is skipped, not failed.
6. **The run's answer is released the moment an Output is reachable.** Work that doesn't feed that Output keeps running afterwards (the *drain*).

## When a node becomes ready

| Node | Ready when | Input it is handed |
| ---- | ---------- | ------------------ |
| Ordinary work node (agent, tool, text, transform, branch, switch, workflow, iteration, passthrough, feature-request) | **every** incoming edge is alive | 1 edge: that source's output. 2+ edges: an object keyed by source node id, `{ [sourceId]: output }`. |
| `race` | **any** incoming edge is alive (fires once) | The winning source's output: the first live edge in edge-declaration order at the moment it fires. |
| `aggregate` | **every** incoming edge is alive | An array with one element per incoming edge, in edge-declaration order. |
| Output | **any** incoming edge is alive | n/a. The Output's value comes from its `config.source` ref, not from the edge. |
| Trigger | seeded at start with the validated trigger input | n/a |
| Note | never (it has no edges) | n/a |

The "input it is handed" column matters only for the few nodes that read their raw input when nothing is bound: a Branch or Switch with no `source`, and a Workflow node with empty `inputs`. Everything else reads data through refs.

## Waiting for several nodes ("release only after X, Y and Z")

Any ordinary node with incoming edges from X, Y and Z waits for all three. That is the default rule, and you don't need a special node for it. Choose the joining node by what you want downstream:

- **`aggregate`** gives one list, `[outX, outY, outZ]`, in edge order. Use it when the next step iterates or checks the results together.
- **Any work node** (Text, Transform, Agent, Branch…) with three incoming edges also waits for all three, and reads each value through refs. A Text node that composes the final message from `${x}`, `${y}` and `${z}` is a common gate.
- **Do NOT point three edges straight at the Output.** An Output fires on its *first* live edge. Validation also rejects an Output that merges two or more unconditional parallel paths ("give each parallel path its own Output node"). Put an ordinary join node in front of the Output.

To hold the answer until checks pass, make the checks **ancestors of the Output** by edges: X, Y and Z feed a join, the join feeds a Branch or Switch on the check result, and the passing arm feeds the Output. Bind the Output's `source` to the node whose value the caller should receive. On the inline engine the node the Output binds to is the one whose tokens can stream to the reader. If that is an agent upstream of your checks, its text can reach the reader before the checks finish, so bind the Output to a node *after* the gate. See [[streaming]].

## Decision routing and dead arms

Decision sources set `condition` on their outgoing edges:

| Source | Edge `condition` values |
| ------ | ----------------------- |
| `branch` | `"yes"` / `"no"`. An unconditioned edge out of a Branch is rejected, because it would fire on both results. |
| `switch` | a case `key`, or `"else"` |
| an agent whose output is Yes/No (boolean) | `"yes"` / `"no"` on conditioned edges. Its plain (unconditioned) edges always flow. |

A *decision agent* (one provider call that returns a `verdict`) does **not** route. Put a Switch after it on `verdict`. See [[agents/decision]].

- Only edges whose `condition` matches the decision come alive. Every other arm is dead: its nodes never run, and anything downstream of them that needs all its edges never runs either.
- An arm with no outgoing edge, or an unmatched Switch with no `else`, **fizzles**: the path ends quietly. If no Output is ever reached and a decision did route, the run finishes with no output and no error. If no decision ever routed, the run fails as stalled.
- **Joining both arms of one decision into an ordinary node is rejected** (`both-arms-join`): one arm is always dead, so the join would stall forever. To merge arms, use a **`race`** (it only needs one live edge), or give each arm its own Output. [[nodes/passthrough]] exists to make two arms hand a race the same shape.
- Several Output nodes are legal, typically one per arm. Several mutually exclusive arms converging on one Output are also legal. If more than one Output is reached, the first one reached is the run's answer; if two become reachable on the same settle, node-declaration order breaks the tie. Later Outputs are recorded but don't change the answer.

## Dispatch order, `background`, and `fastTrack`

When several nodes are ready together, they all start in the same tick. Order matters only for who goes first, and in one case below (`fastTrack`) for who is held back.

- **Answer-critical first.** Every Output and all its structural ancestors (over all edges, before any routing) are *answer-critical*. They are dispatched ahead of other ready nodes. This is a preference, never a gate.
- **`execution.background: true`** removes a node from the answer-critical set, so it yields dispatch order. It still runs, and still runs concurrently. Its ancestors are not demoted. Use it for a side-effect node that happens to sit upstream of the Output.
- **`fastTrack: true` on an edge GATES.** The *track* is each marked edge's source and target plus **every ancestor of the target**. While any track node is running or ready, ready nodes **off** the track are held: not started, just left waiting. When nothing on the track is running or ready, the held nodes start.

**Why something started "only when the answer was emitted":** if the fast track leads to the node the Output binds to, then every off-track node is held until that node finishes. The Output then becomes reachable on that same settle and the answer is delivered immediately. Only after that do the held nodes start, in the drain. The result: any node that is not an ancestor of the fast-tracked target, such as a parallel check, cannot start until the answer is already out, so it cannot gate the answer.

- A node that must run *before* the answer has to be an ancestor of the Output (connect it by edges). Ancestors of the fast-tracked target are on the track automatically.
- A track node on an untaken decision arm never becomes ready, so it holds nothing back.
- `fastTrack` affects only parallel scheduling. It does not change what any node reads, and it has no effect inside an inline iteration item, whose nodes run one at a time.

## `done` vs `completed` (the drain)

- **`done`**: an Output was reached. The answer is final and the caller is released. Before release the value is checked against the trigger's output contract (see [[triggers]]); a violation fails the run.
- **`completed`**: every remaining arm has run itself out. Arms that don't feed the Output (a notification tool, a title update, a race loser's downstream) run in this drain phase, behind the answer.
- A node that fails **before** the answer stops new dispatch. Nodes already running are allowed to land, since in-flight work can't be cancelled, and then the run **fails**.
- A node that fails **after** the answer cannot retract it. The run keeps its answer, records a drain error, and stops starting new work while running siblings finish. The failed step is in the trace.
- Anything waiting on "the answer" must accept `done`, not only `completed`.

## Per-node `execution` policy

Every node accepts an optional `execution` object. Omitted fields fall back to the per-kind defaults below.

| Field | Meaning |
| ----- | ------- |
| `continueOnError` | If the node still fails after its retries, record the failure and continue with output `null`. Downstream refs resolve to `null` and its edges count as completed. **Ignored on branch and switch**, because a routing decision has no safe default. |
| `timeoutMs` | Wall-clock budget for ONE attempt. On AI kinds the agent's in-process budget is smaller (see [[limits]]); `validate_workflow_graph` warns at 210 s or less. |
| `background` | Demote out of the answer-critical set (see above). |
| `retries` | `{ limit, delayMs?, backoff? }`. `limit` is 0–10 retries *after* the first attempt. `backoff` is `constant`, `linear` or `exponential`. |

Defaults by kind:

| Kind | Timeout | Retries (durable engine only) |
| ---- | ------- | ------------------------------ |
| `agent`, `workflow`, `iteration` | 20 min (for an iteration, per item) | 3, 5 s delay, exponential |
| everything else | 60 s | 2, 3 s delay, exponential |

What is **not** retried, even on the durable engine:

- a provider error the AI SDK marks non-retryable (bad request, payment required, unknown model)
- an agent that burned its whole time budget or finished its turn loop without an answer
- an iteration list longer than `maxItems`
- the wait on a child run or a durable iteration item (retrying would spawn a second child)

An agent whose model stream closes before the provider sends a finish reason, with no text written and no tool called, re-issues the call once in place on both engines, inside the same time budget. A second cutoff fails the node, and that failure is retryable.

A run-scoped override (evals use one) can only **tighten** a timeout, never loosen it.

## Engines: `inline` vs `durable`

Chosen once per workflow on the trigger node's `config.engine`. Absent means `durable`. A workflow-call callee runs on *its own* trigger's engine, never the caller's.

| | `durable` | `inline` |
| -- | -- | -- |
| What runs it | Cloudflare Workflows, each node wrapped in journaled steps | One in-process walk inside the run's Durable Object |
| Latency | multi-step cold start, journaling per node | low |
| Node `retries` | applied | **not applied**: a transient blip fails the node |
| Answer token streaming | impossible across a step boundary | possible, for the node the Output binds to ([[streaming]]) |
| Survives eviction / deploy | yes | resumes **in place**, up to 2 times, from the run's completed steps. The interrupted node and everything after it **re-execute**, so tool nodes should be idempotent. |
| Retry a failed run | `retry_run` with mode `resume` continues from the failed step on the pinned version; `restart` starts fresh on the latest version | only `restart`. Resuming into a new run is refused. |

Interactive work someone is waiting on wants `inline`. Long, multi-stage batch work wants `durable`.

## `informUser`

Every node has an `informUser` setting, which controls what the end user sees while it runs: `off`, `static` (a fixed note, `${var}` tokens allowed) or, for agents only, `dynamic` (live reasoning and/or tool-call lines). It is display-only and never changes execution. Steps inside an iteration are muted for the user; set the note on the iteration node itself. Details: [[streaming]].

## Limits that stop a run

- **Node budget:** 256 node executions per run by default (host-configurable). Each iteration item runs its own subgraph walk with its own budget.
- **Stall:** no ready node, nothing running, no Output reached, and no decision ever routed means the run fails with "Workflow stalled".
- More numbers: [[limits]].
