# Client changelog

Changes to the **host-facing contract** of `@stevepeak/007` — the types you
implement, the entry points you import, the routes you mount, and the behavior
you inherit. Internal refactors, UI polish and engine work are not here; they
are in `git log`.

The package is consumed as a git submodule and carries no version
(`package.json` says `0.0.0`), so entries are dated and keyed to commits rather
than to semver. Read from the top.

**How to read an entry.** Anything under **Breaking** will fail your build or
change behavior you already depend on. Anything under **Action** compiles fine
without you and is still probably wrong to skip.

---

## 2026-09-18 — the System Copilot is removed

The in-app Copilot — the right-rail chat over the platform's agents, workflows,
runs and feedback — is gone, along with its server half. `wf-mcp` is the way to
put a model on that data: it exposes the same catalog, from any MCP client, with
the write gate a developer chooses rather than one any staffer could open.

**Breaking.**

- `handleCopilotRequest` and `HandleCopilotOptions` are no longer exported from
  `@stevepeak/007/server`. Delete the route that mounted it (the guide's
  `app/api/copilot/route.ts`).
- `WfSdkProvider` no longer takes `assistant` or `copilotEndpoint`, and
  `useWfAssistant`, `WfAssistantComponent`, `WfAssistantContext`, `askCopilot`,
  `registerCopilotSeed` and `useCopilotSeedAvailable` are gone from
  `@stevepeak/007/ui`. A host that injected its own assistant has nowhere to
  render it; mount it outside `WfApp`.
- `AgentConfigPanel` and `AgentOutputEditor` no longer take the Copilot
  grounding props (`agentName` / `agentDescription`, `copilotContext`).
- `@ai-sdk/react` is no longer a dependency of the package.

**Action.** The data route is now the only surface that mounts the dispatcher.
If your `onError` hook tagged reports by which route hit them, that
discriminator has one value left — drop it.

---

## 2026-09-18 — `wf-dump-run` removed

