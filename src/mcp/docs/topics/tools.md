---
title: Tools
summary: Where tools come from, agent tools vs Tool nodes, argument validation, what a tool can read, large results, resume safety, and how tools behave in evals.
order: 55
---

A **tool** is a registered capability with a stable id. 007 ships none of the business logic; every tool comes from one registry the host builds. Read `get_tool_catalog` for the list, and `get_tool_catalog({ toolIds })` for full input/output schemas.

## Where tools come from (`origin`)

- `host` — written by this deployment. The default.
- `sdk` — shipped by 007 itself (for example text extraction, document rendering); fixed until the package is upgraded.
- `connector` — proxied from a remote MCP server the host connected. Id shape `mcp:<connectorId>:<toolName>`, which never collides with a host id. Its read/write classification comes from the remote tool's `readOnlyHint` annotation (absent = write). Changes on the remote side need a connector refresh (`refresh_connector`, `list_connectors`).

Each tool also declares (visible in the catalog): `sideEffect` (`read`/`write`/untagged — drives eval behaviour), `requiresContext` (ambient run scope the host supplies, never an argument; an empty scope usually means "matches nothing", not an error), and an optional `statusLabel` (the user-facing line shown when an agent calls it — see [[streaming]]).

## Two ways to call a tool

| | Agent tool (`toolIds` on an agent) | Tool node ([[nodes/tool]]) |
| - | - | - |
| who decides the arguments | the model | the graph: each arg is a literal or a `ref` |
| which registry entries | `ai-tool` entries only | both `function` and `ai-tool` entries |
| validation | the model's call is checked against the input schema | bound args are parsed through the input schema (defaults applied); a mismatch fails the node |
| result goes to | the model's next turn; recorded in the step trace | the node's output, readable by downstream refs |

Tool-node args are written against the tool's schema field names. `validate_workflow_graph` and the editor's Issues panel flag args that no longer match the schema; ref **paths** into upstream outputs are not checked.

## What a tool can read

A tool sees only its arguments and the host's per-run dependencies. It cannot inspect the run. In particular:

- A Tool node can read **node outputs** through `ref` bindings, nothing else.
- An agent node's output is its answer (`{ text }` or its object). The tool calls it made, and their results, are only in the step trace — **no downstream node or tool can reference them**.
- To let later logic see what an agent retrieved, either have the agent return it in a structured output (`output.kind: "object"`), or call the retrieval as Tool nodes and feed their outputs to both the agent (via `${vars}`) and the later step.
- For checking that an agent's citations were actually seen in this run, 007 has a built-in mechanism: an agent's `referenceKinds` validates every inline reference against its prompt, messages and every tool result (including sub-agents') and strips unsourced ones. See [[agents]].

## Large values

A tool (or any node) may return a **blob ref** — a pointer to stored bytes — instead of a large value. Downstream nodes rehydrate it to the real value inside their own step before interpolation or argument validation, provided the host configured a blob resolver. On the durable engine, oversized node outputs are spilled automatically at the step boundary. See [[limits]].

## Retries and resume

A node can be re-executed: durable-engine retries replay the node body, and the inline engine resumes an interrupted run (for example after a deploy) by re-running the node that was in flight. **Tools with side effects must be idempotent** — accept a caller-supplied key or check for an existing record — or a resume can duplicate the effect. See [[execution]].

## Tools in evals

Under eval simulation, per tool (keyed by tool id):

- `write` tools are **always** neutralized; they return `{ simulated: true }`. The call is still recorded for grading.
- `read` tools are `mocked` by default and return the sample's pinned output for that tool id (or `{}` if none is pinned). A sample can set a tool to `live` to hit real data.
- **Untagged tools run for real** even under simulation — the host must tag any tool with an external effect.
- One pinned output per tool id: every call to that tool returns it, from the primary agent and from sub-agents alike.
- A synthesis sample stages earlier tool results as a seeded assistant turn and pins nothing; the agent keeps its tools, and calling one returns `{}`. (Older samples saved with a `frozen` mode load this same way.)
- `run_agent_preview` is different again: all tools are simulated by the model writing plausible results.

See [[evals]].
