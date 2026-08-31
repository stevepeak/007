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
