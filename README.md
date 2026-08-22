# `@stevepeak/007` — AI-workflow SDK

A whitelabeled SDK for building and running AI workflows. One package owns the
**execution engine**, the **SQL storage + migrations**, the **Cloudflare
Workflows runtime**, the **RPC data layer**, and the **editor + run-viewer UI**.

Everything provider- or domain-specific — the model provider, the tools, the
tenant identity — is **injected by the host**, so the same package drops into any
project. The engine itself imports **no** AI provider; it depends only on `ai`
and `zod`. Switching from OpenAI to OpenRouter to a custom endpoint is a one-line
change in the host's `getModel`.

> **Integrating it into a project?** See [`guide.md`](./guide.md) — the practical
> step-by-step. This README explains what the SDK _is_ and how it works.
>
> **Changing the SDK itself?** See [`AGENTS.md`](./AGENTS.md) — where things
> live, what the compiler will and won't catch, and the conventions.

---

## The idea

The host supplies **provider, tools, a D1 handle, run identity, and its design
system**. The SDK supplies **everything else**.

| Injected by the host          | Owned by the SDK                                      |
| ----------------------------- | ---------------------------------------------------- |
| `getModel` (the AI provider)  | Graph model + validation (zod)                       |
| `toolRegistry` (the tools)    | Execution engine (scheduler + nodes)                 |
| `triggers` (event schemas)    | `wf_*` D1 schema, migrations, data access            |
| `buildRunDeps` (per-run deps) | Cloudflare runtime (`GraphWorkflow`, `RunRoom`)      |
| run identity (`subjectId`, …) | Editor, run-viewer, and hub UI                       |
| design-system primitives      | Reusable Agents, evals, blob-ref spilling            |

All of that injection travels in one object, `WfSdkConfig<TDeps>`, where `TDeps`
is the host's private per-run bundle the SDK threads into tools but never
inspects.

---

## Package layout

```
src/
├── index.ts     barrel: engine + storage + eval
├── engine/      pure execution — NO DB, NO Cloudflare, NO provider (only ai + zod)
│                config · graph schema · scheduler · run-node · nodes/
├── storage/     Drizzle over Cloudflare D1 — the wf_* tables + data access
├── cloudflare/  Workers runtime — GraphWorkflow, RunRoom, startGraphRun, tools
├── server/      framework-agnostic RPC data layer — one POST route
├── tools/       built-in provider-agnostic tools (e.g. Tavily web search)
├── ui/          React editor + run-viewer, with injectable design-system chrome
└── eval/        run a graph in-process with mock model/tools — no DB, no CF
```

**Dependency direction — one way, no cycles:**

```
ui → server → storage → engine
cloudflare  → storage → engine
host app → (injects WfSdkConfig) → engine
```

`engine` depends on nothing in the SDK, only `ai` + `zod`. That's what makes it
publishable and reusable.

Import only the layer you need via subpaths: `@stevepeak/007/engine`,
`/storage`, `/cloudflare`, `/server`, `/tools`, `/ui`, `/eval`. (The full table
is in [`guide.md`](./guide.md).)

---

## The graph model

A workflow is a directed graph. Two engine-managed bookends — **trigger** and
**output** — wrap the real work. The graph is validated by `workflowGraphSchema`
(zod).

```
┌─────────┐    ┌─────────┐    ┌────────┐ yes ┌─────────┐    ┌────────┐
│ trigger │ ─▶ │  agent  │ ─▶ │ branch │ ──▶ │  agent  │ ─▶ │ output │
└─────────┘    └─────────┘    └───┬────┘     └─────────┘    └────────┘
                                  │ no             ▲
                                  └────────────────┘
```

**Node kinds:**

| kind              | what it does                                                        |
| ----------------- | ------------------------------------------------------------------- |
| `trigger`         | entry bookend, seeded with the validated trigger input              |
| `agent`           | tool-calling LLM loop, or structured output when given a schema     |
| `tool`            | a single function-tool call; args bound from prior outputs          |
| `branch`          | deterministic yes/no predicate (no LLM); routes the live edge       |
| `switch`          | deterministic multi-way routing to a matched case                   |
| `iteration`       | fans a list out over an embedded subgraph, one run per item         |
| `workflow`        | calls another workflow inline and returns its output                |
| `race`            | first-to-finish join — forwards the winning upstream                |
| `aggregate`       | wait-for-all join — forwards the ordered list of upstream outputs   |
| `feature-request` | pass-through placeholder capturing a "wish it did X" note           |
| `note`            | a portless canvas annotation; never executes                        |
| `output`          | terminal bookend; its input is the run's result                     |