The `wf-dump-run` bin is gone. It opened the local miniflare SQLite file (or
D1's REST API with `--prod`) directly, so it saw only whichever database it was
pointed at and bypassed the dispatcher, the `wf_change` log and every host hook.
Everything it printed is available through `wf-mcp` — `get_run` for the row,
steps, cost and log feed, `get_run_step` for any field it clipped — and that
path works identically against a local or a production host.

**Action.** Drop any script or doc that invokes `bunx wf-dump-run`; point it at
the MCP server (`bunx wf-mcp`) instead. `wf-spec --remote` still reads D1 over
REST, so the `CLOUDFLARE_*` script env stays if you use that.

---

## 2026-09-18 — Connector auth always sends `Bearer`; connector ids are generated

Two connector changes, one of which fixes every Linear connector.

**`Authorization: Bearer`, always.** The MCP client used to echo the token
endpoint's `token_type` back as the header scheme. Linear returns
`token_type: "bearer"` and then rejects `Authorization: bearer …` at its MCP
server with 401 `invalid_token` — so a freshly-connected Linear never pulled a
catalog and sat at "expired". The scheme is now the literal `Bearer` (which is
all the official MCP SDK ever sends); `McpAuth` lost its `tokenType` field. A
Refresh that succeeds with a stored credential also flips an `expired`
connection back to `connected`, so no reconnect is needed once a server starts
honouring a token again.

**No more id field.** `saveConnector` takes `id` as optional: omit it to
create, and the server derives one from the label (`slugifyConnectorId`,
de-duplicated as `linear-2`, `linear-3`, …) and returns it. Pass an id to
update, or to create on a known slug (wf-spec imports). The result is now
`{ ok, id, disconnected }` — `disconnected` is true when an edit changed the
URL or auth kind and the stored credential was dropped with it.

### Action

None for the UI; the bundled Connectors pages already use both. A host that
calls `saveConnector` directly and reads its result must expect the `id` field.

---

## 2026-09-18 — Connectors show the icon the MCP server advertises

A Refresh now reads `serverInfo.icons` off the `initialize` handshake (MCP
2025-11-25+, already typed in SDK 1.30) and stores the best `https:` or
`data:image/*` candidate on `wf_connector.icon_url`, rewriting it — null
included — every Refresh so it tracks the server. It is the fallback: an
admin-set `icon` (inline SVG) or `iconName` still wins, and the Connectors
pages, tool picker, run log and every other `ToolIcon` show it as an `<img>`
with `referrerPolicy="no-referrer"`, never inlined. `ToolMeta` / `ToolOption`
gained an optional `iconUrl` with the same meaning, so a host tool may set one
too.

Migration `0033_wf_connector_icon_url` — one nullable column, no backfill.
Existing connectors pick theirs up on the next Refresh.

### Action

None required. If your host serves a CSP with `img-src`, allow the hosts your
connectors' icons come from (or `https:`), else the fallback silently draws
nothing and the lettered chip does not return.

---

## 2026-09-18 — Runs record the release they were created on

Every `wf_run` now carries `host_release` and `sdk_release`: what was deployed
when the row was written, as the opaque strings the host pinned at deploy time
(a git sha, typically). Two columns because the SDK is a submodule on its own
clock — "did this run predate the fix" has to be answerable for either. The
run viewer's header shows them as `host@abc1234 · sdk@def5678`; `get_run` over
MCP prints them. Captured at creation and never updated, so a
durable run that resumes across a deploy still reads as the release it started
on; iteration items and callees record the deploy they were *spawned* on.

Migration `0032_wf_run_release` — two nullable columns, no backfill. Older
runs and local dev read as "no release" and the chip is simply absent.

### Action

**Pin two vars at deploy.** `GraphRunBindings` / `GraphWorkflowEnv` gained
optional `WF_HOST_RELEASE` and `WF_SDK_RELEASE`. Nothing breaks without them —
every run just records null. To get the feature, add to the Worker that hosts
`startGraphRun`:

```sh
wrangler deploy \
  --var "WF_HOST_RELEASE:$(git rev-parse HEAD)" \
  --var "WF_SDK_RELEASE:$(git rev-parse HEAD:packages/007)"
```

**`CreateWfSdkHandlersOptions.releaseUrl?(kind, release)`** — optional, beside
`sentryTraceUrl`. Return the commit page for a pinned identifier and the chip
links to it; omit it and the chip shows the bare short sha.

**`WfRunSummary.release`** is a new required field (`{ host, sdk }`, each
`{ id, url } | null`). A host that builds summaries by hand — test fixtures,
mostly — adds `release: { host: null, sdk: null }`.

---

## 2026-09-16 — Workflow write tools on `wf-mcp`, and a Tool-arg lint

The MCP catalog (and the System Copilot, which shares it) can now change and
publish **workflows**. Seven tools: `list_workflow_versions`,
`get_workflow_version` and `validate_workflow_graph` (reads, on every server);
`patch_workflow_draft`, `update_workflow_draft`, `publish_workflow` and
`discard_workflow_draft` (writes, behind `--write`). Agents are unchanged —
`publish_agent` is still deliberately absent; guide §5b says why the line falls
differently for workflows.

### Action

**`WfDataClient` gained `validateGraph`.** If you implement the interface
yourself rather than using `createHttpWfDataClient` / `createWfSdkHandlers`,
add it. It lints a draft, a version, or a supplied graph: the engine's
`collectGraphIssues`, the strict runtime schema, and the new
`collectToolArgIssues` — every Tool node's args against the tool catalog (a
required arg left unbound, a literal of the wrong type, an unknown tool id — all
errors, each a run that fails at that node; and an arg the tool no longer
declares — a warning, since zod strips it and the value is silently lost). The
one that prompted this shipped to a customer as a boolean stored as the text
`"false"`.

**The editor's Issues panel now reports the same tool-arg drift**, as errors.
A graph that published clean yesterday may show errors today if a tool's input
schema changed underneath it — that is the point, not a regression. Fix the
args (the message says what type to store), or the run fails where the panel
says it will.

### Also

- `publish_workflow` requires the `baseVersionNumber` the caller read and
  refuses if a newer version is live — one draft row per workflow means the
  last publish wins, and this is what stops it winning silently.
- `collectToolArgIssues` / `ToolInputSchemas` are exported from
  `@stevepeak/007/engine`. Pure over JSON Schema, so a host can run it wherever
  it holds a tool catalog.

---

## 2026-09-14 — Tavily web search removed

The built-in `tavily_search` tool is gone, and with it the
`@stevepeak/007/tools` subpath — it held nothing else.

### Breaking

