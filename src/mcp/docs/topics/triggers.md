---
title: Triggers, run input and output contracts
summary: How a run starts (manual, periodic, host events), what its input looks like, what its Output must satisfy, and how identity flows into child runs.
order: 40
---

## TL;DR

- Every graph has exactly one trigger node. Its `config.triggerKind` says how the workflow starts. The trigger's **output is the run's validated input**, so downstream nodes `ref` it.
- Event triggers validate the input against the event's `inputSchema` before any node runs. They can also require the final answer to match an `outputContract`.
- A workflow called by another workflow runs as its own **child run**, under its own trigger kind. Its input is not validated and its output contract is not enforced, because it answers to the calling node.

## Trigger kinds

| `triggerKind` | starts when | input |
| ------------- | ----------- | ----- |
| `manual` | A person starts it. | Whatever was supplied, passed through unvalidated (`{}` if none). |
| `periodic` | On the schedule in `config.cron` (required for this kind). | Always `{}`. |
| *an event kind* | The host fires that event. | Parsed against the event's `inputSchema`, and the run fails before any node if it does not match. |
| `iteration_item` | Reserved for the trigger *inside* an Iteration's subgraph. | The current list item. Never startable. |

`list_trigger_events` lists the host's events. For each one it gives the exact `kind` string, a description, the payload fields, the payload's JSON Schema (what you can `ref`), and the `outputContract` if there is one. `manual` and `periodic` are built in and are not in that list.

007 stores and validates the cron expression, but the host is what actually fires schedules. `create_workflow` warns that a periodic workflow starts firing on its schedule once v1 is published, and v1 is published at creation.

The trigger also carries `config.engine` (`durable` / `inline`, absent means durable). It applies to the whole run. See [[execution]].

## Which workflow runs for an event

Each event kind is assigned to **one** workflow, a single global mapping. When the event fires, the workflow's **latest published version** runs. An **archived** workflow never runs on its event, even if it is still assigned. Assignments are managed by the host or console, not over MCP. A workflow whose trigger names an event but which is not the assigned one does not fire on it.

## Starting runs from MCP

There is no "start a run" tool. The ways an MCP session causes executions are:

- `retry_run`: re-run a finished run, either `restart` (fresh, on the latest published version) or `resume` (same version, from the failed step). **It executes real side effects.**
- `run_eval`: runs samples against an agent or workflow as real (eval-flagged) runs. See [[evals]].
- `run_agent_preview` / `run_decision_preview`: run one agent outside any workflow.

## The run's identity

A run carries opaque host references that the SDK never interprets:

- `subjectId`: what the run is about.
- `correlationId`: a grouping reference.
- `actorId`: the person it acts for. It is empty for unattended runs.

The run can also carry run-level prompt variables, which fill `${names}` no node binds (see [[graph]]), and opaque host context. Host tools read the subject and actor from the run context, not from the graph.

## Output contracts

If the trigger's event declares an `outputContract`, the value the run delivers (its first Output reached) is parsed against it. A mismatch **fails the run** with "Workflow output does not satisfy the '<kind>' trigger contract". Retrying will not fix it, because the binding is wrong. The editor and `validate_workflow_graph` check the Output's bound value against the contract ahead of time where they can. `manual`, `periodic` and events without a contract pass any value through.

Practical rule: read `outputContract` from `list_trigger_events` *before* binding the Output's `config.source`. A chat-style event typically wants a string or `{ text }`, not a whole agent result object.

## Child runs (workflow-call)

A Workflow node calls another workflow. The callee:

- Is its **own `wf_run`**, linked to the caller by `parentRunId` / `parentNodeId`. Its cost rolls up to the parent, and the run viewer nests it.
- Runs on the **engine its own trigger declares**. The caller cannot override that.
- Records **its own trigger kind**. Its subject, correlation and actor come from the callee trigger's identity resolver (if the host declared one for that kind) applied to the input the caller bound. Anything not named there is **inherited from the caller**.
- Receives the trigger input the node built from its `inputs` bindings, or the forwarded upstream value if there are none. That input is **not validated** against the callee's `inputSchema`, and the callee's output contract is **not enforced**.
- Is frozen into the caller's manifest at the caller's run start, at the callee's latest published version. Calls cannot pin a version.

Inside an *inline* iteration item, a callee cannot spawn a run of its own. It runs inline as a subgraph of that item instead. See [[nodes/workflow]].
