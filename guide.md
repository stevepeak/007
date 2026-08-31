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
| RPC dispatch (`createWfSdkHandlers`)                             | ✅                | route auth + `{ userId? }`, the `WfDb`    |
| Editor / run-viewer / hub UI (`WfApp`)                           | ✅                | router adapter, design-system primitives  |
| Model provider (`getModel` + `listModels` + `listProviders`)     |                   | ✅                                        |
| Provider spend budgets (`fetchProviderBudget`, optional)         | the cards + meter | ✅ the balance call (omit → no cards)     |
| Tools (`toolRegistry`; `/tools` + `/cloudflare` ship a few)      |                   | ✅                                        |
| Event catalog + input schemas (`triggers`)                       |                   | ✅ (manual/periodic built in)             |
| Per-run deps (`buildRunDeps`)                                    |                   | ✅                                        |
| Blob-ref resolver (`resolveBlobRef`, optional)                   | marker shape only | ✅ if a tool spills large values          |
| Run identity (`subjectId` / `correlationId` / `promptVariables`) |                   | ✅ (opaque text)                          |
| Tenant isolation                                                 |                   | ✅ (one D1 database per tenant — no SDK column) |

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
| `@stevepeak/007/analytics`               | any server route        | `AnalyticsQuery` + dashboard aggregates over the telemetry dataset |
| `@stevepeak/007/storage`                 | Workers (D1)            | `createWfDb`, data access, schema               |
| `@stevepeak/007/storage/schema`          | build-time              | drizzle-kit / migrations                        |
| `@stevepeak/007/cloudflare`              | any server route²       | `startGraphRun`, `createHttpGraphRunClient`, `createR2BlobResolver`, `createExtractTextTool` |
| `@stevepeak/007/cloudflare/runtime`      | Workers **only**        | `makeGraphWorkflow`, `RunRoom` (durable classes — import `cloudflare:workers`) |
| `@stevepeak/007/cloudflare/blob-resolver`| any server route        | `createR2BlobResolver` (engine-only leaf)       |
| `@stevepeak/007/cloudflare/blob-spill`   | any server route        | `createR2BlobSpiller`, `spillTextIfLarge` (the write half of blob refs) |
| `@stevepeak/007/cloudflare/extract-text` | any server route¹       | `createExtractTextTool` (R2/Vision OCR tool)    |
| `@stevepeak/007/cloudflare/analytics-engine` | Workers (AE binding) | `createAnalyticsEngineTelemetry` — the write half of run telemetry (§7b) |
| `@stevepeak/007/server`                  | any server route        | `createWfSdkHandlers`, `createHttpWfDataClient` |
| `@stevepeak/007/tools`                   | any (fetch + deps)      | built-in tools (`createTavilyTool`)             |
| `@stevepeak/007/ui`                      | browser (React 19)      | `WfApp`, `WfSdkProvider`, `RunViewer`, hooks    |
| `@stevepeak/007/ui/run-progress`         | browser (React 19)      | `WorkflowRunProgress` + the progress source, without pulling the editor |
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
  DB: D1Database // your app tables
  WF_DB: D1Database // the SDK's own D1 (wf_* tables)
  MODEL_API_KEY: string
  // …whatever your tools need
}

// (b) Your private per-run deps. Whatever your tools consume. These come from
//     the RunContext (subjectId / correlationId / promptVariables / env) that
//     startGraphRun put on the run — RunContext has no tenantId of its own, so
//     carry your org/tenant scope in `correlationId` if a tool needs it.
export type HostDeps = {
  orgId: string
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
      build: (d) => createSearchTool({ orgId: d.orgId /* … */ }),
    },
  ],
])

