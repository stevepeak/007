# Integrating `@app/wf-sdk` into a new project

This guide is the practical companion to `README.md` (which explains how the SDK
works internally). Here we cover **what a host project must supply** to stand the
SDK up end-to-end: the injection config, the D1 storage, the Cloudflare runtime,
the data API route, and the React UI — plus the parts you must **de-hardcode**
before reusing the package in a different repo.

Everything here is derived from the live wiring in this repo (`@app/wf-host`,
`apps/web`, `apps/workflows`). Treat those as the reference implementation.

---

## 0. What the SDK owns vs. what you inject

The SDK is deliberately generic. It ships **behavior**; the host supplies
**identity, provider, tools, storage handle, and design system**.

| Concern                                                          | Owned by the SDK  | Injected by the host                      |
| ---------------------------------------------------------------- | ----------------- | ----------------------------------------- |
| Graph model + validation (zod)                                   | ✅                |                                           |
| Execution engine (scheduler, nodes)                              | ✅                |                                           |
| `wf_*` D1 schema + migrations + data access                      | ✅                | the D1 binding + when to migrate          |
| Reusable Agents (float-to-latest entities + versions)            | ✅                |                                           |
| Cloudflare runtime (`GraphWorkflow`, `RunRoom`, `startGraphRun`) | ✅                | wrangler bindings                         |
| RPC dispatch (`createWfSdkHandlers`)                             | ✅                | auth → `{ tenantId, userId }`, the `WfDb` |
| Editor / run-viewer / hub UI (`WfApp`)                           | ✅                | router adapter, design-system primitives  |
| Model provider (`getModel`)                                      |                   | ✅                                        |
| Tools (`toolRegistry`; `/tools` + `/cloudflare` ship a few)      |                   | ✅                                        |
| Event catalog + input schemas (`triggers`)                       |                   | ✅ (manual/periodic built in)             |
| Per-run deps (`buildRunDeps`)                                    |                   | ✅                                        |
| Blob-ref resolver (`resolveBlobRef`, optional)                   | marker shape only | ✅ if a tool spills large values          |
| Tenant / subject / correlation identity                          |                   | ✅ (opaque text)                          |

The one object that carries most of the injection is `WfSdkConfig<TDeps>`
(`src/engine/config.ts`). `TDeps` is your private per-run bundle — the SDK never
inspects it, it only threads it into your tools.

### Subpath entry points

Import only the layer you need; the dependency direction is one-way with no
cycles (`ui → server → storage → engine`, `cloudflare → storage → engine`).

| Import                                | Runtime                 | Use it in                                       |
| ------------------------------------- | ----------------------- | ----------------------------------------------- |
| `@app/wf-sdk`                         | any                     | barrel: engine + storage + eval                 |
| `@app/wf-sdk/engine`                  | any (only `ai` + `zod`) | custom backends, graph types                    |
| `@app/wf-sdk/storage`                 | Workers (D1)            | `createWfDb`, data access, schema               |
| `@app/wf-sdk/storage/schema`          | build-time              | drizzle-kit / migrations                        |
| `@app/wf-sdk/cloudflare`              | Workers only            | `makeGraphWorkflow`, `RunRoom`, `startGraphRun` |
| `@app/wf-sdk/cloudflare/extract-text` | Workers only            | `createExtractTextTool` (R2/Vision OCR tool)    |
| `@app/wf-sdk/server`                  | any server route        | `createWfSdkHandlers`, `createHttpWfDataClient` |
| `@app/wf-sdk/tools`                   | any (fetch + deps)      | built-in tools (`createTavilyTool`)             |
| `@app/wf-sdk/ui`                      | browser (React 19)      | `WfApp`, `WfSdkProvider`, `RunViewer`, hooks    |
| `@app/wf-sdk/eval`                    | test                    | `runWorkflowUnderConditions`                    |

---

## 1. Prerequisites

The SDK assumes a **Cloudflare + React 19** host:

- **Cloudflare Workers** with three product bindings: **D1** (SQL storage),
  **Workflows** (durable graph execution), and a **Durable Object** (live run
  progress via `RunRoom`).
