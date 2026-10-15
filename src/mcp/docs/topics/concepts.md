---
title: Dictionary
summary: Every noun you will meet in 007, A–Z, one or two lines each, with a pointer to the page that goes deeper.
order: 10
---

These are the words used in tool results, run traces and the other pages. Where an entry names a field, it is the field you will see in JSON.

## A–C

- **Actor**: the person a run acts for (`actorId` on the run). It is opaque text supplied by the host. Unattended runs (schedules, evals) have none. A workflow-call child run inherits it unless its trigger names a different one. See [[triggers]].
- **Agent**: a reusable, versioned model configuration that workflow nodes point at by id. It is one of two kinds, fixed at creation: **generation** (prompt + tools → an answer) or **decision** (a set of questions → a verdict). See [[agents]] and [[agents/decision]].
- **Agent node**: a node whose `config.agentId` points at an agent. It carries the bindings for that agent's `${variables}`, not the agent's behavior. See [[nodes/agent]].
- **Agent version**: an immutable published snapshot of an agent's config. Nodes float to the latest unless they pin `config.version`. See [[versioning]].
- **Aggregate**: a wait-for-all join that collects every live upstream output into a list. See [[nodes/aggregate]].
- **Answer / Output**: the value an Output node names with `config.source`. That value is what the caller of the run receives. See [[nodes/output]].
- **Binding**: how a node gets data. Either a `literal` value, or a `ref` (`nodeId` + dotted `path`) into an earlier node's output. Edges never carry data. See [[graph]].
- **Blob ref**: a small pointer that stands in for a large value spilled to external storage. Nodes that read it get the real text back transparently, if the host wired a resolver. See [[limits]].
- **Branch**: a yes/no routing node driven by a deterministic predicate, with no model call. See [[nodes/branch]].
- **Change log** (`wf_change`): the append-only record of who changed what, and when, across workflows, agents, evals, models and connectors. It is the only who-touched-this record. Read it with `list_changes`. See [[versioning]].
- **Check**: one assertion in an eval sample's check tree (`{ op, checks[] }`). Some checks are deterministic, others are judged by a model. See [[evals]].
- **Child run**: a run started by another run, either a workflow-call callee or one item of a durable iteration. It is linked by `parentRunId` / `parentNodeId` / `itemIndex`. See [[triggers]] and [[nodes/workflow]].
- **Connector**: a remote MCP server configured as a tool source. Its tools appear with ids of the form `mcp:<connector>:<tool>` and must be enabled one by one. See [[tools]].
- **Conversation agent**: an agent with `inputKind: "conversation"`. It runs on a bound message thread rather than a single rendered user message. See [[agents]].

## D–I

- **Decision agent**: an agent whose config is a question set plus rules that roll the answers up to a named **verdict**. The node outputs `{ answers, reasoning, verdict, because }`, and a Switch usually routes on `verdict`. See [[agents/decision]].
- **Draft**: the one editable, unpublished copy of a workflow graph or an agent config. There is one per entity, and it is overwritten on every save. Runs never execute a draft, except evals and previews that ask for it explicitly. See [[versioning]].
- **Durable engine**: the backend that wraps every node in journaled steps. It survives eviction, retries steps and can resume from the failed node, but it cannot stream tokens. It is chosen by `engine` on the trigger node. See [[execution]].
- **Edge**: `{ id, source, target, condition, fastTrack }`. It decides *when* a node may run (sequencing and routing), never *what* it reads. See [[graph]] and [[execution]].
- **Engine**: `durable` or `inline`, set per workflow on its trigger (`config.engine`, absent means durable). See [[execution]].
- **Eval run**: one launch of one or more eval sets. It is a resumable sweep with a frozen plan, not a workflow run. Each cell produces a real (eval-flagged) run. See [[evals]].
- **Eval set / Goal**: a suite that targets one agent or workflow (floating, or pinned to a version) plus its samples. See [[evals]].
- **Event**: a host-declared trigger kind, such as a chat message arriving. Its `inputSchema` validates the run's input. List them with `list_trigger_events`. See [[triggers]].
- **Feature request node**: a placeholder for a future idea. It passes its input through unchanged. See [[nodes/feature-request]].
- **Feedback**: a human thumbs rating on one answer, with triage state. Read it with `list_feedback` and `get_feedback_context`.
- **Graph**: the workflow definition, `{ version: 1, nodes, edges }`. See [[graph]].
- **Inline engine**: the in-process backend with one await per node and no journal. It has low latency and can stream, but no step retries and only limited resume. See [[execution]].
- **informUser**: a per-node setting for what the end user sees while the step runs (`off` / `static` note / `dynamic` live agent activity). See [[streaming]].
- **Iteration**: runs an embedded subgraph once per item of a list (`config.source`), in parallel up to `concurrency`. See [[nodes/iteration]].