export const wfConfig: WfSdkConfig<HostDeps> = {
  // getModel + buildRunDeps receive RunContext so they can read live bindings
  // that only exist INSIDE a step.do boundary (never at module load).
  getModel: (modelId, ctx) =>
    getModel((ctx.env as HostEnv).MODEL_API_KEY, modelId),
  listModels: () => [{ id: 'model-a', label: 'Model A', providerId: 'my-provider' }],
  // The providers the editor groups models by; every listModels entry references
  // one by `providerId`. Return a single entry for a one-provider host.
  listProviders: () => [{ id: 'my-provider', label: 'My Provider', kind: 'openai-compatible' }],
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
      orgId: ctx.correlationId ?? '',
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
- The UI needs `listModels` + `listProviders` + `toolRegistry` (editor
  dropdowns) and `triggers` (the create-workflow event picker + its data-field
  preview); the runtime needs `getModel` + `toolRegistry` + `buildRunDeps` +
  `triggers` (and `resolveBlobRef` if you use blob spilling).
- **Optional hooks:** `fetchModelCatalog` (live provider `/models` refresh on the
  Models admin page), `fetchProviderBudget` (spend/credit remaining — see below),
  `resolveImageRef` (vision inputs), `onRunComplete` / `onRunFailed` (reflect
  a run's terminal state back onto your own entity — the one named by
  `subjectId`), and `resolveTelemetry` (per-step/per-run analytics — see §7b).
  Omit any you don't use.

### Provider spend budgets (optional)

Implement `fetchProviderBudget` and the SDK renders, per provider, how much
credit is left and what limits the key carries — as a strip on each provider card
on the Models page, and as a **Providers** panel on the dashboard. Skip the hook
and neither appears.

```ts
// your-host/src/model.ts
import type { ModelListContext, ProviderBudget } from '@stevepeak/007'

export async function fetchProviderBudget(
  ctx: ModelListContext,
  providerId: string,
): Promise<ProviderBudget | null> {
  if (providerId !== 'openrouter') return null // no balance API → "not reported"
  const apiKey = (ctx.env as HostEnv).OPENROUTER_API_KEY
  const res = await fetch('https://openrouter.ai/api/v1/key', {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  if (!res.ok) throw new Error(`OpenRouter /key failed: ${res.status}`)
  const { data } = (await res.json()) as {
    data: {
      limit?: number | null
      limit_remaining?: number | null
      limit_reset?: string | null
      usage?: number
      label?: string
      is_free_tier?: boolean
    }
  }
  return {
    providerId,
    status: 'ok',
    remaining: data.limit_remaining ?? null,
    limit: data.limit ?? null,
    usage: data.usage ?? null,
    resetInterval: data.limit_reset ?? null, // e.g. 'monthly'
    keyLabel: data.label,
    isFreeTier: data.is_free_tier,
  }
}
```

Then register it beside the other model hooks:

```ts
export const wfConfig = defineWfConfig<HostDeps>({
  getModel,
  listModels,
  listProviders,
  fetchModelCatalog,
  fetchProviderBudget, // ← optional
  // …
})
```

Rules that matter:

- **Return `null`, don't throw, for a provider with no balance endpoint.** Neither
  Anthropic nor OpenAI publishes one, so a direct-key provider returns `null` and
  its card reads "doesn't report a balance". `null` is a normal answer; a throw is
  reserved for a call that actually failed.
- **Errors are contained per provider.** The SDK wraps each call in its own
  try/catch and turns a throw into `status: 'error'` with the message on that one
  card — a revoked key can't blank the others. You don't need to catch inside the
  hook.
- **Report `remaining` as the provider reports it — never derive it from
  `limit - usage`.** On a resetting key those disagree: OpenRouter's `usage` is
  all-time while `limit_remaining` respects `limit_reset`, so a key at $2.15
  all-time against a $20 monthly cap has spent $0.56 this period, not $2.15.
  (The SDK draws its meter from `limit - remaining` for the same reason.)
- **`limit: null` means uncapped**, not unknown — the UI drops the meter and shows
  spend-to-date instead. Same for `remaining`.
- **Nothing is persisted.** Unlike `fetchModelCatalog` (which upserts into
  `wf_model`), this is read live on every request and cached only in the browser
  (60s). The figure on screen is the one the provider will bill against, and
  credentials stay in your env.
- **It must not be slow-path-critical.** The UI requests budgets on their own
  round-trip, separate from the model catalog and the dashboard, so a sluggish
  provider API delays only the money — never the page.

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

### Managing agents/workflows: the spec CLI (recommended over seed files)

Agents, workflows and evals are edited in the UI and live in D1. To move that
state into version control and between environments (local ↔ prod, or another
host project) — instead of hand-writing seed files — the SDK ships `wf-spec`, an
import/export CLI over slug-keyed JSON **spec files** (`specs/*.json`). Export
pulls the DB into `specs/`, import reconciles `specs/` back into any DB, diff is
a drift guard. See **`docs/sync.md`** for the full reference.

For AI/agent workflows, drop **`docs/wf-spec-sync.mdc`** into the host repo's
`.claude/rules/` (adjust the host-specific paths) so agents know to edit in the
UI, `export` into `specs/`, and only touch production when explicitly asked.

### Seed helper (legacy — prefer the spec CLI above)

To auto-provision the workspace's first workflow, ship a seed that assigns a
template graph to a trigger kind, using SDK storage primitives. Assignment is
one workflow per trigger kind per database — there is no tenant argument:

```ts
import {
  resolveAssignedVersion,
  createWorkflow,
  assignWorkflow,
  type WfDb,
} from '@stevepeak/007'

export async function seedChatWorkflow(db: WfDb) {
  const existing = await resolveAssignedVersion(db, {
    triggerKind: 'chat_message',
  })
  if (existing) return existing
  const { workflowId, versionId } = await createWorkflow(db, {
    name: 'Chat',
    graph: CHAT_TEMPLATE, // a valid WorkflowGraph
  })
  await assignWorkflow(db, {
    triggerKind: 'chat_message',
    workflowId,
  })
  return { workflowId, versionId }
}
```

The template graph is plain JSON validated by `workflowGraphSchema`; see the
README's **graph model** section for the node shapes (`trigger → agent → output`).

---

## 3. Step 2 — storage & D1 migrations

The SDK owns the `wf_*` tables (defined under `src/storage/schema-*.ts`, barrelled
by `schema.ts`). The core set is the workflow/agent lifecycle — `wf_workflow`,
`wf_workflow_version`, `wf_workflow_draft`, `wf_agent`, `wf_agent_version`,
`wf_agent_draft`, `wf_workflow_assignment` — plus the run tables `wf_run`,
`wf_run_step`, and `wf_run_log`. Later slices add models (`wf_model`,
`wf_model_provider`), evals (`wf_eval_set`, `wf_eval_row`, `wf_eval_run`,
`wf_eval_result`), and feedback (`wf_feedback`). Workflows and agents share one
lifecycle shape (entity + 1:1 editable draft + immutable published versions). All
tables use **opaque text identity** (no foreign keys into your tables), and the
SDK never reads or writes a non-`wf_` table — so it is fully self-contained. The
generated SQL lives in `migrations/` (append-only; regenerate with
`bun run db:generate`).

> **Give the SDK its own D1.** Because it is self-contained, the `wf_*` tables
> *can* sit in a host's database — but don't. Two reasons, in order of how much
> they will hurt:
>
> 1. **Migration ledgers collide.** D1 tracks applied migrations in a single
>    `d1_migrations` table per database. Point two Drizzle migration sets at one
>    database and they share that ledger while numbering independently from
>    `0000_`. Drizzle's random filename suffixes come from one word list, so two
>    sets will eventually generate the same name — at which point the ledger
>    reports an unapplied migration as already applied and the schema silently
>    diverges. Nothing warns you.
> 2. **Write contention and blast radius.** D1 is SQLite: one writer per
>    database. `wf_run_step` and `wf_run_log` are the highest-volume writes the
>    SDK makes, and they will contend with your user-facing queries. A separate
>    database also means the SDK's 10 GB ceiling, backups, and read replication
>    are yours to tune independently — and that a bad `wf_*` migration cannot
>    reach your data.
>
> Cost is not a factor: D1 bills on rows read/written and total storage, not per
> database.

The generated SQL lives in this repo's `migrations/` dir. **Applying it is the
host's job.** This repo's CI only validates (lint/typecheck/test) and never
touches a database — the committed `wrangler.jsonc` carries generic placeholders,
so no specific host's Cloudflare IDs or secrets ever live in this (potentially
public, multi-consumer) repo. Wire it up in your **host** repo instead.

