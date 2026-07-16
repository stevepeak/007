# Integrating `@stevepeak/007` into a new project

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
| `@stevepeak/007`                         | any                     | barrel: engine + storage + eval                 |
| `@stevepeak/007/engine`                  | any (only `ai` + `zod`) | custom backends, graph types                    |
| `@stevepeak/007/storage`                 | Workers (D1)            | `createWfDb`, data access, schema               |
| `@stevepeak/007/storage/schema`          | build-time              | drizzle-kit / migrations                        |
| `@stevepeak/007/cloudflare`              | any server route²       | `startGraphRun`, `createHttpGraphRunClient`, `createR2BlobResolver`, `createExtractTextTool` |
| `@stevepeak/007/cloudflare/runtime`      | Workers **only**        | `makeGraphWorkflow`, `RunRoom` (durable classes — import `cloudflare:workers`) |
| `@stevepeak/007/cloudflare/blob-resolver`| any server route        | `createR2BlobResolver` (engine-only leaf)       |
| `@stevepeak/007/cloudflare/extract-text` | any server route¹       | `createExtractTextTool` (R2/Vision OCR tool)    |
| `@stevepeak/007/server`                  | any server route        | `createWfSdkHandlers`, `createHttpWfDataClient` |
| `@stevepeak/007/tools`                   | any (fetch + deps)      | built-in tools (`createTavilyTool`)             |
| `@stevepeak/007/ui`                      | browser (React 19)      | `WfApp`, `WfSdkProvider`, `RunViewer`, hooks    |
| `@stevepeak/007/ui/styles.css`           | host CSS (Tailwind v4)  | `@import` once — emits the SDK's utilities + xyflow CSS (§6) |
| `@stevepeak/007/eval`                    | test                    | `runWorkflowUnderConditions`                    |

¹ Import-safe anywhere (no `cloudflare:workers` at module scope), but its OCR
path only _runs_ with R2 + Workers AI bindings present.
² The barrel value-exports only import-safe modules; the two durable classes that
`import 'cloudflare:workers'` are isolated in `/cloudflare/runtime`.

> ⚠️ **Keep `cloudflare:workers` out of `wfConfig`'s module graph — import the
> durable classes only from `/cloudflare/runtime`, only in your Worker.**
> `wfConfig` is imported by **both** runtimes: the workflows Worker _and_ the
> host's data-API route (§5), which runs in the host's Node/edge server (Next.js,
> etc.), where `cloudflare:workers` does not exist. The two durable classes —
> `makeGraphWorkflow` and `RunRoom` — `import { WorkflowEntrypoint, DurableObject }
> from 'cloudflare:workers'` at module scope, so they are isolated in the
> **Worker-only** `@stevepeak/007/cloudflare/runtime` subpath. Import them **only
> from your Worker entry** (§4). The `@stevepeak/007/cloudflare` barrel and the
> `/cloudflare/*` leaf subpaths are import-safe from any runtime.
>
> Historically the barrel re-exported the durable classes, so pulling `wfConfig`
> into a Node route crashed at module-eval with `Cannot find module
> 'cloudflare:workers'` (an import trace ending at your config; every `/api/wf`
> call 500s). Splitting `/runtime` out removed the trap. Belt-and-suspenders: add
> a `no-restricted-imports` eslint rule in the web app forbidding
> `@stevepeak/007/cloudflare/runtime` and `cloudflare:workers`, so the mistake
> can't reappear.

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
import type { WfSdkConfig, ToolRegistry } from '@stevepeak/007'
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

- **Wrap the object in `defineWfConfig<TDeps>({ … })`** (from `@stevepeak/007`).
  It returns the config unchanged but validates it at construction, so a
  forgotten `buildRunDeps` or a `toolRegistry` that isn't a `Map` fails loudly at
  startup instead of as an opaque runtime error mid-run or an empty editor
  dropdown.
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
  `createR2BlobResolver` (`@stevepeak/007/cloudflare/blob-resolver` — the narrow
  subpath, **not** the `/cloudflare` barrel; see §0) — point it at the same
  bucket; other storage needs your own resolver.
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
} from '@stevepeak/007'

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
host's job.** This repo's CI only validates (lint/typecheck/test) and never
touches a database — the committed `wrangler.jsonc` carries generic placeholders,
so no specific host's Cloudflare IDs or secrets ever live in this (potentially
public, multi-consumer) repo. Wire it up in your **host** repo instead.

### Setup: apply the `wf_*` migrations from your host (recommended)

Assumes you consume this SDK as a git submodule (mounted at, say,
`packages/wf-sdk`) or vendored dir; adjust paths to match.