- **React 19** (`peerDependencies`) for the UI, and **Tailwind CSS** in the host
  — the SDK's own layout markup and the default primitives use Tailwind utility
  classes. Without Tailwind the UI renders unstyled.
- **`@xyflow/react`** styles for the editor canvas, imported once by the host.
- A package manager that understands the dependency versions. This repo uses the
  **bun/pnpm workspace `catalog:` protocol** for `ai`, `zod`, `drizzle-orm`,
  `@tanstack/react-query`, `@types/node`. Outside this monorepo you must pin real
  versions (see §10).

---

## 2. Step 1 — write the host config (`WfSdkConfig`)

Create a small host package (this repo's is `@app/wf-host`) that exports one
`WfSdkConfig<TDeps>` object. It is imported by **both** the web app (for the
editor's model/tool lists) and the workflows Worker (to actually run nodes).

```ts
// your-host/src/config.ts
import type { WfSdkConfig, ToolRegistry } from '@app/wf-sdk'
import { z } from 'zod'

// (a) The live Cloudflare bindings you read out of RunContext.env at run time.
//     RunContext.env is `unknown` to the SDK — you own its type and the cast.
export type HostEnv = {
  DB: D1Database
  MODEL_API_KEY: string
  // …whatever your tools need
}

// (b) Your private per-run deps. Whatever your tools consume.
export type HostDeps = {
  tenantId: string
  userId: string
  db: ReturnType<typeof createDb>
  // …clients your tools need
}

// (c) Event input schema(s). One per *event* you declare. These are the
// "on an event" options in the create-workflow flow; the built-in `manual`
// and `periodic` trigger modes need no entry here. The schema doubles as the
// wire description of "what data this event provides" (reflected into a field
// list the creation dialog renders).
export const chatMessageInputSchema = z.object({
  chatId: z.string(),
  userText: z.string(),
  messages: z.array(z.any()),
})
export const documentIngestedInputSchema = z.object({
  documentId: z.string(),
  name: z.string(),
})

// (d) Your tools, generic over HostDeps. `build(deps)` returns an AI SDK tool.
const toolRegistry: ToolRegistry<HostDeps> = new Map([
  [
    'search_knowledge_base',
    {
      id: 'search_knowledge_base',
      kind: 'ai-tool',
      description: 'Search the corpus.',
      build: (d) => createSearchTool({ tenantId: d.tenantId /* … */ }),
    },
  ],
])

export const wfConfig: WfSdkConfig<HostDeps> = {
  // getModel + buildRunDeps receive RunContext so they can read live bindings
  // that only exist INSIDE a step.do boundary (never at module load).
  getModel: (modelId, ctx) =>
    getModel((ctx.env as HostEnv).MODEL_API_KEY, modelId),
  listModels: () => [{ id: 'model-a', label: 'Model A' }],
  toolRegistry,
  // Your event catalog. Every key is an "on an event" trigger option; the
  // built-in `manual` / `periodic` modes are always available on top of these.
  triggers: {
    chat_message: {
      description: 'New chat message',
      inputSchema: chatMessageInputSchema,
    },
    document_ingested: {
      description: 'A document finished ingesting',
      inputSchema: documentIngestedInputSchema,
    },
  },
  buildRunDeps: (ctx) => {
    const env = ctx.env as HostEnv
    return {
      tenantId: ctx.tenantId,
      userId: ctx.promptVariables?.userId ?? '',
      db: createDb(env.DB),
    }
  },
}
```

Key rules:

- **`getModel` returns an AI SDK `LanguageModel`.** Any provider works (`ai`
  package). It receives `RunContext`, so read your API key from `ctx.env`.
- **Never construct clients at module scope.** `buildRunDeps` and `getModel` run
  _inside_ each `step.do`, where live bindings exist. Do the work there.
- **`toolRegistry` is a `Map<string, ToolRegistryEntry<TDeps>>`.** Each entry's
  `build(deps)` is called per-run with your `TDeps`.
- **`resolveBlobRef` is optional.** Supply it only if a tool returns a `WfBlobRef`
  pointer instead of a large value (the built-in `extract_text` tool does when its
  output exceeds ~128 KB); it reads the pointer back to text inside the consuming
  node's step. Omit it and refs pass through as-is. For R2 the SDK ships
  `createR2BlobResolver` (`@app/wf-sdk/cloudflare`) — point it at the same bucket;
  other storage needs your own resolver.
- The UI needs `listModels` + `toolRegistry` (editor dropdowns) and `triggers`
  (the create-workflow event picker + its data-field preview); the runtime needs
  `getModel` + `toolRegistry` + `buildRunDeps` + `triggers` (and `resolveBlobRef`
  if you use blob spilling).

**Trigger modes.** A workflow declares how it starts on its trigger node
(`config.triggerKind`). Three modes exist:

- `manual` — a person starts each run. Built in; no registry entry.
- `periodic` — a cron schedule starts it (`config.cron`). Built in; no entry.
- an **event** kind — one of your `triggers` keys above; the engine validates the
  run's `triggerInput` against that event's `inputSchema`.

The create-workflow dialog (`WorkflowsList` → **New workflow**) offers all three
and, for events, lists the fields reflected from each `inputSchema`. Only events
live in your config; `manual`/`periodic` are SDK constants
(`MANUAL_TRIGGER_KIND`, `PERIODIC_TRIGGER_KIND`).

### Seed helper (optional but recommended)

To auto-provision a tenant's first workflow, ship a seed that assigns a template
graph to a trigger kind, using SDK storage primitives:

```ts
import {
  resolveAssignedVersion,
  createWorkflow,
  assignWorkflow,
  type WfDb,
} from '@app/wf-sdk'

export async function seedChatWorkflow(
  db: WfDb,
  { tenantId }: { tenantId: string },
) {
  const existing = await resolveAssignedVersion(db, {
    tenantId,
    triggerKind: 'chat_message',
  })
  if (existing) return existing
  const { workflowId, versionId } = await createWorkflow(db, {
    tenantId,
    name: 'Chat',
    graph: CHAT_TEMPLATE, // a valid WorkflowGraph
  })
  await assignWorkflow(db, {
    tenantId,
    triggerKind: 'chat_message',
    workflowId,
  })
  return { workflowId, versionId }
}
```

The template graph is plain JSON validated by `workflowGraphSchema`; see the
README §3 for the node shapes (`trigger → agent → output`).

---

## 3. Step 2 — storage & D1 migrations

The SDK owns nine `wf_*` tables (`src/storage/schema.ts`): `wf_workflow`,
`wf_workflow_version`, `wf_workflow_draft`, `wf_agent`, `wf_agent_version`,
`wf_agent_draft`, `wf_workflow_assignment`, `wf_run`, `wf_run_step`. Workflows and
agents share one lifecycle shape (entity + 1:1 editable draft + immutable published
versions). They use **opaque text identity** (no foreign keys into your tables),
so they coexist with any host schema in the same D1.

The generated SQL lives in this repo's `migrations/` dir. **Applying it is the
host's job** — this repo's CI only validates (lint/typecheck/test) and never
touches a database, so a host's Cloudflare secrets never live here. The
committed `wrangler.jsonc` carries generic placeholders precisely so no specific
host's IDs are stored in this (potentially public, multi-consumer) repo. Two host
options:

1. **A host-owned migration config + CI step (recommended).** In your (private)
   host repo, add a small wrangler config that binds your D1 with real IDs and
   points `migrations_dir` at this repo's `migrations/`, then apply it from the
   host's CI with the host's own secrets:

   ```jsonc
   // host repo, e.g. packages/wf-host/wrangler.jsonc — migrations_dir is relative
   // to this file (submodule mounted at ../wf-sdk)
   "account_id": "<your-account-id>",
   "d1_databases": [{
     "binding": "DB",
     "database_name": "your-db",
     "database_id": "<your-db-id>",
     "migrations_dir": "../wf-sdk/migrations"
   }]
   ```

   ```yaml
   # host CI (secrets belong to the HOST repo, not this one)
   - uses: cloudflare/wrangler-action@v3
     with:
       apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
       accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
       workingDirectory: packages/wf-host
       command: d1 migrations apply your-db --remote
   ```

2. **Apply manually** against the target D1 via this package's own scripts
   (`db:migrate:local` for local D1; `db:migrate` for `--remote` — fill the
   `wrangler.jsonc` placeholders with real IDs first, or pass a host config).

> ⚠️ **Gotcha (shared D1):** a host that keeps its own migrations dir (e.g.
> 1121law points `apps/*` at `packages/db/migrations` for its _own_ schema) cannot
> put two `migrations_dir` on one binding — the `wf_*` migrations must be applied
> as a **separate** step (a second config/step, as in option 1). Both dirs share
> the target D1's default `d1_migrations` tracking table with distinct filenames,
> so they coexist without collision.

Get a `WfDb` handle from a D1 binding inside the request/step path:

```ts
import { createWfDb } from '@app/wf-sdk/storage'
const db = createWfDb(env.DB) // never at module load — DB is a request binding
```

To regenerate migrations after a schema bump: `bun --cwd packages/wf-sdk run
db:generate` (drizzle-kit; needs no credentials).

---

## 4. Step 3 — the workflows Worker (Cloudflare runtime)

In a Worker, build the durable graph interpreter from your config and export it
plus the `RunRoom` DO:

```ts
// apps/workflows/src/index.ts (or your equivalent)
import { wfConfig, type HostDeps } from 'your-host'
import {
  makeGraphWorkflow,
  RunRoom as RunRoomImpl,
  startGraphRun,
} from '@app/wf-sdk/cloudflare'

// makeGraphWorkflow is generic over <TDeps, Env> so it satisfies any wrapper's
// (env: Env) signature (e.g. a Sentry instrumenter).
export const GraphWorkflow = makeGraphWorkflow<HostDeps, Env>(wfConfig)
export const RunRoom = RunRoomImpl

// Expose a way to start runs — RPC (WorkerEntrypoint) and/or an HTTP route.
export default {
  async fetch(req: Request, env: Env) {
    if (req.method === 'POST' && new URL(req.url).pathname === '/graph-runs') {
      const input = await req.json()
      return Response.json(await startGraphRun(env, input))
    }
    // GET /runs/:id/ws, /runs/:id/stream are served from the RUN_ROOM DO
  },
}
```

`startGraphRun(env, input)` (`src/cloudflare/start-run.ts`) requires these exact
binding names on `env`:

```ts
interface GraphRunBindings {
  DB: D1Database
  RUN_ROOM: DurableObjectNamespace<RunRoom>
  GRAPH_WORKFLOW: Workflow<GraphWorkflowParams>
}
```

Its input:

```ts
type StartGraphRunInput = {
  workflowVersionId: string
  tenantId: string
  triggerKind: string
  triggerInput: unknown // validated against your trigger's inputSchema
  subjectId?: string
  correlationId?: string
  promptVariables?: Record<string, string | undefined>
  label?: string
}
// returns { runId, workflowRunId, instanceId }
```

`workflowRunId` is the `wf_run.id` — poll it via `getRun`, or key the UI's
`RunViewer` on it. `runId` is the `RunRoom` address for live WebSocket/SSE.

### wrangler bindings

```jsonc
// apps/workflows/wrangler.jsonc
{
  "workflows": [
    {
      "name": "graph-workflow",
      "binding": "GRAPH_WORKFLOW",
      "class_name": "GraphWorkflow",
    },
  ],
  "durable_objects": {
    "bindings": [{ "name": "RUN_ROOM", "class_name": "RunRoom" }],
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["RunRoom"] }],
  "d1_databases": [
    { "binding": "DB", "database_name": "your-db", "database_id": "…" },
  ],
}
```

If your web Worker starts runs, add a **service binding** from web → workflows
(this repo calls it `WORKFLOWS`) and call `startGraphRun` over RPC, falling back
to `POST /graph-runs` in local dev.

---

## 5. Step 4 — the data API route (editor/run-viewer backend)

Mount **one POST route** that the UI talks to. `createWfSdkHandlers` dispatches
every `WfDataClient` method; you supply the D1 handle and the authenticated
tenant scope. The SDK stays auth-free — identity is resolved server-side and
never trusted from the client.

```ts
// apps/web/app/api/wf/route.ts
import { createWfSdkHandlers } from '@app/wf-sdk/server'
import { createWfDb } from '@app/wf-sdk/storage'
import { wfConfig } from 'your-host'

export const POST = createWfSdkHandlers({
  // Uses listModels + toolRegistry (editor dropdowns) + triggers (the
  // create-workflow event picker). Passing the whole wfConfig is fine.
  config: wfConfig,
  resolveDb: (req) => createWfDb(getEnv().DB),
  resolveContext: async (req) => {
    const session = await getSession(req.headers) // your auth
    if (!session) throw new Error('Unauthorized')
    const tenantId = await resolveTenant(req, session) // your tenancy
    return { tenantId, userId: session.user.id }
  },
  // Optional: AI-generated changelog for the publish dialog. Omit → heuristic
  // structural summary. Use wfConfig.getModel to stay within the injection contract.
  summarizeChanges: async ({ previousGraph, nextGraph, ctx }) => {
    /* generate a one-line note; race an 8s timeout against a fallback */
    return 'Updated workflow.'
  },
})
```

- **`resolveContext` → `{ tenantId, userId? }`** is the security boundary. Every
  handler scopes reads and authorizes mutations by `tenantId`; a workflow owned
  by another tenant returns `null`.
- **`resolveDb` → `WfDb`** per request.
- The wire protocol is `{ method, params }` over POST; the full method set is the
  `WfDataClient` interface in `src/server/protocol.ts`.

---

## 6. Step 5 — the UI

The UI is React (separate `tsconfig.ui.json`, DOM+JSX). It ships behavior, not
chrome: a router adapter and design-system primitives are injected.

### Provider

```tsx
// components/wf/provider.tsx
'use client'
import { createHttpWfDataClient, WfSdkProvider } from '@app/wf-sdk/ui'
import { useState } from 'react'

export function WfProvider({ children }) {
  const [client] = useState(() =>
    createHttpWfDataClient({ baseUrl: '/api/wf' }),
  )
  return (
    <WfSdkProvider
      client={client}
      components={{ Button, Badge, Input, Label, Textarea }} // your design system (optional)
    >
      {children}
    </WfSdkProvider>
  )
}
```

- `client` is the browser-side `WfDataClient` pointed at your route (§5).
- `components` overrides the five injectable primitives (`Button`, `Badge`,
  `Input`, `Label`, `Textarea`). Omit to use the SDK's neutral Tailwind defaults.
- Brings its own React Query client unless you pass `queryClient`.

### The whole interface behind one component

`WfApp` owns all internal routing (hub, workflows list, editor, runs explorer,
run page). Mount it at a **catch-all route** and inject location +
navigate from your router:

```tsx
// app/(app)/wf/[[...slug]]/page.tsx
'use client'
import { WfApp } from '@app/wf-sdk/ui'
import { usePathname, useRouter } from 'next/navigation'
import { WfProvider } from '@/components/wf/provider'

const BASE_PATH = '/wf'

export default function WfPage() {
  const pathname = usePathname()
  const router = useRouter()
  const path = pathname.replace(BASE_PATH, '').replace(/^\//, '')
  return (
    <WfProvider>
      <div className="h-[calc(100vh-3.5rem)]">
        <WfApp
          basePath={BASE_PATH}
          path={path}
          navigate={(to) => router.push(to ? `${BASE_PATH}/${to}` : BASE_PATH)}
        />
      </div>
    </WfProvider>
  )
}
```

The nav seam (`src/ui/nav.tsx`) is router-agnostic: the SDK never imports a
router. All internal links are relative to `basePath`; `navigate` receives a
path relative to `basePath`.

### Embedding just the run viewer

To surface a single run's trace elsewhere (e.g. a chat's "inspect thinking"),
render `RunViewer` inside the same provider, keyed on the `workflowRunId`
(= `wf_run.id`) returned by `startGraphRun`:

```tsx
import { RunViewer } from '@app/wf-sdk/ui'
;<WfProvider>
  <RunViewer runId={workflowRunId} />
</WfProvider>
```

`RunViewer` streams live progress when a `RunRoom` socket is available, otherwise
polls `getRun`.

### Styling setup

- Ensure **Tailwind** scans the SDK's files (add
  `./node_modules/@app/wf-sdk/src/**/*.{ts,tsx}` to your Tailwind `content`, or
  the workspace path in a monorepo).