### Setup: apply the `wf_*` migrations from your host (recommended)

Assumes you consume this SDK as a git submodule (mounted at, say,
`packages/wf-sdk`) or vendored dir; adjust paths to match.

**1. Create a D1 for the SDK** — `wrangler d1 create your-wf-db` — then **add a
host-owned wrangler config** next to your host glue (e.g.
`packages/wf-host/wrangler.jsonc`). It binds that D1 with real IDs — safe because
it lives in your **private** host repo — and points `migrations_dir` at this
package's `migrations/`. `migrations_dir` is resolved relative to this file:

```jsonc
// packages/wf-host/wrangler.jsonc  (../wf-sdk == the submodule mount)
{
  "account_id": "<your-account-id>",
  "name": "wf-sdk-migrations", // not a deployable Worker; migrations-only
  "d1_databases": [
    {
      // WF_DB, not DB — your Workers generally need their own database in the
      // same request, so the two bindings must not share a name.
      "binding": "WF_DB",
      "database_name": "your-wf-db", // dedicated to the SDK; see the box above
      "database_id": "<your-wf-db-id>",
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

> ⚠️ **Two migration sets, two databases.** Your host almost certainly has its
> own migrations dir. You cannot put two `migrations_dir` on one binding, so the
> `wf_*` migrations always need a **separate** config + `apply` step (exactly
> step 2 above). Point that step at the SDK's own database — then each set owns
> its own `d1_migrations` ledger and the collision described at the top of this
> section cannot happen. Worked example: 1121law runs two `apply` steps in its
> `deploy-migrations` job, one for `packages/db` → `law-db`, one for the wf
> config → `law-wf`, and wraps both in a single `bun run db:migrate`.
>
> **Migrating from a shared database?** The order that matters is: create the new
> D1 and apply the migrations to it *first* (inert — nothing reads it yet), then
> deploy the `WF_DB` binding, and only then ship code that reads `env.WF_DB`. A
> binding with no reader is harmless; a reader with no binding is
> `createWfDb(undefined)` and a live outage. Copy the data with a data-only
> `wrangler d1 export --table wf_… --no-schema` into
> `wrangler d1 execute <new-db> --file=` (there is no `d1 import`), and **never
> copy the `d1_migrations` rows** — the new database already has its own correct
> ledger. Leave the old `wf_*` tables in place until you are confident, then drop
> them; while they exist, resist adding a `env.WF_DB ?? env.DB` fallback, which
> would silently read and write the stale copy.

You can also **skip CI** and apply manually via this package's `db:migrate`
script — fill the `wrangler.jsonc` placeholders with real IDs first, or pass
`--config` to your host config as in step 3.

> 🔌 **Injecting the host DB (keep this package generic).** This package is a
> submodule shared across companies, so its `db:migrate[:local]` scripts must not
> hardcode any one host's D1. They read three optional env vars (with defaults)
> and, before doing so, source an optional `../../.wf-migrate.env` at the **host
> repo root** — so both the shipped `.githooks/post-merge` and a manual
> `cd packages/007 && bun run db:migrate:local` pick up the same target:
>
> | var            | default                 | meaning                                            |
> | -------------- | ----------------------- | -------------------------------------------------- |
> | `WF_D1_NAME`   | `WF_DB`                 | D1 name **or binding** to migrate                  |
> | `WF_D1_CONFIG` | `./wrangler.jsonc`      | wrangler config providing that binding + `migrations_dir` |
> | `WF_D1_STATE`  | `../../.wrangler/state` | local persist dir (repo-root state)                |
>
> Paths are **relative to `packages/007`** (the CWD the scripts run in). Point
> `WF_D1_CONFIG` at a host config whose `migrations_dir` resolves back to this
> package's `./migrations` — `migrations_dir` is resolved relative to that config
> file, not the CWD. The host keeps `.wf-migrate.env` gitignored in its own repo;
> nothing host-specific is committed here. Examples:
>
> ```sh
> # newco/.wf-migrate.env   (apps/workflows binds WF_DB → newco-wf, migrations_dir → 007)
> export WF_D1_NAME=WF_DB
> export WF_D1_CONFIG=../../apps/workflows/wrangler.jsonc
> export WF_D1_STATE=../../.wrangler/state
>
> # 1121law/.wf-migrate.env (packages/db/wrangler.wf.jsonc binds WF_DB → law-wf, migrations_dir → ../007/migrations)
> export WF_D1_NAME=law-wf
> export WF_D1_CONFIG=../../packages/db/wrangler.wf.jsonc
> export WF_D1_STATE=../../.wrangler/state
> ```
>
> ⚠️ This file is **gitignored in the host repo**, so a change to which database
> the wf migrations target cannot reach a teammate through a pull. If
> `bun run db:migrate:local` inside this package starts writing an unexpected
> database, a stale `.wf-migrate.env` is the first thing to check. Committing a
> `.wf-migrate.env.example` alongside it makes the current value discoverable.
>
> With no `.wf-migrate.env` present the scripts fall back to this package's own
> placeholder `wrangler.jsonc`, which is a template only — fill it in, or (better)
> inject a host config as above.

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
const db = createWfDb(env.WF_DB) // never at module load — a request binding
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
  WF_DB: D1Database
  RUN_ROOM: DurableObjectNamespace<RunRoom>
  GRAPH_WORKFLOW: Workflow<GraphWorkflowParams>
}
```