## M–R

- **Manifest**: frozen at run start. It resolves every floating reference (agents, decision agents, called workflows, transitively) to the exact published version the run uses. A run never sees a publish that lands mid-run. See [[versioning]].
- **Matrix / sweep**: an eval run across several models and/or alternate prompts and attempts, with one result per cell. See [[evals]].
- **Model / provider**: models come from a host-supplied catalog (`list_models`). Agents reference a model by composite catalog id. A model must be enabled and capable of what the agent needs (tools, structured output, reasoning, web search).
- **Node**: one box on the graph. It has `id`, `label`, `kind`, `config`, plus optional `informUser` and `execution` policy. The kinds are listed in [[nodes]].
- **Note node**: a sticky note on the canvas. It never runs. See [[nodes/note]].
- **Passthrough**: emits an author-chosen value or the forwarded input, typically to give a branch arm the same shape as its sibling before a Race. See [[nodes/passthrough]].
- **Progress log**: the run's human-readable feed (`wf_run_log`), with entries at levels such as `progress` (user-facing) and developer levels. See [[streaming]] and [[debugging]].
- **Publish**: turns a draft into a new immutable version, which becomes what runs. Over MCP: `publish_workflow`, and `publish_agent` (dry run first). See [[versioning]].
- **Race**: a first-to-finish join. It fires when the first live upstream completes and passes the winner's value through. See [[nodes/race]].
- **Ref**: a binding `{ kind: "ref", nodeId, path }`. It reads any earlier node's output by id, not only the node directly upstream. See [[graph]].
- **Run** (`wf_run`): one execution of a published workflow version. Statuses: `queued`, `running`, `done` (the answer was delivered while other arms are still draining), `completed`, `failed`, `cancelled`. See [[execution]] and [[debugging]].
- **Run note**: a free-form Markdown scratchpad on a run, shared by everyone and searchable through `list_runs`. Write it with `update_description` (kind `run`).

## S–Z

- **Sample**: one eval case with three parts: the input (`task` / `conversation` / `trigger`), how each tool behaves (`live`, or `mocked` with an optional pinned output; write tools never run), and the check tree. See [[evals]].
- **Step** (`wf_run_step`): one row per node execution in a run, with input, output, meta, timing and status (`running`, `completed`, `failed`, `skipped`). Iteration items add one step per inner node per item. Read them with `get_run` and `get_run_step`. See [[debugging]].
- **Sub-agent**: an agent or workflow another agent may launch mid-generation through synthesized `spawn_*` tools, from a whitelist in its config. See [[agents/sub-agents]].
- **Switch**: multi-way routing that matches a value against cases, with an `else` fallback. See [[nodes/switch]].
- **Text node**: deterministic text built by filling `${variables}` from bindings, with no model. See [[nodes/text]].
- **Tool**: a function an agent can call, or a Tool node can call directly with no model. It is either host-registered or a connector tool. List them with `get_tool_catalog`. See [[tools]] and [[nodes/tool]].
- **Transform**: reshapes a value with a JSONata expression. See [[nodes/transform]].
- **Trigger**: the start node (exactly one per graph). `config.triggerKind` is `manual`, `periodic` (with `cron`) or a host event. Its output is the run's validated input. See [[triggers]] and [[nodes/trigger]].
- **Variable** (`${name}`): a placeholder in an agent prompt or a Text body. Each one is filled from a node binding, or from run-level prompt variables. Unbound variables reach the model literally. See [[graph]].
- **Verdict**: the named outcome a decision agent rolls up to. See [[agents/decision]].
- **Workflow**: a named, versioned graph that runs when its trigger fires. It can be archived (it then never runs on its event). See [[versioning]].
- **Workflow node**: calls another workflow and waits for its Output value. The callee runs as its own child run on its own engine. See [[nodes/workflow]].
- **Workflow version**: an immutable published graph. The highest number is what runs. See [[versioning]].