- Import **`@xyflow/react`** CSS once (for the editor canvas).
- The agent editor's prompt body uses **Tiptap**; its CSS comes with the components.

---

## 7. Step 6 — trigger a run from a feature

The end-to-end pattern (this repo's chat route): resolve the tenant's assigned
workflow (seeding on first use), then start a run.

```ts
import { resolveAssignedVersion } from '@app/wf-sdk'
import { createWfDb } from '@app/wf-sdk/storage'
import { seedChatWorkflow } from 'your-host'

const db = createWfDb(env.DB)
let assigned = await resolveAssignedVersion(db, {
  tenantId,
  triggerKind: 'chat_message',
})
if (!assigned) {
  await seedChatWorkflow(db, { tenantId })
  assigned = await resolveAssignedVersion(db, {
    tenantId,
    triggerKind: 'chat_message',
  })
}

const run = await workflowsClient.startGraphRun({
  workflowVersionId: assigned.versionId,
  tenantId,
  triggerKind: 'chat_message',
  triggerInput: { chatId, userText, messages }, // matches your inputSchema
  subjectId: chatId,
  correlationId: orgId,
  promptVariables: { userId },
})
// run.workflowRunId → poll getRun / key RunViewer
```

---

## 8. The identity model (get this right)

The SDK's identity columns are **opaque text**. You choose what maps to what;
`buildRunDeps` reads back what `startGraphRun` put in. Keep the mapping
consistent across the two.

| SDK field         | Meaning                                                              | Example in this repo        |
| ----------------- | -------------------------------------------------------------------- | --------------------------- |
| `tenantId`        | ownership / scope (all queries filtered by it)                       | `firmId`                    |
| `subjectId`       | the host entity a run is about                                       | `chatId`                    |
| `correlationId`   | free-form host reference                                             | `clientOrgId`               |
| `promptVariables` | `${name}` interpolation in agent system prompts + arbitrary run vars | `{ userId, clientOrgName }` |

`RunContext.env` carries your live bindings through the `step.do` boundary; it is
`unknown` to the SDK and you cast it in `getModel` / `buildRunDeps`.

---

## 9. Testing without Cloudflare

`@app/wf-sdk/eval` runs a graph through the in-process executor with a mock model
and mock tools — no D1, no Workers:

```ts
import { runWorkflowUnderConditions } from '@app/wf-sdk/eval'
import { MockLanguageModelV3 } from 'ai/test'

const run = await runWorkflowUnderConditions({
  name: 'happy path',
  graph: myGraph,
  triggerInput: { chatId: 'c1', userText: 'hi', messages: [] },
  config: {
    getModel: () =>
      new MockLanguageModelV3({ doGenerate: async () => ({ text: 'hi' }) }),
    listModels: () => [],
    toolRegistry: new Map(),
    triggers: {
      chat_message: { description: '', inputSchema: chatMessageInputSchema },
    },
    buildRunDeps: () => ({}),
  },
})

expect(run.output).toEqual({ text: 'hi' })
expect(run.steps.map((s) => s.nodeKind)).toEqual(['trigger', 'agent', 'output'])
```

---

## 10. Portability — de-hardcode before extracting

The package is _architecturally_ independent (engine depends only on `ai` +
`zod`; identity/provider/tools/UI-chrome are all injected). But a few things are
still wired to **this** monorepo and must be changed when you lift it into a new
project:

1. **Package scope `@app/wf-sdk`.** Rename the package + all subpath imports for
   your scope, or keep `@app/*` and add it to your workspace.
2. **`catalog:` dependency versions.** `package.json` uses the workspace catalog
   for `ai`, `zod`, `drizzle-orm`, `@tanstack/react-query`, `@types/node`. Pin
   real semver versions if you're not in a bun/pnpm catalog workspace.
3. **Build-config workspace deps.** `tsconfig` (`tsconfig/bun.json`) and
   `@law/eslint-config` are workspace packages. Inline or replace them.
4. **`wrangler.jsonc` in the package is dev/migration-only and generic.** It
   carries **placeholders** (`<CLOUDFLARE_ACCOUNT_ID>`, `<D1_DATABASE_NAME>`,
   `<D1_DATABASE_ID>`) — no host's real IDs are committed. It is _not_ a deployed
   Worker; it only lets a manual `wrangler d1 migrations apply` run against
   `./migrations` once you fill the placeholders. This repo's CI never applies
   migrations — that's the host's job (see §3).
5. **Migrations wiring.** Decide up front how `wf_*` migrations reach your D1: a
   host-owned config + CI step pointing at this repo's `migrations/` (§3 option 1),
   or a manual step (§3 option 2). Keep the host's Cloudflare secrets in the host
   repo — never here.
6. **Tailwind + React 19.** Hard requirements for the UI. The SDK's markup uses
   Tailwind utility classes directly, so Tailwind must scan the package's files.
7. **`RunContext.env` is untyped (`unknown`).** You own the `HostEnv` type and the
   casts in `getModel` / `buildRunDeps`. Keep them in your host package.
8. **The `extract_text` tool (`/cloudflare/extract-text`) is heavy and optional.**
   It pulls `@cloudflare/puppeteer` and expects an R2 bucket + a Workers AI vision
   binding (`getBucket` / `getAI`) for OCR. Register it only if you ingest
   documents; a fork that doesn't can ignore the subpath (the dependency still
   installs). Because it spills large output to R2 as a `WfBlobRef`, pair it with a
   `resolveBlobRef` (see next).