Its input:

```ts
type StartGraphRunInput = {
  workflowVersionId: string // already tenant-authorized when you resolved it
  triggerKind: string
  triggerInput: unknown // validated against your trigger's inputSchema
  subjectId?: string
  correlationId?: string // carry your org/tenant scope here if a tool needs it
  promptVariables?: Record<string, string | undefined>
  label?: string
}
// returns { runId, workflowRunId, instanceId }
// (there is no `tenantId` anywhere — tenant isolation is which D1 database this
//  Worker is bound to; the run is keyed by workflowVersionId.)
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
  // Two: your own app database, plus the SDK's dedicated one (see §3).
  "d1_databases": [
    { "binding": "DB", "database_name": "your-db", "database_id": "…" },
    { "binding": "WF_DB", "database_name": "your-wf-db", "database_id": "…" },
  ],
}
```

If your web Worker starts runs, add a **service binding** from web → workflows
(this repo calls it `WORKFLOWS`) and call `startGraphRun` over RPC, falling back
to `POST /graph-runs` in local dev. For that fallback, don't hand-roll the fetch —
use `createHttpGraphRunClient({ baseUrl })` (from `@stevepeak/007/cloudflare`),
which implements the `WfGraphRunClient` interface so the binding and the HTTP
client are interchangeable at the call site.

> 🔁 **Expose a generic `startGraphRun` RPC method — the editor's Retry and Eval
> buttons need it.** Two SDK host hooks in the data-API route (§5) —
> `retryRun` and `startEvalRun` — resolve a run to a **specific
> `workflowVersionId`** and hand it back with the full option set (`resumeFromRunId`
> for resume; `simulate`/`isEval`/`fixtures`/`freezeTools`/`agentOverride` for
> evals). They can't go through a trigger-based `startRun(triggerKind, …)`, which
> resolves the version _for_ you. So the workflows Worker should expose a thin RPC
> method that forwards straight to the SDK helper:
>
> ```ts
> class WorkflowsService extends WorkerEntrypoint<Env> implements WorkflowsRpc {
>   // …startRun(triggerKind, input, opts) for your own feature triggers…
>
>   /** Start a specific version with the full option set (retry/resume/eval). */
>   async startGraphRun(input: GraphRunInput): Promise<GraphRunResult> {
>     return await startGraphRun(this.env, input) // @stevepeak/007/cloudflare
>   }
> }
> ```
>
> `GraphRunInput` mirrors the SDK's `StartGraphRunInput` (redeclare it on your RPC
> contract so the wire type stays decoupled from SDK internals). Return the
> **`workflowRunId`** (`wf_run.id`) from the hooks — that's the id the run viewer
> routes by and `getRun` reads; `runId` is the RunRoom address and would 404 if
> you navigated to it. See this repo's `packages/wf-host/src/rpc.ts` +
> `apps/workflows/src/index.ts` for the worked pair. (Add a matching HTTP route —
> `POST /graph-runs` taking the raw `GraphRunInput` — for the `next dev` fallback.)

---

## 5. Step 4 — the data API route (editor/run-viewer backend)

Mount **one POST route** that the UI talks to. `createWfSdkHandlers` dispatches
every `WfDataClient` method; you supply the D1 handle (the workspace) and gate
the route with your own auth. The SDK stays auth-free — it never trusts identity
from the client; the only thing it reads back is an optional `{ userId }` for
attribution (who created/published a version).

This route runs **in the host web app**, against the web app's **own D1 binding**
to the same database the workflows Worker uses (bind it in the web app's
`wrangler.jsonc` too — it's a plain D1 read/write path, available in `next dev`
via miniflare). Do **not** proxy this data plane to the workflows Worker: only
run-_starting_ needs the cross-Worker service binding (§4, §7); the editor/
run-viewer only needs D1. Tunnelling it through the Worker forces a dev-only HTTP
endpoint you'd have to re-secure — avoid that. (If you were pushed toward a proxy
by a `cloudflare:workers` crash when importing `wfConfig`, that's the
barrel-import trap — fix it per §0, don't work around it.)

