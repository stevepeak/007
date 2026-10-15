---
title: Note node
summary: A Markdown sticky note on the canvas — never connected, never executed.
order: 65
---

A `note` is a canvas annotation for authors. It has no ports, is never connected by an edge, and never runs; it has zero effect on execution. Use it to explain a tricky part of the graph to the next author (human or model).

## Config

| key | meaning |
| --- | ------- |
| `text` | The note's Markdown body. |
| `width` | Editor-only width in pixels. Optional; ignored by the engine. |
| `height` | Editor-only height in pixels. Optional; ignored by the engine. |

## Output

None. A note has no output and cannot be the target of a ref.

## Behavior and gotchas

- Do not connect edges to or from a note.
- `informUser` and `execution` have no effect.

```json
{
  "id": "note-1",
  "kind": "note",
  "label": "Note",
  "position": { "x": 0, "y": 300 },
  "config": { "text": "The two checks below must both pass before the answer is released.", "width": 320, "height": 120 }
}
```
