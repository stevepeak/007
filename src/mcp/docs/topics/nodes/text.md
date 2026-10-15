---
title: Text node
summary: Writes a block of Markdown with `${values}` filled from bindings — deterministic string assembly without an LLM.
order: 64
---

A `text` node emits a string: its `body` with every `${name}` token replaced by a bound value. It is for prose with one right answer — a message template, a prompt fragment, a fixed playbook — where spending a model call would add latency and nondeterminism. Deterministic and side-effect free.

## Config

| key | meaning |
| --- | ------- |
| `body` | Markdown text. `${name}` tokens are filled from `inputs`; everything else is emitted verbatim. |
| `inputs` | Map from each variable name used in `body` to a binding (`literal` or `ref`). Strings are used as-is, other values are JSON-stringified, `null`/missing become `""`. |

## Output

The filled-in string, bare (not wrapped in an object). Downstream refs use `path: ""`.

## Interpolation rules

- A variable name is letters, digits, `_` and `-` — `${client_name}`, `${item-count}`. Spaces are not allowed: `${my var}` is not a variable and is emitted literally.
- Markdown-escaped names such as `${my\_var}` (what the rich-text editor stores) are read as `my_var`.
- Only variables the body actually uses are resolved; a leftover binding the body no longer mentions is ignored.
- There is no conditional or loop syntax. For logic, compute the value upstream (a `transform`) and bind the result.

## Behavior and gotchas

- **Empty body** → the node fails ("has no text"). `validate_workflow_graph` flags it.
- **Unbound variable** → the node fails, naming every unbound `${token}`. It never emits a half-filled template.
- **Size.** 007 sets no maximum length on `body`. The practical bounds are the platform's: the whole graph — every text body included — is stored as one JSON value per version, and on the durable engine a node output above 128 KB is spilled to blob storage (transparently read back by downstream bindings), with a hard failure if an output still exceeds about 768 KB. MCP reads clip long fields (`get_run_step` returns up to 60,000 characters per field). Storing long reference text (playbooks, policies) in Text nodes works; keep each well under those limits. See [[limits]].
- **Timeout:** 60 seconds default; it is pure computation and never needs it.
- `informUser`: `off` or `static`.

```json
{
  "id": "greeting",
  "kind": "text",
  "label": "Compose greeting",
  "position": { "x": 300, "y": 120 },
  "config": {
    "body": "Hi ${name},\n\nWe found ${count} items that need review.",
    "inputs": {
      "name": { "kind": "ref", "nodeId": "trigger", "path": "user.name" },
      "count": { "kind": "ref", "nodeId": "scan", "path": "total" }
    }
  }
}
```