```ts
// apps/web/app/api/wf/route.ts
import { createWfSdkHandlers } from '@stevepeak/007/server'
import { createWfDb } from '@stevepeak/007/storage'
import { wfConfig } from 'your-host'

export const POST = createWfSdkHandlers({
  // Uses listModels + listProviders + toolRegistry (editor dropdowns), triggers
  // (the create-workflow event picker) and the optional fetchModelCatalog /
  // fetchProviderBudget hooks. Passing the whole wfConfig is fine.
  config: wfConfig,
  resolveDb: (req) => createWfDb(getEnv().DB), // the tenant's workspace database
  resolveContext: async (req) => {
    const session = await getSession(req.headers) // your auth — gate access here
    if (!session) throw new Error('Unauthorized')
    return { userId: session.user.id } // attribution only; no tenant field
  },
  // Your live bindings. REQUIRED if any config hook reads a key out of ctx.env —
  // listModels/listProviders, fetchModelCatalog (Refresh) and
  // fetchProviderBudget (the budget cards) all receive this as their env. Omit it
  // and those see `env: undefined`.
  resolveEnv: () => getEnv(),
  // Optional: AI-generated changelog for the publish dialog. Omit → heuristic
  // structural summary. Use wfConfig.getModel to stay within the injection contract.
  summarizeChanges: async ({ previousGraph, nextGraph, ctx }) => {
    /* generate a one-line note; race an 8s timeout against a fallback */
    return 'Updated workflow.'
  },
})
```

- **The route gate is your security boundary.** The SDK is single-workspace per
  database, so isolation is which D1 `resolveDb` returns plus whatever auth you
  put in front of the route — not an SDK-level tenant filter. `resolveContext`
  returns only `{ userId? }`, used to attribute edits (`created_by`/
  `published_by`), never to scope reads.
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

### 5a. Run-execution hooks (Retry, Evals, the two playgrounds)

The config above stands up the editor + run viewer, but four features stay
**dark** until you wire their optional hooks — and if the UI reaches one that
isn't wired, `createWfSdkHandlers` answers with `"… is not configured for this
host."` (the SDK's `requireHook` guard). They split into two kinds by _what
runtime binding they need_:

| Hook                              | What it does                                  | Where it must run                                                            |
| --------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------- |
| `retryRun`                        | Run viewer's **Retry** (restart / resume)     | **Workflows Worker** — needs `GRAPH_WORKFLOW` / `RUN_ROOM` to start a run    |
| `startEvalRun`                    | **Evals** — start one graded sample run       | **Workflows Worker** — same durable bindings                                |
| `runAgentPreview`                 | Agent editor **playground** (tools simulated) | **In-process** — needs only the model seam (`config.getModel`)              |
| `runToolPreview` + `toolContextFields` | Tool detail **playground** (real execution)   | **In-process** — needs the tools' _real per-run deps_ (`buildRunDeps`)      |

> ⚠️ **The default `createWfSdkHandlers` config wires none of these.** Omitting
> them isn't an error at mount time — the data plane (editor, lists, run viewer)
> works fine — so it's easy to ship a host where Retry, Evals, and both
> playgrounds silently 500 on first click. Wire all four (below), or consciously
> decide to leave a feature off.

**Run-starting hooks → delegate to the Worker's `startGraphRun` RPC (§4).** The
SDK resolves the run to a concrete `workflowVersionId` and hands you a
descriptor; you forward it and return the `workflowRunId`:

```ts
retryRun: async ({ mode, source }) => {
  const resume = mode === 'resume'
  const started = await getWorkflowsClient().startGraphRun({
    workflowVersionId: resume
      ? source.originalVersionId
      : (source.latestVersionId ?? source.originalVersionId),
    triggerKind: source.triggerKind,
    triggerInput: source.triggerInput,
    subjectId: source.subjectId ?? undefined,
    correlationId: source.correlationId ?? undefined,
    resumeFromRunId: resume ? source.runId : undefined,
  })
  return { runId: started.workflowRunId } // wf_run.id — NOT started.runId (RunRoom addr)
},
startEvalRun: async ({
  workflowVersionId, triggerKind, triggerInput, promptVariables,
  fixtures, freezeTools, modelId, promptBody, configOverride,
}) => {
  const started = await getWorkflowsClient().startGraphRun({
    workflowVersionId, triggerKind, triggerInput, promptVariables,
    simulate: true,   // neutralize write tools
    isEval: true,     // hide from the Runs explorer
    fixtures,         // stub read tools
    freezeTools,      // synthesis mode (agent answers from seeded messages)
    label: 'Eval run',
    // `modelId`/`prompt` are the matrix axes; `config` is the agent editor
    // running its goals against an UNSAVED draft (nothing published).
    agentOverride: modelId || promptBody || configOverride
      ? { modelId, prompt: promptBody, config: configOverride }
      : undefined,
  })
  return { wfRunId: started.workflowRunId }
},
```

**Playground hooks → run in-process with the SDK helpers.** `executeAgentPreview`
and `executeToolPreview` (from `@stevepeak/007/server`) reuse the exact node
executors a real run uses. Build a `RunContext` carrying live `env` + identity;
the agent preview simulates tools (no deps), the tool preview builds the **real**
deps via your `buildRunDeps` and executes for real:

```ts
runAgentPreview: async ({ config, input, promptVariables }) => {
  const { env } = getCloudflareContext()
  return await executeAgentPreview({
    config, input, wfConfig,
    runContext: { triggerKind: 'playground', promptVariables, env },
  })
},
// The ambient run scope the tool playground collects up front — NOT tool
// arguments (an agent never sets these); they're what the tools read from their
// per-run deps. Map each key into the RunContext identity buildRunDeps reads.
toolContextFields: [
  { key: 'organizationId', label: 'Organization',
    description: 'Scope the tool to this org; blank = unscoped.', placeholder: 'org id' },
],
runToolPreview: async ({ toolId, args, context }) => {
  const { env } = getCloudflareContext()
  return await executeToolPreview({
    toolId, args, wfConfig,
    runContext: { triggerKind: 'playground', correlationId: context.organizationId || undefined, env },
  })
},
```

