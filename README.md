# `@app/wf-sdk` — Layout & How It Works

A whitelabeled AI-workflow SDK: one package owns the **execution engine**, the
**SQL storage + migrations**, the **Cloudflare Workflows runtime**, the
**RPC data layer**, and the **editor + run-viewer UI**. Everything provider- or
domain-specific (the model provider, the tools, tenant identity) is **injected by
the host**, so the same package drops into any project.

In this repo the host wiring lives in a thin companion package **`@app/wf-host`**
(the AI provider — Venice here, but any AI-SDK model works — plus legal tools, the
chat trigger, the seed helper). Both `apps/web` and `apps/workflows` consume the
SDK through it. Removing `wf-host` + `@app/wf-sdk` from a fork is all it takes to
reuse the engine elsewhere. The SDK core imports **no** AI provider — a fork on
OpenRouter, OpenAI, etc. only changes `getModel` in its host package.

---

## 1. Package layout

```
packages/wf-sdk/
├── package.json            @app/wf-sdk  (exports: ., /cloudflare, /cloudflare/extract-text,
│                                          /engine, /eval, /server, /storage, /storage/schema,
│                                          /tools, /ui)
├── drizzle.config.ts       → generates migrations from storage/schema.ts
├── migrations/             0000–0002_*.sql  (9 tables; host points migrations_dir here)
└── src/
    ├── index.ts            barrel: engine + storage + eval
    ├── engine/             pure execution — NO DB, NO Cloudflare, NO provider
    │   ├── config.ts          WfSdkConfig<TDeps>, RunContext, ModelFactory   ← the contract
    │   ├── graph.ts           zod schema + WorkflowNode/Edge/Graph + WF_NODE_KINDS
    │   ├── blob-ref.ts        WfBlobRef pointer convention + rehydrateBlobRefs (large-value spill)
    │   ├── scheduler.ts       Scheduler: pure graph walk (seed/next/report)
    │   ├── scheduler.test.ts  unit tests (green)
    │   ├── run-node.ts        runNode(): recorder-free node dispatch
    │   ├── executor.ts        executeWorkflow(): in-process backend (eval/tests)
    │   ├── run-recorder.ts    RunRecorder interface + createMemoryRunRecorder
    │   ├── tool-registry.ts   ToolRegistry<TDeps> + buildAgentToolSet
    │   ├── trigger-registry.ts TriggerRegistry type + getTriggerEntry
    │   ├── stream-sink.ts     StreamSink interface (progress fan-out)
    │   └── nodes/             agent · judge · branch · tool · feature-request
    ├── storage/            persistence — Drizzle over Cloudflare D1
    │   ├── schema.ts          wf_* tables — workflow/agent + runs (opaque tenancy)
    │   ├── client.ts          createWfDb(d1) → WfDb  (imports D1Database explicitly)
    │   ├── data.ts            data-access functions (workflows, agents, versions, runs)
    │   └── run-recorder.ts    createDurableRunRecorder() — idempotent upsert
    ├── cloudflare/         Workers runtime — imports 'cloudflare:workers'
    │   ├── graph-workflow.ts  makeGraphWorkflow(config) → WorkflowEntrypoint
    │   ├── run-room.ts        RunRoom Durable Object (WS/SSE live progress)
    │   ├── start-run.ts       startGraphRun(env, input) — turnkey starter
    │   └── extract-text.ts    createExtractTextTool() — R2/Vision OCR tool (own subpath)
    ├── server/            RPC data layer — framework-agnostic, one POST route
    │   ├── protocol.ts        WfDataClient interface + request/response DTOs
    │   ├── handlers.ts        createWfSdkHandlers() — tenant-scoped dispatch
    │   └── http-client.ts     createHttpWfDataClient() — browser → route
    ├── tools/             built-in provider-agnostic tools (fetch + injected deps)
    │   └── tavily.ts          createTavilyTool() — web search
    ├── ui/                React (DOM+JSX) — editor + run-viewer, injectable chrome
    │   ├── provider.tsx       WfSdkProvider (client + injected primitives)
    │   ├── primitives.tsx     Button/Badge/Input/Label/Textarea seams
    │   ├── hooks.ts           react-query hooks over WfDataClient
    │   ├── wf-app.tsx         WfApp — the whole editor/runs/agents surface, one component
    │   ├── run-viewer.tsx     RunViewer — a single run + its step trace
    │   └── editor/            WorkflowEditor + AgentEditor (canvas · palette · inspector)
    └── eval/
        └── index.ts          runWorkflowUnderConditions() — mock model/tools
```

