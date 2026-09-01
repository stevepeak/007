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