> ⚠️ **In-process previews require the web Worker to hold the tools' runtime
> bindings.** `runToolPreview` runs `buildRunDeps(runContext)` and the tool's real
> `execute` **inside the web Worker**, not the workflows Worker — so the web
> Worker's `env` must carry every binding a tool reads (DB, model API keys,
> vector store, and any Cloudflare product binding like Workers `AI`). List them
> in the web app's `wrangler.jsonc` and secrets. In this repo the web Worker
> already had the DB + model secrets (the main app uses them), so the only
> addition was `"ai": { "binding": "AI" }` for the `extract_text` tool's OCR path.
> If a host can't or won't give the web Worker a tool's binding, either that tool
> is un-previewable there, or route `runToolPreview` through the workflows Worker
> over RPC instead (mirroring the run-starting hooks). The agent preview is
> unaffected — it simulates tools, so it needs only `getModel`'s key.

**Optional:** `sentryTraceUrl(traceId)` builds the run viewer's "View trace in
Sentry" deep-link (return `null` to omit it) — the host owns the URL shape since
only it knows its Sentry org/region. `evalJudgeModelId` pins which model grades
`llm_judge` eval checks (defaults to `listModels()[0]`).

### 5b. Headless access: the MCP server (`wf-mcp`)

The same route backs an MCP server the SDK ships as a bin, so an AI client
(Claude Code, Claude Desktop) can read and — behind a flag — author agents,
workflows, runs and evals. It is a thin shell over `WfDataClient`: every call
goes through the mounted route, so it gets the same input validation, the same
`wf_change` audit log, and every host hook you wired above. Nothing new to
implement on the server side.

**One thing to add: a headless credential.** The route above is gated by a
browser session, which an MCP client cannot produce. Check a bearer token
_before_ your session path and resolve it to a **service identity of its own**,
never to the human who minted it — `wf_change.actor_id` is the only
who-touched-this record in 007, and the change feed renders it verbatim:

```ts
resolveContext: async (req) => {
  const header = req.headers.get('authorization')
  if (header?.toLowerCase().startsWith('bearer ')) {
    // Constant-time compare against your WF_MCP_TOKEN secret. A presented token
    // is a commitment to this door: a wrong one is a 403, NOT a fall-through to
    // the session path (which would report itself as a missing session).
    if (!(await tokenMatches(header.slice(7).trim()))) {
      throw new UnauthorizedError('Invalid service token')
    }
    return { userId: 'svc:mcp' }
  }
  const session = await getSession(req.headers)
  if (!session) throw new UnauthorizedError('Unauthorized')
  return { userId: session.user.id }
}
```

Then register the server. `--write` is off by default, and off means the
mutating tools are **not registered at all** — a read-only session has no write
tool to be talked into calling:

```bash
claude mcp add wf \
  --env WF_BASE_URL=http://localhost:3000 \
  --env WF_MCP_TOKEN=$WF_MCP_TOKEN \
  -- bunx wf-mcp
```

...or as an `.mcp.json` block:

```jsonc
{
  "mcpServers": {
    "wf": {
      "command": "bunx",
      "args": ["wf-mcp"],
      "env": {
        "WF_BASE_URL": "http://localhost:3000",
        "WF_MCP_TOKEN": "…"
      }
    }
  }
}
```

| env | meaning |
| --- | --- |
| `WF_BASE_URL` | origin of the host app, or the full data-API URL |
| `WF_API_PATH` | route the handlers are mounted at (default `/api/wf`) |
| `WF_MCP_TOKEN` | bearer credential; matches the host Worker's secret |
| `WF_MCP_TIMEOUT_MS` | per-call budget (default `120000`) |

Flags of the same name (`--base-url=`, `--api-path=`, `--token=`, `--timeout=`)
win over the env, and `--write` registers the mutating tools.

**Why HTTP and not D1 directly.** `wf-spec` and `wf-dump-run` reach D1 straight,
and copying that here is the tempting mistake. Direct-DB bypasses the
dispatcher, losing per-method input validation, the `wf_change` log and every
host-wired hook — and eval runs become structurally impossible, since
`startEvalRun` is a **host** hook that needs live Workers bindings and rejects
with "not configured" without them. One HTTP path keeps all ~70 methods working
identically, local or remote.

**Payloads are clipped.** A run step's `meta` carries the full LLM prompt, the
reasoning trace and every tool call's I/O; `get_run` truncates fat fields and
keeps only the newest steps, and says so where it does. Whatever it dropped is
reachable — `get_run_step` returns one step in full — so the truncation is a
narrowing, not data loss.

**Authoring evals is what `--write` is for.** `create_eval_set` /
`upsert_eval_sample` / `delete_eval_sample` let a model turn what it just read in
a trace into a Goal that runs tomorrow. Two details make generated Samples land
clean rather than half-right:

- A Sample's `input` is a discriminated union with exactly one legal variant per
  target — `task` and `conversation` agents take different shapes, and a
  workflow takes its raw trigger payload. So the target is **resolved first**:
  `create_eval_set` and `get_eval_set` both return a `target` block carrying the
  `sampleInputKind`, a ready-to-fill `inputTemplate` with the agent's declared
  `${vars}` already named, and the trigger kind read off the workflow's own
  graph. The next call needs no second lookup and no guess.
- That preflight also refuses a target that doesn't exist. `wf_eval_set.targetId`
  is an opaque string with no foreign key, so without it a hallucinated id stores
  a Goal that fails only when someone runs it.