`ui/` is compiled by a separate `tsconfig.ui.json` (DOM + JSX libs); everything
else compiles under the main `tsconfig.json` (workers-types). `typecheck` runs
both projects. `storage/client.ts` imports `D1Database` from
`@cloudflare/workers-types` explicitly so the DOM-lib web app can consume it.

**Dependency direction (one way, no cycles):**

```
ui  ─▶  server  ─▶  storage  ─▶  engine
cloudflare  ─▶  storage  ─▶  engine
host app ─▶ (injects WfSdkConfig) ─▶ engine
```

`engine` depends on nothing in the SDK but `ai` + `zod`. That's what makes it
publishable and reusable.

---

## 2. The big picture

```
        ┌─────────────────────── HOST (@app/wf-host) ──────────────────────────┐
        │  WfSdkConfig<TDeps> = {                                                │
        │     getModel(modelId, ctx)   → any AI-SDK model (OpenRouter/Venice…)   │
        │     listModels()             → editor dropdown                         │
        │     toolRegistry             → ToolRegistry<TDeps> (legal tools…)      │
        │     buildRunDeps(ctx)        → TDeps  (db, qdrant, tenant scope…)      │
        │     triggers                 → { chat_message: {inputSchema} }         │
        │  }                                                                     │
        └───────────────┬───────────────────────────────────┬───────────────────┘
                        │ injected once                       │ registers bindings
                        ▼                                     ▼
        ┌──────────────────────────────┐      apps/workflows/wrangler.jsonc:
        │   @app/wf-sdk  (generic)      │        workflows:    GRAPH_WORKFLOW
        │                               │        durable_objs: RUN_ROOM
        │   makeGraphWorkflow(config)   │        d1:           DB + migrations_dir
        │           │                   │
        │           ▼                   │
        │   Scheduler (pure walk)       │
        │     │  next() → instruction   │
        │     ▼                         │
        │   step.do(node.id, …)  ───────┼──▶ runNode() ──▶ host model + host tools
        │     │                         │         │
        │     ▼                         │         ▼
        │   durable recorder ───────────┼──▶ wf_run_step  (D1)
        │   RunRoom.append() ───────────┼──▶ live WS/SSE progress
        └──────────────────────────────┘
```

---

## 3. The graph model

A workflow is a directed graph. Two engine-managed bookends (**trigger**,
**output**) wrap the real work nodes. Validated by `workflowGraphSchema` (zod).

```
WF_NODE_KINDS = trigger · agent · tool · judge · branch · feature-request · output

   ┌─────────┐      ┌─────────┐      ┌──────────┐ yes ┌─────────┐      ┌────────┐
   │ trigger │ ───▶ │  agent  │ ───▶ │  judge/  │────▶│  agent  │ ───▶ │ output │
   └─────────┘      └─────────┘      │  branch  │     └─────────┘      └────────┘
   (seeded with         (LLM loop)   └────┬─────┘          ▲
    triggerInput)                         │ no             │
                                          └────────────────┘
                                          (both arms converge on one Output;
                                           the live edge wins)
```

Two node kinds emit a yes/no routing decision and own conditional outgoing edges
(`DECISION_NODE_KINDS = judge · branch`); the scheduler routes them identically.

- **agent** — tool-calling LLM loop (`generateText`) or structured output
  (`generateObject` when `output` is an object/boolean schema). Output: `{ text }`
  or the parsed object.
- **judge** — an LLM decision node: a cheap structured-output model answers a
  plain-English yes/no `testQuestion` against the prior node's output; routes the
  live edge and records `{result, reasoning}`. Passes its _input_ through as output.