Nodes pass data forward by reference: a downstream node's config `ref`s any prior
node's output. Decision nodes (`branch`/`switch`) emit only a routing decision
and pass their input through unchanged.

### Example graph (a minimal chat workflow)

```jsonc
{
  "version": 1,
  "nodes": [
    { "id": "t", "kind": "trigger", "label": "Chat",
      "position": { "x": 0, "y": 0 },
      "config": { "triggerKind": "chat_message" } },
    { "id": "a", "kind": "agent", "label": "Assistant",
      "position": { "x": 280, "y": 0 },
      "config": {
        "modelId": "gpt-4o-mini",
        "systemPrompt": "Help ${orgName}.",
        "toolIds": ["search_docs"],
        "maxSteps": 8,
        "stream": true } },
    { "id": "o", "kind": "output", "label": "Reply",
      "position": { "x": 560, "y": 0 }, "config": {} }
  ],
  "edges": [
    { "id": "e1", "source": "t", "target": "a", "condition": null },
    { "id": "e2", "source": "a", "target": "o", "condition": null }
  ]
}
```

---

## The scheduler — the pure heart

`Scheduler` (engine/scheduler.ts) owns the graph walk and does **no I/O**. A
backend pulls instructions and feeds results back — which is what lets the
in-process executor (for evals/tests) and the Cloudflare backend share identical
semantics.

```
scheduler.seedTrigger(triggerInput)
while (true) {
  const i = scheduler.next()
  if (i.type === 'stall')  throw new WorkflowStalledError()
  if (i.type === 'output') { finalize(i.output); return }
  const r = await runNode(i, ctx)              // ← host model + host tools
  recorder.record({ nodeId: i.node.id, output: r.recordedOutput })
  scheduler.report(i.node.id, { output: r.schedulerOutput, branchResult: r.branchResult })
}
```

`next()` returns `{ type: 'execute', node, input }`, `{ type: 'output', output }`,
or `{ type: 'stall' }`. The backend runs the node and calls `report()` to feed
the result back into the scheduler's in-memory state. `runNode` is recorder-free,
so the same node logic runs whether it's driven in-process or inside a Cloudflare
`step.do`.

---

## The host-injection contract

`WfSdkConfig<TDeps>` (engine/config.ts) is the single object a host supplies:

```ts
interface WfSdkConfig<TDeps> {
  getModel(modelId: string, ctx: RunContext): LanguageModel // host provider
  listModels(ctx): ModelOption[] | Promise<…>               // editor dropdown
  listProviders(ctx): ModelProvider[] | Promise<…>          // provider grouping
  toolRegistry: ToolRegistry<TDeps>                         // host tools
  buildRunDeps(ctx: RunContext): TDeps | Promise<TDeps>     // per-run deps
  triggers: TriggerRegistry                                 // event kinds + schemas
  resolveBlobRef?, resolveImageRef?                         // optional (large / image inputs)
  onRunComplete?, onRunFailed?                              // optional host callbacks
}
```

`getModel` and `buildRunDeps` both receive the `RunContext`, so they read live
Cloudflare bindings (an API key, a D1 handle) that only exist **inside** a
`step.do` — never at module load. Wrap the object in `defineWfConfig<TDeps>({…})`
to validate every injection point at startup instead of mid-run.

### Example: an Acme Inc host config

Everything Acme-specific lives in the host package, plugged into the generic SDK.
Here Acme uses OpenAI as its provider and one search tool over its docs:

```ts
import { openai } from '@ai-sdk/openai'
import { defineWfConfig, type ToolRegistry } from '@stevepeak/007'
import { createSearchDocsTool } from '@acme/tools'
import { createDb } from '@acme/db'

// Acme's private per-run deps — whatever its tools consume.
type AcmeDeps = {
  orgId: string
  userId: string
  db: ReturnType<typeof createDb>
}

const toolRegistry: ToolRegistry<AcmeDeps> = new Map([
  [
    'search_docs',
    {
      id: 'search_docs',
      kind: 'ai-tool',
      description: 'Search the Acme knowledge base.',
      build: (d) => createSearchDocsTool({ orgId: d.orgId, db: d.db }),
    },
  ],
])

export const wfConfig = defineWfConfig<AcmeDeps>({
  getModel: (modelId, ctx) => openai(modelId), // ctx.env carries live bindings
  listModels: () => [{ id: 'gpt-4o-mini', label: 'GPT-4o mini', providerId: 'openai' }],
  listProviders: () => [{ id: 'openai', label: 'OpenAI', kind: 'openai' }],
  toolRegistry,
  triggers: {
    chat_message: {
      description: 'New chat message',
      inputSchema: chatMessageInputSchema,
    },
  },
  buildRunDeps: (ctx) => {
    const env = ctx.env as AcmeEnv // live bindings inside step.do
    return {
      orgId: ctx.correlationId ?? '',
      userId: ctx.promptVariables?.userId ?? '',
      db: createDb(env.DB),
    }
  },
})
```

A different host swaps only `getModel` (and its own deps). For OpenRouter:

```ts
import { createOpenRouter } from '@openrouter/ai-sdk-provider'

getModel: (modelId, ctx) =>
  createOpenRouter({ apiKey: (ctx.env as MyEnv).OPENROUTER_API_KEY })(modelId),
```

### Blob refs — spilling values too big to cross a step boundary

Cloudflare Workflows caps the size of a value returned from `step.do`. A node
that produces something large (an OCR'd document, a big search payload) returns a
**pointer** — `WfBlobRef` — to bytes it stashed in external storage (R2/KV/S3)
instead. A downstream node rehydrates the pointer **inside its own step**, so the
large payload never sits at a boundary.

The engine stays provider-agnostic — it only knows the marker shape and
deep-walks a node's input replacing any ref. The actual read is the host's
injected `resolveBlobRef(ref, deps)`. Omit it and refs pass through untouched.
The SDK ships a built-in producer (the `extract_text` R2/Vision OCR tool) and a
matching resolver (`createR2BlobResolver`); a host on other storage writes its
own.

---

## Storage — one workspace per database

All tables are prefixed `wf_`; identity columns are **opaque text** (no foreign
keys into host tables), so the schema drops into any D1 database alongside a
host's own schema. The SDK is **single-workspace per database** — it has no
tenant column of its own. A multi-tenant host isolates tenants by giving each its
own database (or logical D1 scope); that isolation lives entirely in the host.

```
 wf_workflow ──< wf_workflow_version >── wf_run ──< wf_run_step
     │                  ▲                  ▲              (unique run_id+node_id
 wf_workflow_draft      │              wf_workflow            → idempotent upsert)
 (1:1 editable)    wf_workflow_assignment (one workflow per triggerKind)

 same lifecycle (entity + 1:1 draft + immutable versions): wf_agent + _version + _draft
```

Workflows and agents share one lifecycle shape — an **entity + 1:1 editable draft
+ immutable published versions**. Agent nodes float to the latest version via a
run manifest frozen at run start. Alongside these are tables for models
(`wf_model`, `wf_model_provider`), evals (`wf_eval_*`), feedback (`wf_feedback`),
and the live run log (`wf_run_log`).

At run time the host attaches its own opaque references, read back in
`buildRunDeps`:

```
subjectId      the host entity a run is about                 → e.g. chatId
correlationId  free-form host reference (org/tenant scope)    → e.g. orgId
promptVariables ${name} interpolation + arbitrary run vars    → e.g. { userId }
```

### Why the recorder is idempotent

`step.do` retries and DO hibernation reset JS memory, so the recorder can't use
an in-memory counter. Instead `sequence` comes from the **deterministic walk
order** (replayed identically every time), and the write upserts on
`(run_id, node_id)` — the same row is updated on retry, never duplicated.

---

## Cloudflare execution flow

`startGraphRun` (turnkey) → `GraphWorkflow.run` (durable) → `RunRoom` (live
progress).

```
host route → startGraphRun(env, { workflowVersionId, triggerKind, triggerInput })
   │  createRun() → wf_run (queued); GRAPH_WORKFLOW.create(); RUN_ROOM.init()
   │  returns { runId, workflowRunId, instanceId }
   ▼
GraphWorkflow.run(event, step):
   step.do("load-graph")   → getVersionGraph()
   step.do("begin-run")    → markRunRunning()
   new Scheduler(graph); seedTrigger(validated input)
   loop: scheduler.next()
     ├ execute → step.do("step:<id>", async () => {
     │             deps = config.buildRunDeps({ ...ctx, env })
     │             r = await runNode(instruction, { getModel, toolRegistry, deps, sink })
     │             recorder.record({ … })          // wf_run_step upsert
     │             return r })
     │           scheduler.report(id, r)
     ├ output  → finalizeRun() + RunRoom.setOutput() → return
     └ stall   → throw
   catch → failRun() + RunRoom.setError()
```

**Determinism invariants:** step names = node ids; `sequence` from the walk; no
`Date.now()`/`Math.random()` in the orchestrator; `buildRunDeps`/`getModel`/
recorder all built _inside_ each `step.do` (live bindings can't cross the
boundary).

Browsers watch a run live over the `RunRoom` Durable Object (WebSocket
hibernation API), or poll `getRun` when no socket is available.

---

## Server — the RPC data layer

`server/` is one framework-agnostic POST route between the UI and storage. The
whole data surface is one interface, `WfDataClient`.

```
UI hooks → createHttpWfDataClient({ baseUrl }) ── { method, params } over POST ──▶
                                                                                 │
host route mounts createWfSdkHandlers({ config, resolveDb, resolveContext })     ▼
   resolveContext(req) → { userId? }   ← host auth (attribution only)
   resolveDb(req)      → WfDb          ← host D1 handle (the workspace)
   dispatch → storage/data.ts
```

The host gates the route itself (its own auth decides who may reach the editor)
and picks which database `resolveDb` returns — that's where tenant isolation
lives. The SDK's `resolveContext` supplies only `{ userId? }`, used to attribute
who created or published a draft/version.

---

## UI — editor + run-viewer

`ui/` is React (DOM + JSX, separate tsconfig). It ships **behavior, not chrome**:
Button/Badge/Input/Label/Textarea are **injected** through `WfSdkProvider` so the
host's design system renders everything. Data flows through a `WfDataClient` (the
HTTP one in production, a mock one in tests).