**Mining samples from real runs.** `draft_sample_from_run` converts one run into
a draft Sample and returns it without writing — the model reviews it, rewrites
the rubric, then saves it with `upsert_eval_sample`. It is a **read** tool;
only saving needs `--write`. Paired with `list_feedback`, whose thumbs-down rows
name the run whose answer a human called bad, it turns a complaint into a test.
Two layers produce different samples from the same trace: `trajectory` replays
the run's real tool results as `mocked` fixtures (keyed on the same tool id the
grader looks them up under), while `synthesis` folds those results into a seeded
assistant turn and freezes the tool set so the sample grades the answer alone.
Synthesis needs a thread to stage the context in, so it is refused for a `task`
agent rather than silently degraded. The seeded rubric is never the run's own
output: on a thumbs-down run that would enshrine the failure as correct, and on
any run it makes the sample a regression test for one exact phrasing. The
conversion itself lives in `eval/from-run`, shared with the run viewer's
"Create sample" button.

**Running what it wrote, and reading the report.** `run_eval` executes a Goal's
Samples for real and `get_eval_run` reads the result, which is what makes the
authoring half self-checking rather than a write-and-hope. Four things shape
those two tools:

- **It does not block.** A sweep waits up to fifteen minutes per cell, so
  `run_eval` returns the `evalRunId` the moment the umbrella run row exists
  (`onStart`) and the model polls `get_eval_run`. Same behavior as the launch
  dialog, whose report page is a poller.
- **The orchestration runs in the caller's process.** End the MCP session
  mid-sweep and the remaining cells are never launched and the run is never
  finalized — it sits at `running` forever, exactly as when a browser tab is
  closed. The tool's `next` says so.
- **`error` is not `fail`.** A `fail` is the target answering wrongly; an `error`
  is the run never producing an answer to grade — provider refused, wrapper timed
  out, the circuit breaker skipped the rest. So `passRate` is computed over
  **graded** cells only and the errored ones are listed separately with their
  messages. Rolled together, an outage reads as a total regression.
- **Drift has two axes and they are reported apart.** `previousSnapshotHash`
  compares the Sample's own definition, so it catches an edited check and is
  structurally blind to the target agent being republished under a floating
  `targetVersion` — which changes everything under test and leaves the hash
  identical. `get_eval_run`'s `drift` answers both: `samplesEdited` and
  `agentRepublishedSinceLastRun`.

The sweep is bounded on both ends: node execution is already capped server-side
by `EVAL_NODE_EXECUTION` (7-minute timeout, no retries), concurrency is clamped
to the same 1–8 the launch dialog offers, and the tool refuses a request over 100
cells — a person picking models in a dialog sees the count before pressing Run,
and a tool call has no such moment. The orchestrator itself is `eval/run-eval`,
framework-free and shared with the dialog.

`upsert_eval_sample` passes `input` / `tools` / `checks` through unparsed — the
dispatcher validates them against the same schemas the grader reads, and its
message names the exact path that is wrong, which is what the model needs to fix
itself. On success it answers with the testing **layer** the Sample landed in
(io / trajectory / synthesis / integration) and warns about combinations that
store fine but grade nothing — a `tool_called` check under `frozen` tools grades
the absence of a call the agent was never able to make.

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