- **branch** — a **deterministic** predicate (no LLM): compares a resolved value
  with a `BRANCH_OPERATORS` operator (`equals`, `contains`, `greater_than`,
  `is_empty`, …); routes the live edge. Passes its _input_ through as output.
- **tool** — direct function-tool call; args bound from prior node outputs (`ref`)
  or `literal`s.
- **feature-request** — pass-through placeholder.

Example graph JSON (a minimal chat workflow):

```jsonc
{
  "version": 1,
  "nodes": [
    {
      "id": "t",
      "kind": "trigger",
      "label": "Chat",
      "position": { "x": 0, "y": 0 },
      "config": { "triggerKind": "chat_message" },
    },
    {
      "id": "a",
      "kind": "agent",
      "label": "Assistant",
      "position": { "x": 280, "y": 0 },
      "config": {
        "modelId": "qwen3-5-9b",
        "systemPrompt": "Help ${clientOrgName}.",
        "toolIds": ["search_knowledge_base"],
        "maxSteps": 8,
        "outputSchema": null,
        "stream": true,
      },
    },
    {
      "id": "o",
      "kind": "output",
      "label": "Reply",
      "position": { "x": 560, "y": 0 },
      "config": {},
    },
  ],
  "edges": [
    { "id": "e1", "source": "t", "target": "a", "condition": null },
    { "id": "e2", "source": "a", "target": "o", "condition": null },
  ],
}
```

---

## 4. The Scheduler — the pure heart

`Scheduler` (engine/scheduler.ts) owns the walk and performs **no I/O**. A backend
pulls instructions and feeds results back. This is what lets the in-process
executor and the Cloudflare backend share identical semantics.

```
              ┌──────────── Scheduler ────────────┐
 seedTrigger ─▶│  completed · branchResults ·      │
   (input)    │  nodeOutputs   (in-memory state)   │
              └──────────────┬────────────────────┘
                             │  next()
            ┌────────────────┼────────────────────┐
            ▼                ▼                     ▼
   { type:'execute',  { type:'output',     { type:'stall' }
     node, input }      nodeId, output }     (malformed)
            │                │
   backend runs node   finalize + return
            │
   report(nodeId, { output, branchResult? })  ──▶ back into Scheduler state
```

Interface (engine/scheduler.ts):

```ts
class Scheduler {
  constructor(rawGraph: unknown) // validates via workflowGraphSchema
  readonly trigger: TriggerNode
  seedTrigger(output: unknown): void
  next(): ExecuteInstruction | OutputInstruction | StallInstruction
  report(
    nodeId: string,
    r: { output: unknown; branchResult?: 'yes' | 'no' },
  ): void
  getOutputs(): Map<string, unknown> // for tool arg-ref resolution
}
```

Driver loop (shared shape — executor.ts inline, graph-workflow.ts wrapped in `step.do`):

```ts
scheduler.seedTrigger(validatedTriggerInput)
while (true) {
  const i = scheduler.next()
  if (i.type === 'stall')  throw new WorkflowStalledError()
  if (i.type === 'output') { finalize(i.output); return }
  const r = await runNode(i, ctx)                 // ← host model + tools
  recorder.record({ nodeId: i.node.id, ..., output: r.recordedOutput })
  scheduler.report(i.node.id, { output: r.schedulerOutput, branchResult: r.branchResult })
}
```

`runNode` (engine/run-node.ts) is recorder-free and returns:

```ts
type NodeRunResult = {
  schedulerOutput: unknown // → scheduler.report → downstream input
  recordedOutput: unknown // → wf_run_step.output
  meta?: unknown
  branchResult?: 'yes' | 'no' // branch only
  branchReasoning?: string
}
```

---

## 5. The host-injection contract

`engine/config.ts` — the single object a host supplies. The engine is generic over
an opaque per-run deps bundle `TDeps`; it never inspects it, only threads it into
the host's tools.

