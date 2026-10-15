---
title: Race node
summary: First-to-finish join — fires once on the first live incoming edge and passes that output through; losers keep running.
order: 71
---

A Race fires as soon as **any one** of its incoming edges is live, and passes the winning upstream's output through unchanged. It has two jobs:

1. **Merging decision arms.** It is the only join allowed to take edges from both arms of a Branch or Switch. Only one arm ever runs, so the Race fires on whichever one did. This is the most common use.
2. **First-past-the-post.** Several parallel producers of the same-shaped result feed it, and the fastest one wins.

## Config

None. `config` is `{}`.

## Output

The winner's output, as a single value. It is not wrapped and not keyed by node id. The winner is the first **live** incoming edge, in edge-declaration order, at the moment the Race fires. Because dispatch is rolling, that is normally the upstream that finished first; declaration order only breaks a tie between upstreams that completed on the same settle.

## Losing branches: what happens to them

- **They are not cancelled.** In-flight work cannot be cancelled on either engine. Every upstream that started runs to completion, side effects included: a losing tool node still sends its email or writes its record.
- **Their results are recorded but ignored by the Race.** It has already fired, exactly once.
- **Their downstream still runs.** A loser completes normally, so any other node fed by it becomes ready and runs.
- **The run waits for them.** They count as pending work, so the run is `done` once the answer is out but `completed` only after the losers (and their downstream) finish. A loser that fails after the answer is a drain error, not a run failure. A loser that fails *before* the answer fails the run, like any other node failure. See [[execution]].
- On a **decision merge**, the untaken arm never started, so there is nothing to lose.

If you need "do A or B, never both", route with a [[nodes/branch]] or [[nodes/switch]], not a Race. A Race only picks whose *result* to use; it doesn't stop the other work from happening.

## Behavior and gotchas

- All inputs should share one shape, because downstream sees whichever arrived first. [[nodes/passthrough]] reshapes one arm to match its sibling.
- A Race seals join analysis. Validation treats paths through a Race as already merged, so a node downstream of a Race that merged both arms of a Branch is not rejected as a both-arms join.
- A node downstream of the Race that also refs a *specific* arm's node will fail to resolve that ref when that arm didn't run. Read the Race's output instead.

```json
{ "id": "merge", "kind": "race", "label": "Merge arms",
  "position": { "x": 0, "y": 0 }, "config": {} }
```
Edges: `{ "source": "yes-path", "target": "merge" }` and `{ "source": "no-path", "target": "merge" }`, both unconditioned. The `condition` lives on the Branch's own outgoing edges.