The end-to-end pattern (this repo's chat route): resolve the workflow assigned to
the trigger kind (seeding on first use), then start a run.

```ts
import { resolveAssignedVersion } from '@stevepeak/007'
import { createWfDb } from '@stevepeak/007/storage'
import { seedChatWorkflow } from 'your-host'

const db = createWfDb(env.WF_DB) // the tenant's workspace database
let assigned = await resolveAssignedVersion(db, { triggerKind: 'chat_message' })
if (!assigned) {
  await seedChatWorkflow(db)
  assigned = await resolveAssignedVersion(db, { triggerKind: 'chat_message' })
}

const run = await workflowsClient.startGraphRun({
  workflowVersionId: assigned.versionId,
  triggerKind: 'chat_message',
  triggerInput: { chatId, userText, messages }, // matches your inputSchema
  subjectId: chatId,
  correlationId: orgId, // your org/tenant scope, read back in buildRunDeps
  promptVariables: { userId },
})
// run.workflowRunId → poll getRun / key RunViewer
```

---

## 7b. Run telemetry (Cloudflare Analytics Engine)

**Entirely optional.** Wire nothing and runs behave exactly as before: the SDK
writes to a no-op sink and the dashboard answers from D1. Wire it and you get
cheap spend/volume aggregation plus the one number D1 cannot produce — how many
Cloudflare Workflows **steps** your runs actually burn.

### Why steps, specifically

A graph's step count is not proportional to its size. Every node costs three
(`enter:` + `run:` + `record:`), an **iteration spends one step per ITEM**
instead of one per node, a durable sub-workflow adds `spawn:` + `await:`, and the
run envelope adds ~8. A 6-node graph iterating a 50-item list is ~70 steps, not
18. That is the Workflows billing line, and nothing in SQL counts it — the SDK
counts real `step.*` calls with a proxy over `WorkflowStep`, so the number cannot
drift as steps are added.

### Two halves, two credentials

The write side and the read side are deliberately separate, and neither Worker
holds the other's credential.

| | Writes points | Reads points |
| --- | --- | --- |
| Where | the Worker that EXECUTES runs | the Worker that serves the data API |
| How | an `analytics_engine_datasets` **binding** | the AE **SQL API** over HTTPS |
| Credential | the binding itself | an API token scoped to **Account Analytics Read** |
| Hook | `WfSdkConfig.resolveTelemetry` | `createWfSdkHandlers({ resolveAnalytics })` |

Write side — in the executing Worker's `wrangler.jsonc`:

```jsonc
"analytics_engine_datasets": [
  { "binding": "WF_TELEMETRY", "dataset": "wf_telemetry" },
],
```

…and on your host config:

```ts
import { createAnalyticsEngineTelemetry } from '@stevepeak/007/cloudflare/analytics-engine'

resolveTelemetry: ({ env }) => {
  const dataset = (env as HostEnv | undefined)?.WF_TELEMETRY
  // A THUNK, not the binding: a live binding cannot cross a `step.do`
  // boundary, and `run()` re-executes with a fresh `env` on every wake.
  return dataset
    ? createAnalyticsEngineTelemetry({ dataset: () => dataset })
    : undefined
},
```

Read side — in the data-API route:

```ts
import { createAnalyticsQuery } from '@stevepeak/007/analytics'

resolveAnalytics: () => {
  const env = getCloudflareContext().env
  // Null in local dev (AE is unreadable there) → the dashboard uses D1.
  if (!env.CF_ANALYTICS_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) return null
  return {
    dataset: 'wf_telemetry',
    query: createAnalyticsQuery({
      accountId: env.CLOUDFLARE_ACCOUNT_ID,
      apiToken: env.CF_ANALYTICS_TOKEN,
      dataset: 'wf_telemetry',
    }),
  }
},
```

Mint a **dedicated** token for that secret. Do not reuse a general Cloudflare API
token — the read side has no business holding anything that can invoke Workers AI
or edit a Worker.

### What it changes, and what it doesn't

- **AE records ATTEMPTS; D1 records FINAL STATE.** A retried step upserts the same
  D1 row (its failed attempt's cost is discarded) but appends a second AE point.
  For spend that is the more truthful record — those tokens really were spent
  twice — so no suppression is attempted. Anything needing exactness (the run
  inspector, the failures list) stays on D1.
- **Dollars are priced when the tokens are spent**, from a price table frozen in
  the run's existing `load-graph` step — the same freeze the run manifest applies
  to prompts. The D1 path re-prices history against today's catalog; the two
  paths therefore disagree by design, and the UI says which one it showed.
- **Every panel falls back independently.** An AE outage, an expired token, or a
  window past AE's ~3-month retention costs one chart, not the page. Each panel
  reports its `source` on the wire.
- **Retention is ~3 months.** AE is a rolling operational window, never an
  archive. D1 remains the durable run trace.

Local dev needs no configuration: `writeDataPoint` is a no-op there and AE is
unreadable, so both hooks return nothing and the dashboard behaves as it always
has.

---

## 8. The identity model (get this right)

**There is no tenant column.** The SDK is single-workspace per database: one D1
holds one logical set of workflows/agents/runs. A multi-tenant host isolates
tenants by giving each its own database (or logical D1 scope) and pointing
`resolveDb` (§5) at the right one; the SDK never filters by a tenant field.

What the SDK _does_ carry is **run identity** — opaque text that `startGraphRun`
puts on the run and `buildRunDeps` reads back. You choose what maps to what; keep
the mapping consistent across the two. Carry your org/tenant scope in
`correlationId` if a tool needs it.

| Field             | Meaning                                                              | Example in this repo        |
| ----------------- | -------------------------------------------------------------------- | --------------------------- |
| `subjectId`       | the host entity a run is about                                       | `chatId`                    |
| `correlationId`   | free-form host reference (org/tenant scope for tools)                | `clientOrgId`               |
| `promptVariables` | `${name}` interpolation in agent system prompts + arbitrary run vars | `{ userId, clientOrgName }` |

`userId` reaches the editor/API layer separately, via `resolveContext` → `{ userId }`
(§5), where it attributes who created or published a version — it is not run
identity. `RunContext.env` carries your live bindings through the `step.do`
boundary; it is `unknown` to the SDK and you cast it in `getModel` /
`buildRunDeps`.

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
    listProviders: () => [],
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
5. **Migrations wiring.** Create a **dedicated D1** for the SDK (§3) rather than
   reusing your app's — sharing a database means sharing one `d1_migrations`
   ledger between two independently-numbered migration sets, which silently
   corrupts schema state when their filenames eventually collide. Then decide how
   `wf_*` migrations reach it: a host-owned config + CI step pointing at this
   repo's `migrations/` (§3 option 1), or a manual step (§3 option 2). Keep the
   host's Cloudflare secrets in the host repo — never here.
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

| Piece                            | File                                             |
| -------------------------------- | ------------------------------------------------ |
| Host config (`WfSdkConfig`)      | `packages/wf-host/src/config.ts`                 |
| Provider registry + budgets      | `packages/wf-host/src/model.ts`                  |
| Sync agents/workflows (spec CLI) | `docs/sync.md` + agent rule `docs/wf-spec-sync.mdc` |
| Seed helper + template (legacy)  | `packages/wf-host/src/{seed,template}.ts`        |
| RPC contract (`WorkflowsRpc`)    | `packages/wf-host/src/rpc.ts`                    |
| Data API route + run-exec hooks  | `apps/web/app/api/wf/route.ts`                   |
| RPC client (binding + HTTP fallback) | `apps/web/lib/workflows.ts`                   |
| UI provider                      | `apps/web/components/wf/provider.tsx`            |
| UI mount (catch-all)             | `apps/web/app/(app)/wf/[[...slug]]/page.tsx`     |
| Run viewer embed                 | `apps/web/components/wf/run-sheet.tsx`           |
| Workflows Worker + `startGraphRun` RPC | `apps/workflows/src/index.ts` + `wrangler.jsonc` |
| Chat consumer                    | `apps/web/app/api/chat/route.ts`                 |

</content>
</invoke>