**1. Add a host-owned wrangler config** next to your host glue (e.g.
`packages/wf-host/wrangler.jsonc`). It binds _your_ D1 with real IDs — safe
because it lives in your **private** host repo — and points `migrations_dir` at
this package's `migrations/`. `migrations_dir` is resolved relative to this file:

```jsonc
// packages/wf-host/wrangler.jsonc  (../wf-sdk == the submodule mount)
{
  "account_id": "<your-account-id>",
  "name": "wf-sdk-migrations", // not a deployable Worker; migrations-only
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "your-db",
      "database_id": "<your-db-id>",
      "migrations_dir": "../wf-sdk/migrations",
    },
  ],
}
```

**2. Apply from your host's CI** with your host's own secrets. If the SDK is a
submodule, the checkout **must** fetch it (else `migrations/` is empty):

```yaml
# host repo .github/workflows/*.yml — gate on your deploy branch
- uses: actions/checkout@v4
  with:
    submodules: recursive # required, or migrations_dir is empty
- uses: ./.github/actions/setup # your normal install (bun/pnpm/npm ci)
# Invoke the workspace-hoisted wrangler with YOUR package manager — NOT
# cloudflare/wrangler-action. See the caveat below.
- name: Apply wf_* D1 migrations
  working-directory: packages/wf-host
  env:
    CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }} # HOST repo secret
    CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }} # HOST repo secret
  run: bunx wrangler d1 migrations apply your-db --remote
```

The only secrets needed are your host's existing `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` — set them on the **host** repo, never here.

> ⚠️ **Caveat (`cloudflare/wrangler-action` + workspace deps):** don't reach for
> `cloudflare/wrangler-action` here unless your host-glue package declares
> `wrangler` as a direct dependency. When the action can't find a local wrangler
> it falls back to `npm i wrangler@<pinned>` **in `workingDirectory`**, and npm
> cannot parse a monorepo host package's `workspace:*` deps — it fails with
> `npm error code EUNSUPPORTEDPROTOCOL / Unsupported URL Type "workspace:"`. The
> `wrangler-action` you may have for _other_ steps works only because those
> packages happen to declare wrangler directly. Running the hoisted binary via
> your own package manager (`bunx wrangler …`, `pnpm exec wrangler …`) sidesteps
> the npm shell-out entirely. wrangler reads `CLOUDFLARE_API_TOKEN` /
> `CLOUDFLARE_ACCOUNT_ID` from the env, so no extra flags are needed.

**3. Local dev:** point wrangler at the same config against your local D1:

```sh
wrangler d1 migrations apply your-db --local \
  --persist-to .wrangler/state --config packages/wf-host/wrangler.jsonc
```

> ⚠️ **Shared local D1 across processes.** In dev the data route (web, running
> under `next dev`/OpenNext miniflare) and the workflows Worker (`wrangler dev
> --persist-to X`) are **separate processes** that must open the **same** local
> SQLite, or the editor writes rows the runtime can't see (and vice versa).
> Miniflare keys local D1 by `database_id`, so both bindings need the **same
> id**, and the web side must be pointed at the Worker's persist dir — with
> OpenNext that's `initOpenNextCloudflareForDev({ persist: { path: X + '/v3' } })`
> in `next.config` (note the `v3` segment asymmetry: `wrangler --persist-to X`
> writes under `X/v3/…`, but `getPlatformProxy({ persist: { path } })` treats
> `path` as the already-`v3` root). Apply the migrations against that shared dir
> once, before either process reads it (a one-shot task in your dev orchestrator
> works well). Symptom when it's wrong: an empty editor or "no such table:
> wf_workflow" despite a Worker that boots fine.

**Regenerating** after a schema bump (edit `src/storage/schema.ts`):
`bun run db:generate` inside this package (drizzle-kit; needs no credentials),
then commit the new SQL here and let the host apply it.

> ⚠️ **Gotcha (shared D1):** if your host also has its own migrations dir (e.g.
> 1121law applies `packages/db/migrations` for its _own_ schema), you can't put
> two `migrations_dir` on one binding — the `wf_*` migrations need a **separate**
> config + `apply` step (exactly step 2 above). Both dirs share the D1's default
> `d1_migrations` tracking table with distinct filenames, so they coexist without
> collision. Worked example: 1121law runs two `d1 migrations apply law-db` steps
> back-to-back in its `deploy-migrations` job — one for `packages/db`, one for
> `packages/wf-host`.

You can also **skip CI** and apply manually via this package's `db:migrate`
script — fill the `wrangler.jsonc` placeholders with real IDs first, or pass
`--config` to your host config as in step 3.