```ts
interface WfSdkConfig<TDeps> {
  getModel(modelId: string, ctx: RunContext): LanguageModel // host provider
  listModels(): { id: string; label: string }[] // editor dropdown
  toolRegistry: ToolRegistry<TDeps> // host tools
  buildRunDeps(ctx: RunContext): TDeps | Promise<TDeps>
  triggers: TriggerRegistry // host trigger kinds + schemas
  resolveBlobRef?: (ref: WfBlobRef, deps: TDeps) => Promise<string> // optional; see §5b
}

type RunContext = {
  tenantId: string
  subjectId?: string
  correlationId?: string
  triggerKind: string
  promptVariables?: Record<string, string | undefined>
  env?: unknown // live Cloudflare bindings
}
```

`getModel` and `buildRunDeps` both receive the `RunContext` so they can read live
bindings (an API key, a D1 handle) that only exist **inside** a `step.do`
boundary — never at module load.

The SDK imports no AI provider: `LanguageModel` is the AI SDK's generic type, so a
host on OpenRouter, OpenAI, Venice, etc. just returns the matching AI-SDK model
here. Nothing in `packages/wf-sdk` references a provider by name.

### Example: the `@app/wf-host` config (1121law)

Everything legal-specific lives in the host package, plugged into the generic SDK:

```ts
// packages/wf-host/src/config.ts
import { getModel } from '@app/ai-model' // Venice
import { createSearchKnowledgeBaseTool } from '@app/tools'
import { getClient as getQdrantClient } from '@app/qdrant'
import { createDb } from '@app/db'
import type { WfSdkConfig, ToolRegistry } from '@app/wf-sdk'

// 1121law's private TDeps — what the old ToolRegistryDeps used to be.
type LegalDeps = {
  clientOrgId: string
  userId: string
  db: ReturnType<typeof createDb>
  qdrant: QdrantClient
  veniceApiKey: string
  cloudflare: { token: string; accountId: string }
}

const toolRegistry: ToolRegistry<LegalDeps> = new Map([
  [
    'search_knowledge_base',
    {
      id: 'search_knowledge_base',
      kind: 'ai-tool',
      description: 'Hybrid + reranked passage search across the client corpus.',
      build: (d) =>
        createSearchKnowledgeBaseTool({
          clientOrgId: d.clientOrgId,
          userId: d.userId,
          qdrant: d.qdrant,
          venice: { apiKey: d.veniceApiKey },
          cloudflare: d.cloudflare,
        }),
    },
  ],
  // …get_document, etc.
])

export const wfConfig: WfSdkConfig<LegalDeps> = {
  // ctx.env carries the live Cloudflare bindings inside step.do
  getModel: (modelId, ctx) =>
    getModel((ctx.env as WfHostEnv).VENICE_API_KEY, modelId),
  listModels: () => [{ id: 'qwen3-5-9b', label: 'Qwen3 9B' }],
  toolRegistry,
  triggers: {
    chat_message: {
      description: 'New chat message from a client',
      inputSchema: chatMessageInputSchema,
    },
  },
  buildRunDeps: (ctx) => {
    const env = ctx.env as WfHostEnv // live bindings inside step.do
    return {
      clientOrgId: ctx.correlationId ?? ctx.tenantId,
      userId: ctx.promptVariables?.userId ?? '',
      db: createDb(env.DB),
      qdrant: getQdrantClient({
        url: env.QDRANT_URL,
        apiKey: env.QDRANT_API_KEY,
      }),
      veniceApiKey: env.VENICE_API_KEY,
      cloudflare: {
        token: env.CLOUDFLARE_API_TOKEN,
        accountId: env.CLOUDFLARE_ACCOUNT_ID,
      },
    }
  },
}
```

The `venice`/`veniceApiKey` names above are **1121law's** choice, not the SDK's.
A different host swaps only `getModel` (and its own deps). For example, OpenRouter:

```ts
import { createOpenRouter } from '@openrouter/ai-sdk-provider'

export const wfConfig: WfSdkConfig<MyDeps> = {
  getModel: (modelId, ctx) =>
    createOpenRouter({ apiKey: (ctx.env as MyEnv).OPENROUTER_API_KEY })(
      modelId,
    ),
  listModels: () => [
    { id: 'anthropic/claude-3.5-sonnet', label: 'Claude 3.5 Sonnet' },
  ],
  // toolRegistry / triggers / buildRunDeps: the host's own
}
```

