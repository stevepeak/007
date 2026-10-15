---
title: Transform node
summary: Reshapes data with a JSONata expression — concatenate, map JSON to text, slice a conversation, combine several upstreams — with an optional shape check.
order: 68
---

A `transform` node runs a [JSONata](https://docs.jsonata.org) expression over an upstream value and emits the result. Bindings can only *address* data (dotted paths); a transform *reworks* it — mapping rows to messages, joining strings, filtering, slicing, building objects. It is deterministic and side-effect free. JavaScript is not available (the runtime forbids code generation); JSONata is the whole language.

## Config

| key | meaning |
| --- | ------- |
| `source` | Binding for the value the expression walks, available as `$` (and as the implicit context). Unset → the node's incoming input (one live parent: its output; several: an object keyed by parent node id). Bind it explicitly whenever there is more than one parent. |
| `inputs` | Map of name → binding. Each is exposed to the expression as `$name`, so one transform can combine several upstream outputs without a join node. |
| `expression` | The JSONata expression. Compiled when the editor saves and again on every run. Empty → the node fails. |
| `outputShape` | Optional assertion on the result. The one shape today is `conversation`: an **array** of `{ id?, role: "system"|"user"|"assistant", parts: [{ type, … }, …] }` with at least one part each — what a conversation agent's `conversation` binding needs. A mismatch fails the node with the offending path and a hint. |

## Output

The expression's return value, as-is. No wrapping: a string expression yields a bare string (ref with `path: ""`).

## Worked expressions

The examples assume `source` is bound to a message array (e.g. the trigger's `messages`), each message `{ id, role, parts: [{ type: "text", text }] }`.

**Concatenate strings, with an extra input** (`inputs.heading` bound to a string):

```
$heading & ": " & $count($) & " messages"
```

**Flatten a conversation to plain text:**

```
$join($.(role & ": " & $join(parts[type="text"].text, "")), "\n")
```

**Last N messages** (here 3; safe when the thread is shorter). Note `$all := $` first — inside a `[ … ]` predicate, `$` means the current item, not the whole array:

```
($n := 3; $all := $; $start := $max([0, $count($all) - $n]);
 [$filter($all, function($v, $i) { $i >= $start })])
```

**Prior assistant turn + newest message**, as a conversation (with `outputShape: "conversation"`):

```
($all := $;
 $prior := $filter($all, function($v) { $v.role = "assistant" });
 [$count($prior) > 0 ? $prior[-1] : (), $all[-1]])
```

…or the same as one text block for a task agent's `${variable}`:

```
"Previous answer:\n" & $join($[role="assistant"][-1].parts[type="text"].text, "")
& "\n\nNew message:\n" & $join($[-1].parts[type="text"].text, "")
```

**Map records to messages** (rows `{ id, role, body }`):

```
[$.{ "id": id, "role": role = "assistant" ? "assistant" : "user",
     "parts": [{ "type": "text", "text": body }] }]
```

## Behavior and gotchas

- **Wrap list results in `[ … ]`.** JSONata collapses a one-element sequence to a bare value, so a one-message thread yields an object where longer threads yield arrays. The outer `[ … ]` array constructor keeps it an array; `outputShape: "conversation"` catches the mistake at this node instead of deep inside the agent.
- **Errors fail the node:** a syntax error (with position), an evaluation error, or a shape mismatch. Refs in `source`/`inputs` to nodes with no output also throw.
- **Guards:** recursion deeper than 200 frames is stopped; evaluation is capped at 2 seconds where the runtime clock allows (a tail-recursive infinite loop may instead run until the platform kills the step).
- Blob-spilled upstream values are read back before evaluation.
- `informUser`: `off` or `static`. Timeout: 60 seconds default.

```json
{
  "id": "last-turns",
  "kind": "transform",
  "label": "Prior answer + new message",
  "position": { "x": 300, "y": 0 },
  "config": {
    "source": { "kind": "ref", "nodeId": "trigger", "path": "messages" },
    "inputs": {},
    "expression": "($all := $; $prior := $filter($all, function($v) { $v.role = \"assistant\" }); [$count($prior) > 0 ? $prior[-1] : (), $all[-1]])",
    "outputShape": "conversation"
  }
}
```