**`@stevepeak/007/tools` no longer resolves.** If you import `createTavilyTool`,
`TAVILY_ICON_SVG`, or the `CreateTavilyToolOptions` / `TavilyResult` types, your
build fails. Drop the import and the registry entry; the tool's whole surface was
an API key and a `fetch`, so there is nothing to migrate to.

**Check your agents and graphs for `tavily_search` before upgrading.** A
registry that no longer has the id fails the run with `Tool 'tavily_search' is
not registered.` at the node that calls it, not at startup. Point those nodes
somewhere else first. (1121law had none — no spec, no agent version, no workflow
graph referenced it.)

Web search, if you want it back, is now a connector: any MCP server that offers
it plugs in through `/wf/connectors` without shipping a tool in this package.

### Also

`TAVILY_API_KEY` is dead config wherever you set it — there is no longer anything
that reads it.

## 2026-09-14 — MCP connectors

ART-152. The inbound half of MCP: sign in to a remote MCP server and its tools
become ordinary 007 tools — pickable in the agent tool list, droppable as Tool
nodes, visible on the Tools page, runnable in the playground. Nothing about a
particular service ships in code; a connector is a row.

Not to be confused with `/wf/mcp`, which is the outbound direction (how a client
points itself at *your* deployment). They now sit side by side in the hub and
are named apart everywhere: **Connectors** is inbound, **MCP** is outbound.

### Action

**Apply migration 0030.** Five new `wf_connector*` tables in your 007 database.
`assertWfSchema` probes one of them, so a dev server will tell you if you forget.

**Wire `resolveConnectorSecret` to turn the feature on.** Connector OAuth tokens
are the one secret the SDK persists itself — they are minted by a user clicking
Connect and rotate on refresh, so unlike a model provider's key they cannot live
in your env. They are stored AES-GCM-encrypted under a key you supply:

```ts
resolveConnectorSecret: ({ env }) => (env as Env).WF_CONNECTOR_KEY,
```

Omit it and connectors are **off**: the catalog resolves to nothing, no connector
tool is registered, and the Connectors page says what to configure rather than
failing at the moment somebody presses Connect. That is deliberate — a
deployment that has not thought about key management does not get token storage
by default.

Rotating the key does not lose data, but every connector must be reconnected:
the old ciphertext becomes unreadable, on purpose.

**Mount the OAuth callback.** One GET route, because a redirect cannot go through
the JSON data plane:

```ts
// app/api/wf/connectors/callback/route.ts
export const GET = createWfConnectorCallback({
  resolveDb, resolveContext, resolveSecret, defaultReturnTo: '/wf/connectors',
})
```

Then tell the data handler where you put it, with
`connectorCallbackPath: '/api/wf/connectors/callback'`. **The two must match**:
that path is registered with each authorization server as the redirect URI, and
a mismatch is rejected at authorization time rather than at startup. Gate the
route as tightly as your editor — it stores a credential.

**Pass `connectors` to the playgrounds** if you want connector tools to appear
there: `executeAgentPreview` and `executeToolPreview` both take an optional
`{ db, secret }`. Skip it and the playground quietly disagrees with production
about what an agent can do.

**Add `@cfworker/json-schema`** — it is an optional peer of the MCP SDK and the
client will not start without it. See below for why it is not optional here.

### New

| | |
| --- | --- |
| `createWfConnectorCallback` | The OAuth redirect handler, from `@stevepeak/007/server`. |
| `WfSdkConfig.resolveConnectorSecret` | The credential encryption key. Absent = feature off. |
| 12 data-plane methods | `listConnectors`, `getConnector`, `saveConnector`, `deleteConnector`, `setConnectorEnabled`, `refreshConnector`, `setConnectorToolEnabled`, `setConnectorToolSideEffect`, `startConnectorAuth`, `saveConnectorToken`, `disconnectConnector`, `getConnectorCapability`. |
| `ConnectorsList`, `ConnectorDetail` | The two UI pages, from `@stevepeak/007/ui`. |
| `wf_change` kinds | `connector` and `connector_tool`. If you render change rows from a map keyed by entity kind, add them or your build breaks. |

### Behavior worth knowing

**Nothing a server advertises is callable until a human enables it.** Discovery
inserts every tool **disabled**; a refresh preserves what was enabled and never
re-enables what was turned off. Linear's server ships write tools, and a catalog
pull that quietly widened what your agents could do would be the wrong default.

**A withdrawn tool is marked, not deleted.** An agent may still reference it, and
"the server withdrew this" is a better answer than an unresolvable id.

