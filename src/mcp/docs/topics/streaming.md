---
title: What the end user sees, and when
summary: Token streaming of the answer (inline engine only, answer node only), what informUser off/static/dynamic emits, the progress feed, and how to hold the answer back until checks pass.
order: 35
---

There are two separate channels to an end user, and a host decides how much of each to show:

1. **The answer** — the value the Output node resolves to. Persisted once on the run when the Output is reached (run status `done`). On the inline engine, the answer can also stream token by token while it is being written.
2. **The progress feed** — `progress`-level lines in the run log, persisted as they happen, which a host polls by run id.

## Does the answer stream?

Only when **all** of these hold:

- The workflow runs on the **inline** engine (the trigger's `engine: "inline"`). The durable engine never streams: a durable step boundary cannot carry a token stream.
- The node is one that an Output node's `config.source` points at — an **answer node**. Every other node's text is never streamed, so an intermediate agent's working text cannot be mistaken for the answer.
- The node is an agent with `output.kind: "text"`. Structured answers never stream.
- The model is on a turn that **must** answer: tools are denied on that turn, or the agent has no tools. Text from a turn that might still call tools ("Let me search…") is not streamed, so what streams is exactly the final turn's text.

When it streams, it starts **as soon as that agent node runs** — not when the Output resolves, and regardless of whether other branches (for example checks running in parallel) have finished. Fragments go to an in-memory buffer on the run that a host reads by cursor; they are not persisted, and a reader that attaches late sees only the final answer. The run log records `⇢ streamed N chars of the answer live` or `⇢ answer not streamed …` on the node.

Whether those fragments reach a person is the **host's** choice — 007 only makes them available. A host that does not read the buffer delivers the answer whole.

## `informUser`: the progress feed

Every node has `informUser` (default `{ "mode": "off" }`). It controls **only** `progress`-level log lines — never the answer, never what the agent can do:

| mode | what it emits |
| ---- | ------------- |
| `off` | Nothing. |
| `static` | The author's `note`, once at node start, with `${var}` filled from run variables. On an Iteration it is emitted after the list resolves, so it can use the item count. |
| `dynamic` (agents only) | `tools: true` (default): one line per tool call, but **only for tools that declare a `statusLabel`**, interpolated from the call's arguments; other tools are silent. `reasoning: true` (default false): the model's reasoning text, one line per **finished turn** (not token by token), and only if the agent's `reasoning` is on so there is any. |

- Sub-agents inherit the primary node's `informUser`.
- Nodes **inside an Iteration** never emit progress lines (the iteration speaks for its body).
- Every other log level — `node-start`/`node-end`, `info`, `thinking`, `tool`, `warn`, `error`, run `state` markers — is a developer feed. It is always written, regardless of `informUser`. An end-user surface should show only `progress`.

## Holding everything back until checks pass

Possible, with graph shape alone:

1. **Do not bind the Output to the agent that writes the answer.** Add a gate node after it — for example a [[nodes/text]] node whose body is `${answer}`, with `answer` mapped to the agent's `text` — and bind the Output's `config.source` to the gate. Only the answer node streams, and a Text node does not, so nothing streams at all. The answer becomes visible only when the Output resolves.
2. **Make the gate wait for every check.** Draw an edge into the gate from the answer agent **and from every check node**. A normal node waits for all of its live incoming edges (see [[execution]]). Do not wire the checks straight into the Output: an Output fires on the **first** live incoming edge, not all of them.
3. **Route failures to a different ending.** Put a [[nodes/branch]] or [[nodes/switch]] on the check results before the gate, so a failed check leads to a different Output (or a different gate) and the approved Output's arm is never taken.
4. **Keep the drafting agent quiet.** Set its `informUser` to `off` (or `dynamic` with `reasoning: false`): reasoning lines can contain the draft answer. Tool status lines are usually harmless.
5. **Gate side effects too.** A Tool node that posts a message or sends anything does so the moment it runs; the Output does not hold it back. Give such nodes edges from the checks as well. Also, branches that do not feed the Output keep running after the answer is delivered (`done` → `completed`).

If the final delivery should still stream, make the gate itself a text agent (for example a short "deliver this approved answer verbatim" agent) and bind the Output to it: it runs only after its incoming edges are all satisfied, so it streams only approved text.

## What the host controls vs the engine

- **Engine**: which node may stream and from which turn; when the answer is final (`done`); which progress lines exist and when they are written.
- **Host**: whether to read the token buffer at all; which log levels to show end users; how and when to post the final answer (typically when the run reaches `done`). See [[triggers]] for output contracts.