9. **Blob-ref (`resolveBlobRef` / `WfBlobRef`) is a live, R2-backed feature.** The
   engine plumbing is complete _and_ used: `extract_text` produces refs and the SDK
   ships `createR2BlobResolver` (`@app/wf-sdk/cloudflare`) to read them back. If you
   register `extract_text` (or any ref-producing tool), also set
   `config.resolveBlobRef` — point `createR2BlobResolver` at the same R2 bucket, or
   write your own resolver for non-R2 storage. Tools with no large outputs can leave
   it unset.

Once those are addressed, dropping the SDK into a new Cloudflare + React 19
project is: write a `WfSdkConfig`, mount one API route, mount `WfApp`, export
`GraphWorkflow` + `RunRoom`, add the D1/Workflow/DO bindings, and apply the
`wf_*` migrations.

---

## Reference: the reference implementation in this repo

| Piece                       | File                                             |
| --------------------------- | ------------------------------------------------ |
| Host config (`WfSdkConfig`) | `packages/wf-host/src/config.ts`                 |
| Seed helper + template      | `packages/wf-host/src/{seed,template}.ts`        |
| Data API route              | `apps/web/app/api/wf/route.ts`                   |
| UI provider                 | `apps/web/components/wf/provider.tsx`            |
| UI mount (catch-all)        | `apps/web/app/(app)/wf/[[...slug]]/page.tsx`     |
| Run viewer embed            | `apps/web/components/wf/run-sheet.tsx`           |
| Workflows Worker            | `apps/workflows/src/index.ts` + `wrangler.jsonc` |
| Chat consumer               | `apps/web/app/api/chat/route.ts`                 |

</content>
</invoke>