**Tool ids are namespaced `mcp:<connector>:<tool>`** and the connector id is
permanent — it is frozen into published agent configs, so renaming is a delete
and a re-create.

**The catalog is frozen per run**, in its own durable step, exactly as prompts
and agents already are. A refresh mid-run cannot change what that run is doing.

**Remote tool descriptions are untrusted text that reaches your model.** They are
rendered as text and never as markup, each tool is enabled by hand, and the
connector's identity is shown beside its tools everywhere. Treat a connector the
way you would treat any third party writing into your prompts.

### One dependency, and why

The MCP SDK's `Client` compiles tool output schemas with Ajv, which uses
`new Function`, which workerd forbids. It throws inside `listTools()` — the one
call discovery cannot skip — and **only** for servers whose tools declare an
`outputSchema`, so it passes a simple smoke test and breaks on a real connector.
The SDK ships `CfWorkerJsonSchemaValidator` for edge runtimes; we always inject
it, and a test reads the source to make sure nobody constructs a bare `Client`.
That is why `@cfworker/json-schema` is required rather than optional.

## 2026-09-01 — the agent edit loop, and a health rollup

ART-111. Three tools and one argument, which together let an AI client close the
loop it could previously only describe: read a failing eval, change the agent,
and find out whether the change helped — without publishing anything.

### Action

**Wire `runAgentPreview` if you want `run_agent_preview` to work.** It is a host
hook, not SDK behavior — the SDK has no model seam of its own — so on a host that
does not supply it the tool answers `The agent playground is not configured on
this host.` and nothing else breaks. If your agent editor's playground already
works, you have it.

**Know what `--write` now grants.** It was four tools that authored and ran evals.
It is now six, and two of them touch an agent: `update_agent_draft` replaces an
agent's draft config, and `run_agent_preview` spends a model call. Neither
publishes and neither runs a live tool (below), but a token handed out as
"read/write for evals" now also edits drafts. If that is not what you meant, hand
out a session without `--write`.

**Drafts are written as your service identity.** `update_agent_draft` records a
`wf_change` row under whatever `resolveContext` returns for the MCP credential —
`svc:mcp`, if you followed §5b — and the agent editor will show an unsaved draft
that no person typed. That is the intended outcome, but somebody's editor is
going to show it.

### New

| | |
| --- | --- |
| `get_dashboard` (read) | The health rollup — failure rate, in-flight runs, spend per model, feedback queue depth, and the newest failed runs with their errors. Also reaches the **System Copilot**, which now has eighteen read tools rather than seventeen. Per-bucket chart series are dropped in the projection; the panel totals survive. |
| `update_agent_draft` (**write**) | Replace an agent's draft config. Reports every field that now differs from the published version. |
| `run_agent_preview` (**write**) | One throwaway run of an agent, **every tool simulated**. |
| `run_eval({ draftAgentId })` | Grade an agent's draft instead of its published version — `RunEvalInput.configOverride`, which the editor already used, reachable from a tool call. |

### Two things deliberately withheld

Neither is an oversight, and both are worth knowing before you ask for them.

**`publish_agent` is not in the catalog.** A published version floats into every
workflow referencing that agent, which makes it the one action in this
neighborhood that changes what your customers get. `update_agent_draft` stops one
step short on purpose: a draft is reversible, invisible to production, and
undone wholesale by the editor's discard. The model proposes; a person ships.

**`run_agent_preview` does not accept `liveToolIds`**, so a previewed run touches
nothing outside the process — the model writes stand-in tool results and they are
labelled `simulatedOutput` on every call. Your UI playground does offer live
tools, behind a per-tool toggle a person flips having read the warning; a tool
call has no equivalent of that moment, and the tools in question search real
client matters and write real records. `run_tool_preview` is absent for the same
reason, more bluntly.

### One behavior worth predicting

A draft row exists alongside nearly every agent, and publishing leaves it
matching the version it published — so `getAgent().draft !== null` is true almost
always and says nothing about whether anyone has edits in flight. Both new tools
therefore return `unsavedFields` (the config keys that actually differ from live)
and say so loudly when it is empty. Expect `run_eval({ draftAgentId })` on an
untouched agent to run and to warn, rather than to fail: the run is exactly as
valid as one without the argument, it just answers a different question than the
caller thinks it does.

---

