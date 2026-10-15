---
title: 007 — TL;DR and dictionary
summary: Start here. What 007 is in ten lines, every node kind and MCP tool, and the index of every page.
order: 0
---

## TL;DR

- **A workflow is a graph.** One `trigger` node starts it, one `output` node names its answer, and the nodes between do the work. Edges say *when* a node may run. A node reads any upstream node's output by **ref** (`{ kind: 'ref', nodeId, path }`) — only the join-style kinds (`race`, `aggregate`, `passthrough`, …) take what their incoming edges deliver. → [[graph]]
- **An ordinary node waits for ALL its incoming edges; `race` and `output` fire on the FIRST.** An edge from a decision arm that wasn't taken never fires, so a node joining it is skipped. `fastTrack` holds other work back until a marked path finishes. Read the rules before wiring anything with more than one incoming edge. → [[execution]]
- **Agents are reusable and versioned.** An `agent` node points at an agent by id; the agent's config (model, prompts, tools, output contract) lives on the agent, not the node. Data reaches it only through `${variables}` the node binds, or a bound conversation. → [[agents]]
- **References float; runs freeze.** Workflows and agents each have a draft and published versions. A node follows the latest published agent unless it pins a version; a run freezes everything it will use into its manifest at start. → [[versioning]]
- **Two engines.** `durable` survives eviction, retries nodes and can resume; `inline` is fast, interactive and can stream. The trigger picks one for the whole run. → [[execution]]
- **The answer can stream before anything else finishes.** On the `inline` engine, a text agent that the `output` names streams its tokens as it generates — edges into the `output` do not hold that back. To gate an answer behind checks, have the `output` name a node *after* the checks. `informUser` controls live progress per node. → [[streaming]]
- **Evals grade agents and workflows** against samples with checks, optionally across models and prompts. → [[evals]]
- **Through this MCP you can** read everything, and — on a write connection — create, patch and publish workflows and agents, run previews and evals. Publishing an agent is a dry run first, because it can change several workflows at once. → [[authoring]]
- **When something went wrong**, start at `list_runs` → `get_run` → `get_run_step`. → [[debugging]]
- **Words you don't know** are in [[concepts]]; hard numbers are in [[limits]].

## How to read these docs

`get_docs({ topic: "<id>" })` opens a page — ids are listed below, and a bare node kind (`"race"`) works. `get_docs({ query: "<words>" })` searches every page and returns the matching sections; use it for a config key (`"continueOnError"`) or a question (`"wait for all"`). Cross-references look like [[concepts]] — pass the id inside the brackets as `topic`.

## Node kinds

Each has a page: `get_docs({ topic: "nodes/<kind>" })`.

{{node-kinds}}

## MCP tools

{{mcp-tools}}

## Every page

{{topics}}