```tsx
<WfSdkProvider client={createHttpWfDataClient({ baseUrl: '/api/wf' })} components={hostPrimitives}>
  <WfApp basePath="/wf" path={path} navigate={navigate} />  {/* the whole surface */}
  {/* or mount pieces directly: */}
  <WorkflowEditor workflowId={id} />   {/* canvas · palette · inspector */}
  <RunViewer runId={workflowRunId} />  {/* status + per-step trace */}
</WfSdkProvider>
```

- **`WfApp`** — the entire router-agnostic surface behind one component: hub,
  workflows list + editor, agents list + editor, runs explorer + run page. The
  host injects `basePath` / `path` / `navigate` (the SDK never imports a router).
- **`WorkflowEditor`** — `@xyflow/react` canvas + node palette + inspector, with
  undo/redo, version history, save-draft, and publish.
- **`RunViewer`** — one run and its `wf_run_step` trace; live progress when a
  `RunRoom` socket is available, otherwise polls `getRun`.

---

## Eval / testing

`eval/index.ts` runs a graph through the in-process executor with a mock model,
mock tools, and an in-memory recorder — no DB, no Cloudflare:

```ts
import { runWorkflowUnderConditions } from '@stevepeak/007/eval'
import { MockLanguageModelV3 } from 'ai/test'

const run = await runWorkflowUnderConditions({
  name: 'happy path',
  graph: myGraph,
  triggerInput: { chatId: 'c1', userText: 'hello', messages: [] },
  config: {
    getModel: () => new MockLanguageModelV3({ doGenerate: async () => ({ text: 'hi' }) }),
    listModels: () => [],
    listProviders: () => [],
    toolRegistry: new Map(),
    triggers: { chat_message: { description: '', inputSchema: chatInputSchema } },
    buildRunDeps: () => ({}),
  },
})

expect(run.output).toEqual({ text: 'hi' })
expect(run.steps.map((s) => s.nodeKind)).toEqual(['trigger', 'agent', 'output'])
```

---

## License

MIT. Repo: [github.com/stevepeak/007](https://github.com/stevepeak/007).