### 5b. Blob refs — spilling values too big to cross a step boundary

Cloudflare Workflows caps the size of a value returned from `step.do`, and the run
recorder persists every node output in full. A node that produces something large
(an OCR'd document, a big search payload) can instead return a **pointer** —
`WfBlobRef` (`engine/blob-ref.ts`) — to bytes it stashed in external storage
(R2/KV/S3). A downstream node rehydrates the pointer to the real value _inside its
own step_, so the large payload never sits at a boundary.

```ts
type WfBlobRef = {
  __wfBlobRef: true
  key: string // opaque storage key the host resolver reads
  bytes?
  chars?
  contentType?
  preview?
  storage? // advisory metadata for traces/UI
}
```

The engine stays provider-agnostic: it only knows the marker _shape_ (`isBlobRef`,
`makeBlobRef`, `rehydrateBlobRefs`) and deep-walks a node's resolved input
replacing any ref. The actual read is the host's injected
`resolveBlobRef(ref, deps)` on `WfSdkConfig` — threaded through `runNode` into
agent/tool nodes. **Omit it and refs pass through untouched.**

This is a **live, wired feature**, not just an interface:

- **Producer:** the built-in `extract_text` tool (`cloudflare/extract-text.ts`)
  spills its extracted text to R2 and returns a `WfBlobRef` once it exceeds
  ~128 KB (`spillThreshold`), keeping a short inline `preview` for traces.
- **Resolver:** the SDK ships `createR2BlobResolver` (`cloudflare/blob-resolver.ts`,
  exported from `@app/wf-sdk/cloudflare`) — point it at the same R2 bucket. A host
  on other storage writes its own `resolveBlobRef`.
- **In 1121law:** the document-ingestion workflow uses both — `wf-host/config.ts`
  registers `extract_text` and sets `resolveBlobRef: createR2BlobResolver(...)`
  against `docsBucket`. A fork with no large-value tools can omit `resolveBlobRef`
  entirely.

---

## 6. Storage — opaque tenancy

`storage/schema.ts`. All tables prefixed `wf_`; identity columns are opaque text
(no foreign keys into host tables), so the schema drops into any D1 database.

```
 wf_workflow ──< wf_workflow_version >── wf_run ──< wf_run_step
     │                  ▲                  ▲              (unique run_id+node_id
 wf_workflow_draft      │              wf_workflow            → idempotent upsert)
 (1:1 editable)    wf_workflow_assignment (tenantId → workflow per triggerKind)

 reusable, float-to-latest, entity + 1:1 draft + immutable versions (same shape):
    wf_agent  ──< wf_agent_version    + wf_agent_draft

 opaque identity:  tenantId   (firmId in 1121law)
                   subjectId  (chatId / documentId)
                   correlationId (free-form host ref → clientOrgId in 1121law)
```

9 tables total. Workflows and agents share one lifecycle shape —
entity + 1:1 editable draft + immutable published versions (agent nodes float to
the latest version via a run manifest frozen at run start).

| table                              | role                                                     |
| ---------------------------------- | -------------------------------------------------------- |
| `wf_workflow`                      | the editable unit a tenant owns                          |
| `wf_workflow_version`              | immutable published graph snapshots (graph JSON)         |
| `wf_workflow_draft`                | 1:1 editable sidecar                                     |
| `wf_agent` / `_version` / `_draft` | reusable agent templates, same lifecycle                 |
| `wf_workflow_assignment`           | trigger kind → workflow, per tenant                      |
| `wf_run`                           | one execution (status/output/timings, `cloudflareRunId`) |
| `wf_run_step`                      | per-node trace — the only engine-written table           |

Data-access (storage/data.ts): `createWorkflow` · `getWorkflow` · `listWorkflows` ·
`updateDraft` · `discardDraft` · `saveVersion` · `listVersions` · `getVersionGraph` ·
`renameWorkflow` · `assignWorkflow` · `resolveAssignedVersion` · `createRun` ·
`setRunManifest` · `markRunRunning` · `finalizeRun` · `failRun` · `listRuns` ·
`listRunTriggerKinds` · `getRun` — plus the agent CRUD
(`createAgent`/`publishAgent`/…) and
`resolveRunManifest` (freezes agent versions for a run).

### Durable recorder — why it's idempotent

`step.do` retries / DO hibernation reset JS memory, so the recorder can't use an
in-memory sequence counter. Instead `sequence` comes from the **deterministic walk
order** (replayed identically every time) and the write upserts on
`(run_id, node_id)`:

```
step.do("step:<nodeId>")  retried  ──▶  INSERT … ON CONFLICT(run_id,node_id) DO UPDATE
                                        → same row updated, never duplicated
```

---

## 7. Cloudflare execution flow

`startGraphRun` (turnkey) → `GraphWorkflow.run` (durable) → `RunRoom` (live).

```
 host route handler
        │  startGraphRun(env, { workflowVersionId, tenantId, triggerKind, triggerInput })
        ▼
 ┌─────────────────────────────────────────────────────────────┐
 │ createRun() → wf_run row (queued)                            │
 │ runId = uuid;  RUN_ROOM.idFromName(runId).init()             │
 │ GRAPH_WORKFLOW.create({ params })                            │
 └───────────────┬─────────────────────────────────────────────┘
                 │ returns { runId, workflowRunId, instanceId }
                 ▼
        client subscribes:  GET /runs/:runId/ws   (RunRoom WebSocket)
                            or poll getRun(workflowRunId)

 ── inside GraphWorkflow.run(event, step) ────────────────────────────────────
   step.do("load-graph")     → getVersionGraph(db, workflowVersionId)
   step.do("begin-run")      → markRunRunning(db, …, cloudflareRunId)
   step.do("room-running")   → RunRoom.setStatus('running')
   new Scheduler(graph); seedTrigger(validated triggerInput)
   loop:
     scheduler.next()
       ├ execute → step.do("step:<id>", opts, async () => {
       │              toolDeps = config.buildRunDeps({ ...runContext, env })
       │              r = await runNode(instruction, { getModel, toolRegistry, toolDeps,
       │                                                nodeOutputs, sink })  // sink → RunRoom
       │              recorder.record({ … output: r.recordedOutput })       // wf_run_step upsert
       │              return r })
       │            scheduler.report(id, { output: r.schedulerOutput, branchResult })
       ├ output  → record + finalizeRun(db) + RunRoom.setOutput()  → return
       └ stall   → throw
   catch → failRun(db) + RunRoom.setError(); rethrow
```

**Determinism invariants:** stable step names = node ids; `sequence` from the walk;
no `Date.now()`/`Math.random()` in the orchestrator; `buildRunDeps`/`getModel`/recorder
built _inside_ each `step.do` (live bindings can't cross the boundary).

### Host wiring (1121law)

```ts
// apps/workflows/src/index.ts
import { seedFirmChatWorkflow, wfConfig, type LegalDeps } from '@app/wf-host'
import {
  makeGraphWorkflow,
  RunRoom as RunRoomImpl,
  startGraphRun,
} from '@app/wf-sdk/cloudflare'

// makeGraphWorkflow is generic over <TDeps, Env> so the class satisfies the
// Sentry wrapper's (env: Env) signature.
export const GraphWorkflow = instrumentWorkflowWithSentry(
  opts,
  makeGraphWorkflow<LegalDeps, Env>(wfConfig),
)
export const RunRoom = instrumentDurableObjectWithSentry(opts, RunRoomImpl)
```

```jsonc
// apps/workflows/wrangler.jsonc
"workflows": [{ "name": "graph-workflow", "binding": "GRAPH_WORKFLOW", "class_name": "GraphWorkflow" }],
"durable_objects": { "bindings": [{ "name": "RUN_ROOM", "class_name": "RunRoom" }] },
"d1_databases": [{ "binding": "DB", "migrations_dir": "../../packages/wf-sdk/migrations" }]
```

`RunRoom` RPC surface (cloudflare/run-room.ts): `init` · `append(channel,text)` ·
`setStatus` · `setOutput` · `setError` · `getState`. Browsers connect via the
WebSocket hibernation API and get a `snapshot` on connect.

---

## 8. Server — the RPC data layer

`server/` is the framework-agnostic bridge between the UI and storage. The whole
data surface is one interface, `WfDataClient` (server/protocol.ts): list/create
workflows, load a workflow + draft, save draft, save/list/get versions, rename,
discard draft, the agent CRUD, list/get runs, and the editor
catalogs (list models, tools, trigger events).

```
 UI hooks ──▶ createHttpWfDataClient({ baseUrl }) ── one POST route, { method, params } ──▶
                                                                                        │
 host route (e.g. apps/web/app/api/wf/route.ts):                                        ▼
   createWfSdkHandlers({ config, resolveDb, resolveContext })
      │  resolveContext(req) → { tenantId }   ← host auth (better-auth + firm scope)
      │  resolveDb(req)      → WfDb           ← host D1 handle
      ▼
   every call is tenant-scoped; dispatch → storage/data.ts
```

- **`createWfSdkHandlers(opts)`** — server dispatcher. `opts.config` is
  `Pick<WfSdkConfig, 'listModels' | 'toolRegistry'>` (so the editor can list
  models/tools); `resolveContext` supplies the `{ tenantId }` scope from host auth;
  `resolveDb` supplies the `WfDb`. Returns a `(req) => Response` you mount on any
  route.
- **`createHttpWfDataClient({ baseUrl })`** — the browser-side `WfDataClient` that
  POSTs to that route. This is what `WfSdkProvider` is given.

In 1121law: `apps/web/app/api/wf/route.ts` mounts the handlers, deriving tenant
scope from the better-auth session + `resolveViewing` (firm). `apps/workflows`
exposes the run-start path over its Workers RPC (`WorkflowsService.startGraphRun`
→ `POST /graph-runs`).

---

## 9. UI — editor + run-viewer

`ui/` is React (DOM+JSX, separate tsconfig). It ships **behavior**, not chrome:
Button/Badge/Input/Label/Textarea are **injected** through `WfSdkProvider` so the
host's design system renders everything. Data flows through a `WfDataClient` (the
HTTP one in production, a mock one in tests).

```
 <WfSdkProvider client={createHttpWfDataClient({ baseUrl: '/api/wf' })} components={hostPrimitives}>
    <WfApp basePath="/wf" path={path} navigate={navigate} />  ← the whole surface, one component
    {/* or mount pieces directly: */}
    <WorkflowEditor workflowId={id} />      ← canvas · palette · inspector
    <RunViewer runId={workflowRunId} />     ← status + per-step trace
 </WfSdkProvider>
```

- **`WfApp`** — the entire router-agnostic surface behind one component: hub,
  workflows list + editor, agents list + editor, runs
  explorer + run page. Host injects `basePath` / `path` / `navigate` (nav seam,
  `ui/nav.tsx` — the SDK never imports a router).
- **`WorkflowEditor`** — `@xyflow/react` canvas + node palette + node inspector.
  Rename (editable title), undo/redo (client history stack), a **version-history**
  dropdown (loads a published version into the canvas), save-draft, publish.
- **`AgentEditor`** — a Tiptap-backed editor for the reusable agent entity
  (draft → publish, version history), same lifecycle as workflows.
- **`RunViewer`** — a single run and its `wf_run_step` trace; live progress when a
  RunRoom socket is available, otherwise polls `getRun`.
- **hooks** (react-query over `WfDataClient`): `useWorkflows`, `useWorkflow`,
  `useCreateWorkflow`, `useSaveDraft`, `useSaveVersion`, `useVersions`,
  `useRenameWorkflow`, `useRuns`, `useRun`, `useRunTriggerKinds`, `useModels`,
  `useTools`, `useTriggerEvents`, `useSummarizeChanges`, plus the agent
  hooks (`useAgents`/`useAgent`/`usePublishAgent`/…).

In 1121law: mounted at a catch-all `/wf/[[...slug]]` route (hub + workflows +
agents + runs) via `apps/web/components/wf/provider.tsx`; chat's
"Inspect thinking" wraps `RunViewer` in `apps/web/components/wf/run-sheet.tsx`.

---

## 10. Eval / testing

`eval/index.ts` runs a graph through the in-process executor with a mock model +
mock tools + in-memory recorder — no DB, no Cloudflare:

```ts
import { runWorkflowUnderConditions } from '@app/wf-sdk/eval'
import { MockLanguageModelV3 } from 'ai/test'

const run = await runWorkflowUnderConditions({
  name: 'routes to yes arm',
  graph: myGraph,
  triggerInput: { chatId: 'c1', userText: 'hello', messages: [] },
  config: {
    getModel: () =>
      new MockLanguageModelV3({ doGenerate: async () => ({ text: 'hi' }) }),
    listModels: () => [],
    toolRegistry: new Map(),
    triggers: {
      chat_message: { description: '', inputSchema: chatInputSchema },
    },
    buildRunDeps: () => ({}),
  },
})

expect(run.output).toEqual({ text: 'hi' })
expect(run.steps.map((s) => s.nodeKind)).toEqual(['trigger', 'agent', 'output'])
expect(run.progress).toContainEqual({ channel: 'progress', text: 'hi' })
```

---

## 11. End-to-end: a chat turn in 1121law

```
client sends message
   │
   ▼  POST /api/chat   (host route handler)
resolveAssignedVersion(db, { tenantId: firmId, triggerKind: 'chat_message' })
   │   (auto-seeds the firm's wf_* chat workflow on first message)
   ▼
startGraphRun(env, { workflowVersionId, tenantId: firmId,
                     triggerKind: 'chat_message', triggerInput,
                     subjectId: chatId, correlationId: clientOrgId })
   │  returns { runId, workflowRunId, instanceId }
   ▼
chat route polls wf_run for the final text and bridges it into the same
UIMessage stream the client already renders (post-turn work unchanged)
   │
   ▼  (background, durable)
GraphWorkflow walks: trigger → agent(search_knowledge_base loop) → output
   │   each node: step.do → host model (Venice) + legal tools → wf_run_step upsert
   │   agent step text → RunRoom.append('progress', …)  → live to client
   ▼
output node → finalizeRun(wf_run) + RunRoom.setOutput(assistantText)
   │
   ▼
client renders final reply; "Inspect thinking" opens the SDK RunViewer keyed by
message meta's workflowRunId (= wf_run.id) for the full trace
```

---

## Status

**Cutover complete (2026-07-01); grown since — 9 `wf_*` tables (3 migrations),
7 node kinds.** Layers built & consumed in 1121law: engine · storage · cloudflare ·
server · ui · eval · tools.

- **Live in 1121law:** chat runs on `GraphWorkflow` by default (no feature flag),
  auto-seeding the firm's `wf_*` chat workflow on first message; verified
  end-to-end (real `wf_run` + `wf_run_step` rows, host-model answer). `/workflows`
  is replaced by `/wf` (hub + editor + runs + run-viewer). **`packages/workflow-engine`
  is deleted.**
- **Landed since cutover:** the LLM **`judge`** decision node;
  **Agents** as reusable float-to-latest entities (editor + storage + run manifest);
  a **document-ingestion** workflow + the `extract_text` (R2/Vision OCR) tool; and
  the **blob-ref** mechanism (`WfBlobRef` + `resolveBlobRef` + `createR2BlobResolver`)
  for spilling oversized node outputs to R2 — live end-to-end in ingestion (see §5b).
- **Remote ops:** set `CLOUDFLARE_*` wrangler secrets on `law-workflows`, run the
  remote `wf_*` migration (`bun --cwd packages/wf-sdk run db:migrate`), seed firms.

See `plan.md` for the full plan and `wf-TODO.md` for the next wave.
