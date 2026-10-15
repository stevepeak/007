---
title: Drafts, versions, publishing and the run manifest
summary: What runs (the latest published version, frozen per run), how drafts and pins work, publishing workflows and agents over MCP, and where history lives.
order: 80
---

## TL;DR

- Workflows and agents each have **one draft** (editable, overwritten on every save) and **immutable numbered versions**. The highest published version is what runs.
- References **float to latest**. An agent node with `config.version: null` uses the agent's newest published version, and a Workflow node always uses the callee's newest. A run **freezes** every reference into its **manifest** at run start, so a publish mid-run does not affect it.
- **Over MCP you can publish both.** `publish_workflow` publishes a workflow draft; `publish_agent` publishes an agent draft after a mandatory dry run, because one agent publish can change several workflows.
- A draft is not "unsaved edits". To see what it changes, diff it against the published version. The draft tools' replies report the delta.

## Drafts

- `patch_workflow_draft` (small named ops) and `update_workflow_draft` (whole graph) write the workflow draft. `update_agent_draft` writes the agent draft. All of them **replace the single draft a person may have open in the editor.**
- Rollback is `update_workflow_draft({ fromVersion })` / `update_agent_draft({ fromVersion })`: the draft becomes an exact copy of that published version, read server-side. Nothing is published until you publish.
- `discard_workflow_draft` / `discard_agent_draft` throw the draft away, so the editor shows the published version again.
- What reads a draft: `run_agent_preview`, and `run_eval` with `draftAgentId` (grades an unpublished agent). Real runs never read a draft.

## Publishing

**Workflows.** `publish_workflow({ workflowId, baseVersionNumber, changeNote })` publishes the current draft as the next version. It is refused when:

- the draft lints with any error (see `validate_workflow_graph`);
- `baseVersionNumber` is not the version live right now (someone published since you read it; pass `0` if never published);
- there is no draft, or the draft is identical to the live version.

`changeNote` is required and becomes the version's note in history and in the change feed. An AI summary of the diff is generated as part of the publish unless you pass `summarize: false`.

**Agents.** `create_agent` publishes v1 (so the agent is immediately usable). Later versions go through `publish_agent`, which takes two calls. Without `confirm` it is a dry run: it lists what changed, every published workflow that floats on the agent and will run the new version from its next run, and those pinned to an older version that won't, and returns a `confirm` token. With that token and a `changeNote` it publishes. It is refused when the token no longer matches the draft or live version, when `baseVersionNumber` is stale, when there is no draft or it equals the live version, or when the draft fails the same checks `update_agent_draft` runs. Grade the draft with `run_eval({ draftAgentId })` first.

**Who published, and notes.** Each version records `publishedBy`, which is the user the session is authorized as, plus the change note and the AI summary. There is **no separate approver field**. An approver's name can only be written into the free-text `changeNote`, for workflows and agents alike.

## Pinning

| reference | can pin? | how |
| --------- | -------- | --- |
| Agent node → agent | yes | `config.version: <n>` (null floats) |
| Sub-agent target → agent/workflow | yes | `version` on the target (see [[agents/sub-agents]]) |
| Eval set → target | yes | the set's pinned version (null floats) |
| Workflow node → workflow | no | always the callee's latest at run start |
| Event → workflow | no | always the assigned workflow's latest |

A pin on a version that was never published, or an `agentId` that does not exist, fails the run **before any step is recorded**. The run sits at `queued` with no logs. `validate_workflow_graph` catches both ahead of time.

## The run manifest

At run start every floating reference is resolved, transitively through called workflows and sub-agent targets, to `{ id, versionId, versionNumber, config|graph }`, and stored on the run. Consequences:

- A run is reproducible from its own row, even after its agents change or are archived.
- Republishing an agent does not affect runs already in flight, but changes every run started after.
- `retry_run` `restart` resolves a **new** manifest (latest versions), while `resume` keeps the original version.
- Eval drift has two axes. A sample's hash can't see that its floating target was republished, so `get_eval_run` reports that separately (`agentRepublishedSinceLastRun`). See [[evals]].

## History and audit

- `list_workflow_versions` / `list_agent_versions` list each version's number, note and AI summary, newest first. `get_workflow_version` reads one graph. `list_agent_versions({ versionNumber })` reads one config.
- `list_changes` reads the **change log**, the only who-touched-what record. It covers workflows, agents, eval sets and samples, models, trigger assignments, connectors and connector tools, with the actions create / update / publish / archive / restore / assign / enable / disable. Each entry carries an actor and a source (`ui`, `mcp`, `spec-import`, `system`).
- Archiving (`update_workflow` / the console) retires an entity without deleting it. An archived workflow never runs on its event. An agent cannot be archived while a live workflow still references it.
- The editor's undo is per browser tab and does not cover MCP edits. From MCP, "undo" means `fromVersion` or a discard.

## Moving definitions between environments

The SDK's `wf-spec` CLI exports and imports agents, workflows and eval sets as version-controlled JSON files keyed by **slug**, a stable identity that survives renames, unlike ids, which differ per database. Drafts and run history are not part of the spec. Import publishes changed entities as new versions.