## 2026-08-31 — headless + in-app access to the data surface

Six tickets (ART-104 → ART-111) put the same data behind two new front doors: an
MCP server for AI clients, and a rebuilt System Copilot. The host's share of that
is one auth door, one error hook, and a widened options type.

### Breaking

**`handleCopilotRequest` now takes the data route's own options type.**
`HandleCopilotOptions<TDeps>` was a narrow bag — `config: Pick<WfSdkConfig,
'getModel' | 'toolRegistry'>` plus `resolveDb` / `resolveContext` /
`resolveEnv?`. It is now `CreateWfSdkHandlersOptions<TDeps> & { defaultModelId?,
maxSteps? }`. A host passing a hand-narrowed `config` object will stop
compiling; one passing its whole `wfConfig` is already fine.

The reason is not tidiness. The copilot's tools are the `wf-mcp` tools, bound to
a `WfDataClient` that dispatches **in-process through your mounted handler** —
so the copilot needs everything the data route needs, because it *is* the data
route. Practically: pass the same object you pass `createWfSdkHandlers`, plus
`defaultModelId`.

```ts
// before
handleCopilotRequest(req, { config: { getModel, toolRegistry }, resolveDb, resolveContext })
// after
handleCopilotRequest(req, { ...sameOptionsAsCreateWfSdkHandlers, defaultModelId })
```

**The copilot's tool results changed shape.** It used to call storage accessors
directly with a hand-written list of eight tools. It now gets the shared read
catalog (seventeen tools), so it gained the eval, draft-mining, model and change
-feed reads it never had — and `get_run` returns the MCP shape: harder-clipped
fat fields, a step cap, and a `cursor` per step for `get_run_step` to drill into.
Nothing to implement; the answers your users see will be different.

### Action

**Wire `onError` on the copilot route.** New failure mode, and a silent one: the
dispatcher catches every handler fault and answers a 500, which the tool adapter
turns into a result the model reads and quietly works around. Without the hook, a
broken data call on the copilot path is a console line and nothing else. Both
routes can share one reporter.

**Add a headless credential if you want `wf-mcp`.** Your data route is gated by a
browser session, which an MCP client cannot produce. Check a bearer token
*before* your session path and resolve it to a **service identity of its own** —
never to the human who minted it, because `wf_change.actor_id` is the only
who-touched-this record 007 keeps and the change feed renders it verbatim. A
presented-but-wrong token must be a 403, not a fall-through to the session path.
Full snippet in `guide.md` §5b.

Give the copilot route its **own, stricter** `resolveContext` rather than sharing
the data route's: a bearer secret is a headless credential for reading data, and
the copilot spends model calls and answers in prose. Both are checked per tool
call, so an expiring session stops it mid-conversation.

### New

| | |
| --- | --- |
| `wf-mcp` bin | A Model Context Protocol server over the data API, stdio. `--write` is off by default, and off means the mutating tools are **not registered** — a read-only session has none to reach for. |
| `handleCopilotRequest` | Now documented (`guide.md` §5c). It was exported and undocumented before. |
| `@stevepeak/007/eval` → `runEval` | The Goal orchestrator, framework-free: `runEval`, `RunEvalInput`, `EvalMatrixModel`, `EvalMatrixPrompt`, `DEFAULT_EVAL_CONCURRENCY`, `EVAL_CONCURRENCY_CHOICES`. It lived in a React hook; nothing in it was ever browser code. Callable from a plain bun script. |

Note what `runEval` is **not**: durable. Orchestration runs in the caller's
process, so if that process exits mid-sweep the remaining cells never launch and
the umbrella run sits at `running`. A browser tab closing and a CLI being
interrupted are the same failure.

### Guarantees added

Two properties are now enforced by tests rather than by care, because both fail
silently:

- **Non-UI entry points stay free of the browser.** Every published subpath
  except `./ui*` has its transitive import closure walked; reaching `src/ui/` or
  importing `react` / `@tanstack/*` fails the build. The symptom otherwise is
  `bunx wf-mcp` dying on `document is not defined`, with every tsconfig project
  still compiling and every other test still green.
- **`guide.md`'s tool table matches the catalog.** A drifted table stays
  plausible on its own, which is exactly why it needs a test.

---

## Before this

Not recorded here. This file starts at the change above; earlier host-facing
changes are in `git log` and in `guide.md`, which has always been the integration
contract.