> 💡 **Auto-apply on `git pull` (local convenience).** So teammates don't run
> stale schemas after pulling, wire a `post-merge` git hook that applies new
> local migrations only when the merge touched a `migrations/` dir:
>
> - **This package (a submodule):** hooks live in the submodule's git dir, so
>   drop `.githooks/post-merge` and activate it once per clone with
>   `git config core.hooksPath .githooks` (run inside the submodule). The hook
>   runs `bun run db:migrate:local` when `migrations/` changed.
> - **The host repo (1121law):** it uses Husky, so add `.husky/post-merge` — no
>   per-clone config needed (Husky wires `core.hooksPath` on `bun install`). Gate
>   it on `packages/db/migrations/` and run that package's `db:migrate:local`.
>
> Both guard on `git diff-tree ORIG_HEAD HEAD` so ordinary pulls stay fast, and
> `wrangler d1 migrations apply --local` is idempotent (only the missing
> migrations run). Note a parent-repo pull that only bumps the submodule pointer
> won't fire the submodule's hook — apply `wf_*` migrations after
> `git submodule update` in that case.

Get a `WfDb` handle from a D1 binding inside the request/step path:

```ts
import { createWfDb } from '@stevepeak/007/storage'
const db = createWfDb(env.DB) // never at module load — DB is a request binding
```

---

## 4. Step 3 — the workflows Worker (Cloudflare runtime)

In a Worker, build the durable graph interpreter from your config and export it
plus the `RunRoom` DO:

```ts
// apps/workflows/src/index.ts (or your equivalent)
import { wfConfig, type HostDeps } from 'your-host'
import { startGraphRun } from '@stevepeak/007/cloudflare'
// Durable classes from the Worker-only `/runtime` subpath (they import
// `cloudflare:workers`). This is the ONE place that subpath may be imported.
import {
  makeGraphWorkflow,
  RunRoom as RunRoomImpl,
} from '@stevepeak/007/cloudflare/runtime'

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
to `POST /graph-runs` in local dev. For that fallback, don't hand-roll the fetch —
use `createHttpGraphRunClient({ baseUrl })` (from `@stevepeak/007/cloudflare`),
which implements the `WfGraphRunClient` interface so the binding and the HTTP
client are interchangeable at the call site.

---

## 5. Step 4 — the data API route (editor/run-viewer backend)

Mount **one POST route** that the UI talks to. `createWfSdkHandlers` dispatches
every `WfDataClient` method; you supply the D1 handle and the authenticated
tenant scope. The SDK stays auth-free — identity is resolved server-side and
never trusted from the client.

This route runs **in the host web app**, against the web app's **own D1 binding**
to the same database the workflows Worker uses (bind it in the web app's
`wrangler.jsonc` too — it's a plain D1 read/write path, available in `next dev`
via miniflare). Do **not** proxy this data plane to the workflows Worker: only
run-_starting_ needs the cross-Worker service binding (§4, §7); the editor/
run-viewer only needs D1. Tunnelling it through the Worker forces a dev-only HTTP
endpoint with an untrusted `tenantId` header — avoid that. (If you were pushed
toward a proxy by a `cloudflare:workers` crash when importing `wfConfig`, that's
the barrel-import trap — fix it per §0, don't work around it.)

```ts
// apps/web/app/api/wf/route.ts
import { createWfSdkHandlers } from '@stevepeak/007/server'
import { createWfDb } from '@stevepeak/007/storage'
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
- **`resolveDb` → `WfDb`** per request. In dev, gate it once with
  `assertWfSchema(db)` (from `@stevepeak/007/storage`) — it throws a
  migrate-me hint if the bound D1 has no `wf_*` tables, turning an unmigrated
  database from a confusing empty-editor symptom into a clear error.
- The wire protocol is `{ method, params }` over POST; the full method set is the
  `WfDataClient` interface in `src/server/protocol.ts`.
- **Typecheck:** this route imports SDK source (`createWfDb`, `createWfSdkHandlers`,
  and your `wfConfig`) that references ambient Cloudflare globals (`D1Database`,
  `R2Bucket`, `Ai`). Add `@cloudflare/workers-types` to your host **web app's**
  tsconfig `types` (it coexists with the DOM libs under `skipLibCheck`, since the
  app runs on the Workers runtime via OpenNext), or `tsc` fails with
  `Cannot find name 'D1Database'`. Keep it out of the browser bundle by scoping it
  to this app's config, not the shared base.

---

## 6. Step 5 — the UI

The UI is React (separate `tsconfig.ui.json`, DOM+JSX). It ships behavior, not
chrome: a router adapter and design-system primitives are injected.

### Provider

