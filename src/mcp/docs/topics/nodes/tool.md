---
title: Tool node
summary: Calls one registered tool directly with bound args — no LLM; args are validated against the tool's schema.
order: 63
---

A `tool` node calls one registered tool deterministically, with arguments bound from literals or upstream outputs. No model is involved: the same tool an agent could call is invoked directly. Use it for fetches, writes and side effects the workflow should always perform, rather than leaving them to an agent's judgment.

## Config

| key | meaning |
| --- | ------- |
| `toolId` | The registered tool's id. `get_tool_catalog` lists every tool with its input schema. Connector (remote MCP) tools have ids of the form `mcp:<connector-slug>:<tool>`. |
| `args` | Map from each argument name to a binding (`literal` or `ref`). Each resolved value is passed as-is (not stringified), then the whole args object is validated and coerced by the tool's input schema — which also fills that schema's defaults. |

## Output

Whatever the tool returns, unchanged. Its shape is the tool's own contract; `get_tool_catalog` describes it where the tool declares one. The run step also records `{ toolId, args }` in its meta.

## Behavior and gotchas

- **Unregistered tool** → the node fails with "Tool '…' is not registered." A tool can disappear from a host between versions.
- **Arg drift.** If a tool's input schema changes after the workflow was published, the node fails at run time with a schema validation error. `validate_workflow_graph` checks every Tool node's args against the live catalog (unknown args, unbound required args, wrongly typed literals) — run it before publishing.
- **Timeout:** 60 seconds per attempt by default; raise `execution.timeoutMs` for slow tools. See [[execution]].
- **Retries replay the call.** `execution.retries`, durable-step replay and resuming a run can all execute the tool again. Prefer tools that are idempotent, or keep retries off for non-idempotent side effects.
- **Evals:** under simulation, side-effecting (write) tools no-op and read tools return fixtures, unless the sample marks a tool live; the call is still recorded so a check can assert it happened. See [[evals]].
- Large string values spilled to blob storage upstream are read back before the call, so the tool sees real values.
- `informUser`: `off` or `static`.

```json
{
  "id": "fetch-doc",
  "kind": "tool",
  "label": "Fetch document",
  "position": { "x": 300, "y": 0 },
  "config": {
    "toolId": "fetch_document",
    "args": {
      "documentId": { "kind": "ref", "nodeId": "trigger", "path": "documentId" },
      "maxPages": { "kind": "literal", "value": 20 }
    }
  }
}
```