```tsx
// components/wf/provider.tsx
'use client'
import { createHttpWfDataClient, WfSdkProvider } from '@stevepeak/007/ui'
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
import { WfApp } from '@stevepeak/007/ui'
import { usePathname } from 'next/navigation'
import { WfProvider } from '@/components/wf/provider'

const BASE_PATH = '/wf'

export default function WfPage() {
  const pathname = usePathname()
  const path = pathname.replace(BASE_PATH, '').replace(/^\//, '')
  return (
    <WfProvider>
      <div className="h-[calc(100vh-3.5rem)]">
        <WfApp
          basePath={BASE_PATH}
          path={path}
          // pushState, NOT router.push — see the ⚠️ note below.
          navigate={(to) => {
            const url = to ? `${BASE_PATH}/${to}` : BASE_PATH
            window.history.pushState(null, '', url)
          }}
        />
      </div>
    </WfProvider>
  )
}
```

The nav seam (`src/ui/nav.tsx`) is router-agnostic: the SDK never imports a
router. All internal links are relative to `basePath`; `navigate` receives a
path relative to `basePath`.

> ⚠️ **Navigate with `window.history.pushState`, not `router.push`.** `WfApp`
> owns its own browser-style tab strip and internal sections; it drives the URL
> **only** to keep deep links, refresh, and back/forward working — it does **not**
> want an App Router route change. With `router.push` every asset click triggers a
> full Next navigation: an RSC round-trip that re-executes the `(app)` layout and
> **visibly remounts the whole tree under the tab strip** (the page appears to
> refresh/flicker on each tab switch). `pushState` updates the URL client-side
> only; Next keeps `usePathname()` in sync with it (and with back/forward via
> `popstate`), so the injected `path` still updates with **no refetch and no
> remount**. You therefore don't need `useRouter` at all — `usePathname` alone
> reads the manually-pushed URL reactively. Symptom when this is wrong: switching
> tabs inside `WfApp` reloads/flashes the surrounding app shell.

### Embedding just the run viewer

To surface a single run's trace elsewhere (e.g. a chat's "inspect thinking"),
render `RunViewer` inside the same provider, keyed on the `workflowRunId`
(= `wf_run.id`) returned by `startGraphRun`:

```tsx
import { RunViewer } from '@stevepeak/007/ui'
;<WfProvider>
  <RunViewer runId={workflowRunId} />
</WfProvider>
```

`RunViewer` streams live progress when a `RunRoom` socket is available, otherwise
polls `getRun`.

### Styling setup

- **Tailwind v4 (recommended):** after your `@import 'tailwindcss';`, add one line:

  ```css
  @import '@stevepeak/007/ui/styles.css';
  ```

  This ships-with-the-package entry registers the SDK's own source with Tailwind
  (`@source`, resolved relative to the package — v4 doesn't scan `node_modules`
  and ignores the legacy JS `content`) **and** bundles the editor-canvas
  (`@xyflow/react`) CSS from the package's own dependency. So you write no
  `@source` path and don't need `@xyflow/react` as a direct dependency. Symptom
  when the SDK source isn't scanned: the editor/list render with correct
  structure but **no styling** (utilities like `flex`, `text-neutral-500` were
  never emitted).
- **Tailwind v3:** the CSS `@source` entry above is v4-only. Instead add
  `./node_modules/@stevepeak/007/src/**/*.{ts,tsx}` (or the workspace path) to
  your `content` array, and `@import '@xyflow/react/dist/style.css';` yourself
  (make `@xyflow/react` a direct dep of the host web app, or the CSS `@import`
  won't resolve from a transitive copy).
- The agent editor's prompt body uses **Tiptap**; its CSS comes with the components.

---

## 7. Step 6 — trigger a run from a feature

The end-to-end pattern (this repo's chat route): resolve the tenant's assigned
workflow (seeding on first use), then start a run.

```ts
import { resolveAssignedVersion } from '@stevepeak/007'
import { createWfDb } from '@stevepeak/007/storage'
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

`@stevepeak/007/eval` runs a graph through the in-process executor with a mock model
and mock tools — no D1, no Workers:

```ts
import { runWorkflowUnderConditions } from '@stevepeak/007/eval'
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

1. **Package scope `@stevepeak/007`.** Rename the package + all subpath imports for
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
   ships `createR2BlobResolver` (`@stevepeak/007/cloudflare/blob-resolver` — the narrow
   subpath, **not** the barrel; see §0) to read them back. If you register
   `extract_text` (or any ref-producing tool), also set `config.resolveBlobRef` —
   point `createR2BlobResolver` at the same R2 bucket, or write your own resolver
   for non-R2 storage. Tools with no large outputs can leave it unset.

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
