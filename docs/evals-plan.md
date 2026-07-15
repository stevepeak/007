# Evals — build plan for `@stevepeak/007`

> **Status:** design + **navigable prototype** + **Phases 1–4 backend landed**. A
> full mock-backed authoring UI is built (see
> [Implementation status](#implementation-status--prototype-ui-mock-backed)); the
> SDK's `simulate` signal + fixtures (Phase 1), the `wf_eval_*` schema + data
> access + shared `checks` zod (Phase 2, migration `0006`), the pure grading
> engine `grade.ts` (Phase 3), and the server protocol + handlers + HTTP client
> (Phase 4) are implemented and tested. The remaining backend (host-wired
> execution orchestration — Phase 5) is not started. This is a
> living document. The plan below is the target architecture; the prototype is
> what exists today, and the two have some intentional deltas (called out inline).
>
> **⚠️ Platform change since this plan was first written — tenancy is gone.** The
> SDK no longer has any tenant partition. Migration `0005` **drops `tenant_id`**
> from `wf_run`, `wf_agent`, `wf_workflow`, and `wf_workflow_assignment`;
> `RunContext` and `StartGraphRunInput` no longer carry a `tenantId`; workflows and
> agents are a **single global set** and edit/run access is **gatekept by the host**
> (`resolveContext` now returns `{ userId }` for attribution only). This obsoletes
> the entire `EVAL_TENANT` mechanism the earlier draft leaned on — there is no
> longer a tenant to run evals "under" or to isolate them with. The tenancy-related
> passages below have been rewritten to match; the load-bearing seams (the
> `simulate` signal + fixtures, and the real `wf_run` trace) are unaffected.

## What this is

A **product surface** for authoring and running an eval/test suite against the
SDK's agents and workflows. Not to be confused with `src/eval/index.ts`
(`runWorkflowUnderConditions`), which is a _code-level_ harness for `bun:test`.
The grading logic from this feature should be shared with that harness where it
makes sense, but the surface here is a UI-driven catalog + run history.

The user's original framing:

1. User can create a new **eval set** — a test with rows of data that are tested.
2. User can initialize a new **test** — picks one or more eval sets to run, then
   inspects and views the results.
3. Each test is something like: initial condition, an agent, what tools should
   have been called, and what the output should be like.
4. Another test could be: initial condition, a workflow starting node, that
   workflow's ending node, and what the output should be.
5. Outcomes of each test can be evaluated by an agent or set to a deterministic
   result. A user may set up multiple test outcomes (e.g. this tool was called
   with this value AND/OR the agent responded with this AND/OR this node was not
   called).

## Decisions locked (from Q&A)

- **Execution:** real execution → real `wf_run` traces (rendered by the existing
  `RunViewer`). Not the mock harness.
- **Surface:** a new **Evals** tab inside `WfApp`, shipping in the SDK (reusable
  by any host). Requires new `wf_eval_*` tables, storage handlers, and
  `WfDataClient` methods.
- **Target:** a test row can target an **agent** or a **workflow**. Target is
  defined at the **set level**; rows vary only the initial condition + expected
  checks.
- **Versioning:** **float to latest** — tests always run the current
  assigned/latest version, so edits surface regressions immediately.
- **Side effects & reads:** real tools are neutralized by a **`simulate` signal
  on the run context** (NOT a tool argument, so the model can't be prompted around
  it). Under `simulate`: **write/side-effect tools no-op** (`send_email`,
  `update_document`); **read tools return canned fixtures the row supplies**, or a
  safe empty default if none. Fixtures are threaded to tools via the run context
  (`RunContext.simulate` + a `fixtures` map → `buildRunDeps` → deps), making evals
  **reproducible**. This is distinct from `buildSimulatedRegistry`
  (`src/server/simulated-tools.ts`), which LLM-fabricates every result for the
  agent playground (non-deterministic — not what evals want).
- **Isolation:** ~~one host-provided `EVAL_TENANT`~~ **superseded by the tenancy
  removal.** There is no tenant partition anymore: workflows/agents are a single
  global set, and eval runs write into the **same global `wf_run` table** as every
  other run. So isolation can no longer ride on a tenant boundary — an **`is_eval`
  marker on `wf_run` is now the primary (not optional) mechanism** to keep eval
  runs out of the general Runs explorer. Access to author/launch evals is
  **host-gatekept** (the same gate that protects all workflow/agent editing), not
  tenant-scoped. See the **Tenancy** entry under [Resolved decisions](#resolved-decisions).
- **Expectations:** **hand-authored** outcome checks (AND/OR). Each check is
  either **binary/deterministic** (e.g. a tool was called, a node received a
  given input argument) or **subjective/LLM-judged**. Binary checks are pure
  pass/fail. A judged check returns a **pass/fail AND a numeric score**.
- **Two independent signals:** **pass/fail** is the AND/OR reduction of **all**
  checks (binary + judge); **score** is derived from the **judge checks only** —
  binary checks never enter the score. The score exists to measure and compare
  **AI-model performance** across models, so structural pass/fail must not dilute
  it. Scores accumulate into the result, the set, and the run.

## Terminology

- **Eval set** — a named suite: one **target** (agent _or_ workflow,
  float-to-latest) + N **rows**.
- **Row** — one case: `initial condition` + `expected` (≥1 outcome checks).
- **Test run** (the user's "initialize a new test") — pick ≥1 eval sets, execute
  every row with `simulate=true` (marked `is_eval`), grade, store a **report**.

### UI vocabulary vs. code identifiers (deliberate split)

The **user-facing vocabulary** and the **code/schema identifiers** intentionally
diverge, and we are **not** reconciling them for now:

| Concept        | UI label (what users see) | Code / schema identifier                                  |
| -------------- | ------------------------- | --------------------------------------------------------- |
| the suite/goal | **Goal**                  | `set` — `wf_eval_set`, `setId`, `EvalSet`, `MockEvalSet`, route `evals/<setId>` |
| one case       | **Sample**                | `row` — `wf_eval_row`, `rowId` _(current UI uses `Sample`; code still says `row`)_ |
| one assertion  | **Test**                  | `check` — `checks` JSON, `MockCheck` _(UI says `Test`)_    |

Why keep the split: the UI copy evolved with the user (`Set → Goal`,
`check/outcome → Test`, `row → Sample`) while the plan's data model, routes, and
existing mock/component identifiers were written earlier against `set` / `row` /
`check`. Renaming the identifiers (tables, route segments, props, types) is a
larger mechanical refactor with no functional payoff yet, so it's **deferred**.
When the real `wf_eval_*` schema is built (Phase 2), we decide once whether to
adopt `goal` / `sample` / `test` in the identifiers too; until then, **UI speaks
Goal/Sample/Test, code speaks set/row/check.** This doc still uses the code
vocabulary (`eval set`, `row`, `check`) so it matches the schema.

---

## Implementation status — prototype UI (mock-backed)

A **navigable, mock-backed prototype of the whole authoring surface is built** and
lives under `src/ui/evals/`. It mounts inside `WfApp` (hub "Evals" card → `evals`
routes), renders through the injected UI primitives, and is driven entirely by an
**in-memory versioned store** — no schema, no server, no execution. It's designed
as a clean cut: delete `mock-data.ts` + `mock-store.ts` and swap the getters for
real hooks. Nothing outside `src/ui/evals` imports from them.

### File map

| File                                     | Role                                                                          |
| ---------------------------------------- | ----------------------------------------------------------------------------- |
| `evals-list.tsx`                         | Catalog — Goals + Test runs tabs; New goal, Run tests (stub), help            |
| `eval-set.tsx`                           | **Goal** page (folder): editable name/description, Samples + Test runs tabs   |
| `eval-sample.tsx`                        | **Sample** page: StepFlow (Target → Given → Mocks → Tests), versioned Save    |
| `eval-test.tsx`                          | **Test** page: binary/scored picker + config, versioned Save                  |
| `run-config-dialog.tsx`                  | **Run** dialog: model matrix (toggle · brand · cost · speed · best-of-N)      |
| `mock-store.ts`                          | In-memory versioned store (`useSyncExternalStore`); Goal/Sample/Test CRUD     |
| `mock-data.ts`                           | Seed goals/samples/checks · model catalog (`MOCK_MODELS`) · run-history maker |
| `shared.tsx`                             | Atoms: badges, `Tabs`, `VersionsList`, `TestRunsTable`, `BrandMark`           |
| `step-flow.tsx`                          | Layout: `StepFlow` (stacked cards) + `PickerCards` (big tile chooser)         |
| `todo-spark.tsx`                         | ⚡ inline "planned" markers → dialog describing intent                         |
| `evals-help-dialog.tsx`, `new-goal-dialog.tsx` | Help + create-goal dialogs                                              |

### What each screen does (built)

- **Catalog** (`evals`) — Goals table (name · sample count · last-run pass/score)
  and a Test runs table. Create a goal; drill into one. Catalog-level "Run tests"
  is still a stub.
- **Goal** (`evals/<setId>`) — a **folder** (unversioned): rename + edit
  description in place, archive, add sample, Run. Tabs: Samples · Test runs.
- **Sample** (`evals/<setId>/samples/<sampleId>`) — inline name/summary header;
  Configuration is a **StepFlow**: **Target** (PickerCards agent/workflow —
  workflow is _Coming soon_/disabled), **Given** (⚡), **Mocks** (⚡ Planned),
  **Tests** (list + add). **Save** mints an immutable version. Archive, Run. Tabs:
  Configuration · Test runs · Versions.
- **Test** (`…/tests/<testId>`) — inline label/description; **binary vs scored**
  chosen via PickerCards, then its config (binary type select, or judge
  rubric/threshold/weight/model). **Save** mints a version. Archive, Run. Tabs:
  Configuration · Test runs · Versions.
- **Run dialog** (every Run button) — the **model-comparison matrix**: toggle any
  of N catalog models on, set **best-of-N** attempts per model; each row shows cost
  ($/M tok) and speed (tok/s). "Next" is intentionally inert (needs the backend).
- **Test runs table** (shared, on every entity) — When · **Model** · **Cost** ·
  **Tokens** · Result · Score, with badges. Model/cost/tokens are the
  model-performance lens.

### Versioning model (as implemented in the mock store)

- **Goal = folder, not versioned** — create / rename / edit description / archive.
- **Sample & Test = independent version lineages** — **Save** mints version `N+1`
  (no draft, no publish button; dirty-tracked by JSON compare). Test membership is
  **live** (tests are parented by `sampleId`), so editing a test never bumps the
  sample. Archive is a soft `archived` flag (no restore UI yet).

### How the prototype differs from this plan (deltas to reconcile at build time)

1. **Run launcher is a model matrix, not a set picker.** The plan's §4 modal
   selected _which eval sets_ to run. The built dialog instead selects _which
   models_ to test one entity on (+ best-of-N). This sharpens the core goal —
   **evals exist to compare model performance** — and Run now lives on each
   Goal/Sample/Test. The set-multiselect launcher is **superseded**; see the
   updated §4 and the new resolved decision.
2. **Layout is StepFlow + PickerCards** (stacked "choose → configure" cards),
   not the left/right author-vs-assert split sketched in §3/§5. The two-signal
   principle (pass vs score) still holds.
3. **Workflow targets are stubbed** ("Coming soon", disabled) in the Sample Target
   picker — the prototype wires **agent** targets only, though the data model and
   plan support both.
4. **No report screen yet** — Test runs tabs render **fabricated** history only;
   there is no `evals/runs/<evalRunId>` route. §5/§6 report UI is unbuilt.
5. **No backend at all** — Phases 1–5 (simulate signal, `wf_eval_*` schema,
   grading, handlers, execution) are untouched; everything is mock/in-memory.

### Open UX TODOs marked inline (⚡ `TodoSpark`)

- **Target picker** → dropdown of real agents/workflows (icon + name), not free
  text; selecting one drives the dynamic Given and available Mocks.
- **Dynamic Given** → fields generated from the target's trigger `inputSchema` +
  prompt variables (instead of arbitrary key/value rows).
- **Mocks** → the row-level `fixtures` editor (canned tool/node outputs under
  `simulate`) — the "Tool fixtures" from §3 / the Data model.

---

## How it all fits together

```
╔══════════════════════════════════════════════════════════════════════════════╗
║  AUTHORING  (Evals tab in WfApp — persists to wf_eval_* tables)               ║
╚══════════════════════════════════════════════════════════════════════════════╝

   ┌─────────────────────── wf_eval_set ───────────────────────┐
   │  name · description                                        │
   │  targetKind: agent | workflow    targetId    triggerKind  │
   └───────────────────────────┬───────────────────────────────┘
                               │ 1
                               │ N        each row = one test case
                               ▼
   ┌─────────────────────── wf_eval_row ───────────────────────┐
   │  initialCondition (JSON) ── triggerInput + promptVariables│
   │  checks (JSON tree)      ── { op:and|or, checks:[…] }      │
   │        ├ tool_called        (toolId, called?)             │
   │        ├ tool_args_match    (toolId, path, match, value)  │
   │        ├ node_visited       (nodeId, visited?)  ← workflow│
   │        ├ node_input_match   (nodeId, path, match, value)  │
   │        ├ output_match       (path, match, value)          │
   │        └ llm_judge          (rubric, threshold, weight)   │
   └───────────────────────────────────────────────────────────┘


╔══════════════════════════════════════════════════════════════════════════════╗
║  EXECUTION   "initialize a new test"  →  wf_eval_run                          ║
╚══════════════════════════════════════════════════════════════════════════════╝

   User picks ≥1 eval sets ──▶ create wf_eval_run  (status, setIds[], counts)
                                         │
             ┌───────────────────────────┴──────────────── for each ROW ───┐
             ▼                                                              │
   ┌──── target resolution (float-to-latest) ────┐                         │
   │                                              │                         │
   │  targetKind = workflow                       │  targetKind = agent     │
   │     └▶ latest/assigned workflow version      │     └▶ src/eval/        │
   │                                              │        wrapper.ts       │
   │                                              │   generate & cache:     │
   │                                              │   trigger→agent→output  │
   │                                              │   (agent floats latest) │
   └───────────────────┬──────────────────────────┴────────────┬──────────┘
                       │  workflowVersionId                      │
                       └──────────────┬──────────────────────────┘
                                      ▼
              ┌──────────────── startEvalRun (host-wired hook) ──────────────┐
              │  createWfSdkHandlers injects it, like retryRun/runToolPreview │
              │                                                              │
              │   WORKFLOWS.startGraphRun({                                  │
              │       simulate:  true            ◀── the key signal         │
              │       fixtures:  row.fixtures    ◀── canned tool outputs     │
              │       isEval:    true            ◀── marks the wf_run        │
              │       workflowVersionId, triggerInput, promptVariables })    │
              └──────────────────────────┬───────────────────────────────────┘
                                         ▼
   ┌──────────────────── GraphWorkflow (Cloudflare, durable) ───────────────┐
   │  RunContext.simulate = true · RunContext.fixtures = {…}                │
   │        │                                                               │
   │        ▼  buildRunDeps(ctx)  ── copies simulate + fixtures → HostDeps   │
   │   ┌── node walk ──┐                                                    │
   │   │ trigger       │   tool.build(deps) reads deps.simulate:            │
   │   │ agent  ───────┼──▶  send_email  → no-op        (write)             │
   │   │ tool          │     update_doc  → skip write   (write)             │
   │   │ …             │     search_kb   → fixture ?? empty   (read)        │
   │   │ output        │   (each tool decides — NOT a model-visible arg)    │
   │   └───────────────┘                                                    │
   └───────────────────────────────┬────────────────────────────────────────┘
                                    ▼  writes the real trace
                   ┌──────────── wf_run ────────────┐
                   │  status · output · manifest    │
                   │       └── wf_run_step[]         │  ← per node fired
                   │            nodeId · nodeKind    │     meta.toolId
                   │            input · output · meta│     meta.args
                   └────────────────────────────────┘


╔══════════════════════════════════════════════════════════════════════════════╗
║  GRADING   src/eval/grade.ts  (pure — reused by bun:test harness)            ║
╚══════════════════════════════════════════════════════════════════════════════╝

   wf_run + wf_run_step[] ─┐
   row.checks ─────────────┼──▶ gradeRow({ checks, steps, output, getModel })
                           │
        binary checks read the trace:                       scored check:
          tool_called / tool_args_match  ◀─ step.meta          llm_judge
          node_visited                   ◀─ step presence      getModel(modelId)
          node_input_match               ◀─ step.input         → { pass, score,
          output_match                   ◀─ run.output              reason }
                           │
                           ▼
       { status (AND/OR of ALL pass flags),  score (weighted mean of JUDGE
         scores only — binary checks excluded),  checkResults[] }
                           │
                           ▼
   ┌──────────────── wf_eval_result ────────────────┐
   │  evalRunId · rowId                             │
   │  wfRunId ──────────────────▶ links to real run │
   │  status: pass | fail | error   score: 0..1     │
   │  checkResults[]  { pass, score?, reason? }      │
   └────────────────────────────────────────────────┘
                           │  rollupSet / rollupRun
                           ▼   (pass rate + mean score per set and per run)


╔══════════════════════════════════════════════════════════════════════════════╗
║  REPORTING   evals/runs/<evalRunId>                                           ║
╚══════════════════════════════════════════════════════════════════════════════╝

   Test run   ▸ pass 12/15   score 0.79      Row ✗  "handles refund ask"  0.55
   ├ Set A  ▸ 8/8   ✓  0.93                   ├ ✓ tool_called: issue_refund
   ├ Set B  ▸ 4/7   ✗  0.62                   ├ ✗ output_match: contains "ETA"
   └ …                                        ├ ★ llm_judge: 0.55 (thr 0.70)
                                              └──▶ [open trace] RunViewer(wfRunId)
```

**The spine in one line:** `eval set + rows → test run → (agent? wrap in
workflow) → startEvalRun(simulate=true, isEval=true) → GraphWorkflow writes
wf_run trace → gradeRow(checks vs trace) → wf_eval_result → report`. The two
load-bearing seams are the **`simulate` signal** (tools self-neuter side effects,
invisible to the model) and the **real `wf_run` trace** (single source of truth
that both the RunViewer and the grader read).

---

## Key findings from the codebase (what shapes the plan)

- **The `simulate` flag has a clean 3-hop path**: `StartGraphRunInput`
  (`src/cloudflare/start-run.ts`) → the `runContext` object built at
  `start-run.ts:59` → `RunContext` (`src/engine/config.ts:67`) →
  `buildRunDeps(ctx)` → the host's `TDeps` → each tool. The SDK change is tiny and
  additive; the host's `buildRunDeps` reads `ctx.simulate` and each tool decides.
  (This path used to also thread `tenantId`; that field is now gone — see the
  status callout — so `simulate` + `fixtures` are the only new additions.)
- **Agent targets should run through the real engine, not the `runAgentPreview`
  playground path.** `runAgentPreview` (`src/server/run-agent-preview.ts`) runs
  in-process and produces NO `wf_run` / `wf_run_step` trace — so there'd be
  nothing to assert "tool X called" / "node visited" against. The reuse trick:
  wrap the agent in a generated `trigger → agent → output` workflow (the agent
  node floats to latest). An agent eval then produces the exact same trace shape
  as a workflow eval → one grading path for both.
- **Starting runs is a host-wired hook.** The SDK's data route
  (`createWfSdkHandlers`) does not start runs today (only the host's chat route
  does, via a `WORKFLOWS` service binding). So eval-run-start must be an optional
  injected hook, mirroring the existing `retryRun` / `runToolPreview` pattern.

---

## Data model — `wf_eval_*` tables ✅ built (Phase 2, migration `0006`)

`src/storage/schema.ts` (+ generated migration via `bun run db:generate`). All
opaque-text identity, `wf_`-prefixed, indexed by parent id — same conventions as
the existing tables. **No `tenantId` column** (tenancy was removed SDK-wide, per
the status callout); these tables are part of the same global set as everything
else and are host-gatekept.

| Table            | Purpose               | Key columns                                                                                                   |
| ---------------- | --------------------- | ------------------------------------------------------------------------------------------------------------ |
| `wf_eval_set`    | a suite               | `id`, `name`, `description`, `targetKind` (`agent`\|`workflow`), `targetId`, `triggerKind`, times |
| `wf_eval_row`    | one case              | `id`, `setId`, `name`, `initialCondition` (JSON: triggerInput + promptVariables), `fixtures` (JSON: canned tool outputs keyed by toolId), `checks` (JSON tree), `sortOrder` |
| `wf_eval_run`    | one "test" execution  | `id`, `status`, `setIds` (JSON), counts (`total`/`passed`/`failed`), `score` (mean 0..1), `startedAt`/`finishedAt` |
| `wf_eval_result` | per-row outcome       | `id`, `evalRunId`, `rowId`, `wfRunId` (→ the real `wf_run`), `status` (`pass`\|`fail`\|`error`), `score` (weighted mean 0..1), `checkResults` (JSON: per-check `{pass, score?, reason?}`) |

The `wf_run` rows an eval produces set an **`is_eval` marker** (see Isolation) so
the general Runs explorer can exclude them — the job the eval tenant used to do.

### Row fixtures (canned tool outputs)

Because eval runs execute with `simulate=true` and must not depend on any live
firm's data, a row supplies **fixtures** — the canned data read tools return so
the run is reproducible:

```
fixtures = { [toolId]: cannedOutput }          // v1: one canned value per tool
```

- **v1:** keyed by `toolId` — every call to that tool in the run returns the same
  canned value. Absent tool → the tool's own safe default (usually an empty read).
- **Later:** richer matching (ordered list, or match by args) for tools called
  multiple times with different inputs. Parked.

Stored JSON, one shared zod schema (new `src/eval/checks.ts`). Checks split into
two families by how they produce a verdict:

```
{ op: 'and' | 'or', checks: Check[] }

Check =
  # ── BINARY / DETERMINISTIC ── verdict is pass|fail; score is implied (1 | 0)
  | { type: 'tool_called',      toolId, called: boolean }
  | { type: 'tool_args_match',  toolId, path?, match: 'equals'|'contains'|'jsonpath', value }
  | { type: 'node_visited',     nodeId, visited: boolean }         // workflow targets
  | { type: 'node_input_match', nodeId, path?, match: 'equals'|'contains'|'jsonpath', value }
  | { type: 'output_match',     path?, match: 'equals'|'contains'|'regex'|'jsonpath', value }

  # ── SUBJECTIVE / SCORED ── judge agent returns pass|fail PLUS a numeric score
  | { type: 'llm_judge',        rubric, modelId?, threshold?, weight? }
```

- **`node_input_match`** inspects the **resolved input a node received**
  (`wf_run_step.input` at an optional JSON path) — the general "node argument
  input checking" case. `tool_args_match` is the narrower cousin that reads the
  **args a tool was actually invoked with** (`wf_run_step.meta.args`); both ship.
- **`llm_judge`** returns `{ pass, score, reason }`. `threshold` (default e.g.
  `0.7`) maps the 0..1 score to pass/fail; `weight` (default `1`) scales its
  contribution to the accumulated score.

### Scoring model

**Pass/fail and score are two independent signals** — kept apart on purpose so the
score is a clean AI-model-performance metric, undiluted by structural checks.

Every check yields a `CheckResult { pass, score?, reason? }`:

- **Binary checks** → `pass` true/false only; **no `score`** (UI shows ✓/✗). They
  affect pass/fail, never the number.
- **Scored checks** (`llm_judge`) → `pass` (via `threshold`) **and** a `score` in
  `0..1`, plus the judge's `reason`.

Accumulation rolls up at three levels — pass/fail over **all** checks, score over
**judge checks only**:

- **Row** (`wf_eval_result`):
  - `status = pass|fail` — AND/OR reduction of **every** check's `pass` flag
    (binary + judge).
  - `score` — weighted mean of the **judge** checks' scores. A row with no judge
    checks has **`score = null`** (N/A), and is excluded from score roll-ups
    (still counted in pass rate).
- **Set**: pass rate (rows passed / total) **and** mean score over rows that have
  a score.
- **Run** (`wf_eval_run`): overall pass rate + overall mean score across scored
  rows. Because score is judge-only, the same suite run against different judge/
  target models yields directly comparable numbers.

Scores are always normalized to **0..1** internally; the UI may present them as a
percentage. A judge model is resolved via the host's `getModel` (`modelId`
optional per check, else a suite/run default).

---

## UX walkthrough

The Evals surface lives inside the existing `WfApp` shell (breadcrumbs + section
cards), reuses the agent/workflow pickers and `RunViewer`, and maps 1:1 to the
routes in Phase 6. Two design principles hold every screen together:

- **Author on the left, assert on the right** — condition vs. expectation,
  everywhere a row appears.
- **Score and pass are always two things** — pass = "did the right actions
  happen," score = "how good was it" — shown side by side from the catalog down
  to a single check.

### 1. Landing — the Evals catalog · `evals`

Clicking the **Evals** hub card lands here. A tab toggle keeps both the authored
suites and the run history one click away.

```
 Evals                                          [ + New eval set ]  [ ▶ Run tests ]
 ────────────────────────────────────────────────────────────────────────────────
  ( Eval sets )   Test runs
 ────────────────────────────────────────────────────────────────────────────────
  NAME                    TARGET                 ROWS   LAST RUN         SCORE
  ──────────────────────────────────────────────────────────────────────────────
  Intake triage           🤖 Intake agent          12   2h ago  11/12 ✓   0.91
  Refund handling         🤖 Support agent           7   2h ago   4/7  ✗   0.62
  Doc ingest pipeline     ⚙ Ingest workflow         5   1d ago   5/5  ✓   0.88
  Escalation routing      ⚙ Routing workflow         9   —        never    —
 ────────────────────────────────────────────────────────────────────────────────
```

- **Target** shows an agent (🤖) or workflow (⚙) chip — the set-level target.
- **Last run** = pass rate; **Score** = mean subjective score (the two numbers
  tracked separately).
- Row click → **set editor**. `▶ Run tests` → the **run launcher**.
- The **Test runs** tab is the same table keyed on executions:
  `when · sets included · pass rate · score · status`, click → **report**.

### 2. Set editor · `evals/<setId>`

What's under test (top) and the cases (bottom).

```
 Evals ▸ Refund handling                                        [ ▶ Run this set ]
 ────────────────────────────────────────────────────────────────────────────────
  TARGET
  ┌────────────────────────────────────────────────────────────────────────────┐
  │  Kind:  ( 🤖 Agent )  ⚙ Workflow          Target: [ Support agent  ▾ ]      │
  │  Trigger: chat_message          floats to latest published version          │
  │  Provides:  chatId · userText · messages   ← reflected from trigger schema   │
  └────────────────────────────────────────────────────────────────────────────┘

  ROWS (7)                                                          [ + Add row ]
  ──────────────────────────────────────────────────────────────────────────────
   #  NAME                     CONDITION (preview)          CHECKS   LAST
   ─────────────────────────────────────────────────────────────────────────────
   1  Simple refund ask        "I want a refund for…"        3       ✓  0.90
   2  Refund w/o order id       "refund please"              4       ✗  0.55
   3  Angry tone escalation     "this is unacceptable…"      2       ✓  0.83
   …
  ──────────────────────────────────────────────────────────────────────────────
```

- Changing **Kind** swaps the target picker between agents and workflows; the
  **Provides** line re-reflects from that trigger's `inputSchema` so row authoring
  knows which fields exist.
- Row click → **row editor**. `LAST` shows the most recent result for that row so
  flaky rows stand out.

### 3. Row editor · `evals/<setId>/rows/<rowId>` (full page or right drawer)

Input on the left, expectations on the right.

```
 Refund handling ▸ Row 2 · "Refund w/o order id"                          [ Save ]
 ────────────────────────────────────────────────────────────────────────────────
  INITIAL CONDITION                    │  EXPECTED OUTCOMES        ( All ▾ of… )
  ─────────────────────────────────────┼──────────────────────────────────────────
  Trigger input                        │  ✓ tool_called                    [binary]
   chatId       [ c_test_2         ]   │     issue_refund · called = false
   userText     [ refund please    ]   │  ─────────────────────────────────────────
   messages     [ [] (empty)       ]   │  ✓ node_input_match               [binary]
                                       │     node: ask_order_id
  Prompt variables                     │     input.reason contains "missing id"
   userId       [ u_test           ]   │  ─────────────────────────────────────────
                                       │  ★ llm_judge                      [scored]
  Tool fixtures (canned reads)         │     rubric: "asks for the order id
   search_kb    [ {docs:[…]}      ]    │     politely, no refund promised"
   lookup_order [ {found:false}   ]    │     threshold 0.7 · weight 1
              [ + Add fixture ▾ ]      │  ─────────────────────────────────────────
                                       │                        [ + Add check ▾ ]
```

- **Left** is a form reflected from the target's trigger schema (same reflection
  as the New-workflow dialog) + `promptVariables`, plus **Tool fixtures** — the
  canned outputs read tools return under `simulate` (see Row fixtures). Add one
  per tool the target may call; omit and the tool falls back to a safe empty read.
- **Right** is the check builder. Top toggle = the AND/OR reducer ("All of…" /
  "Any of…"). `+ Add check ▾` opens the type menu:

```
   + Add check
   ─────────────────────
   Deterministic
     tool called / not called
     tool args match
     node visited / not visited
     node input match
     output match
   Subjective
     LLM judge (scored)
```

Each check expands inline to edit its params. Binary checks are tagged `[binary]`
and render ✓/✗ at grade time; the judge is tagged `[scored]` and carries rubric +
threshold + weight.

### 4. Run configuration — the model matrix (modal from any `▶ Run`)

**Built (as `run-config-dialog.tsx`).** Launched from the Run button on a Goal,
Sample, or Test. A run targets **that one entity** and fans it out across a
**user-chosen set of models**, each with an optional **best-of-N** attempts — the
concrete expression of the judge-only score (line the same suite up against several
models, read the scores side by side).

```
  ┌──────────── Run configuration ─────────────── Refund handling ─┐
  │  Choose the models to test this sample on                      │
  │  ────────────────────────────────────────────────────────────  │
  │  TEST   MODEL                     COST      SPEED    BEST OF N  │
  │   ☑    🟢 OpenAI 5.1             $5.00/M    82 tok/s   − 1 +    │
  │   ☐    🟢 OpenAI 5.1 mini        $1.20/M   145 tok/s   − 1 +    │
  │   ☑    🟠 Claude Opus 4.8        $9.00/M    64 tok/s   − 3 +    │
  │   ☐    🔵 Gemini 3 Pro           $3.50/M   110 tok/s   − 1 +    │
  │   …                                                            │
  │  ────────────────────────────────────────────────────────────  │
  │  2 models selected                        [ Cancel ]  [ Next ] │
  └────────────────────────────────────────────────────────────────┘
```

- Each row: an on/off **toggle**, a **brand mark + model name**, **cost** ($/M
  tokens), **speed** (tok/s), and a **best-of-N** stepper (enabled once selected).
- **Next** is intentionally **disabled** until the backend exists — this screen is
  step 1 of the launch flow; the follow-on (safety-rail confirm: **simulate ON**,
  then create `wf_eval_run` and open the live report) is not built.
- Models come from `MOCK_MODELS` (mock catalog); at build time this becomes the
  host's real model registry (`config.listModels`).

_Supersedes the earlier set-multiselect launcher: a run is now entity-scoped and
model-fanned, not a pick-N-suites modal._

### 5. Test run report · `evals/runs/<evalRunId>`

The payoff screen. Live while running, permanent history after.

```
 Evals ▸ Runs ▸ Jul 14, 3:20pm                                    ● running 14/19
 ────────────────────────────────────────────────────────────────────────────────
  OVERALL      pass 11/14    score 0.79    started 2m ago    simulate · is_eval
  ══════════════════════════════════════════════════════════════════════════════

  ▾ Refund handling            4/7  ✗     score 0.62
     ✓  Simple refund ask                 0.90
     ✗  Refund w/o order id               0.55   ← 1 of 3 checks failed
     ✓  Angry tone escalation             0.83
     ⏳ Partial refund                     running…
     …
  ▸ Intake triage              7/7  ✓     score 0.93
 ────────────────────────────────────────────────────────────────────────────────
```

- Grouped by set, each with its own pass rate + mean score; overall banner on top.
- Rows stream in with a spinner → resolve to ✓/✗ + score as each real run
  finishes and grades.
- Row click → **row result detail**.

### 6. Row result detail (drawer over the report)

```
  ┌──── Refund w/o order id ─────────────────────── ✗ fail · score 0.55 ────┐
  │  CHECKS                                                                  │
  │   ✓  tool_called   issue_refund = false                                 │
  │   ✗  node_input_match   ask_order_id.reason contains "missing id"        │
  │        actual: "no order number provided"                               │
  │   ★  llm_judge   0.55  (threshold 0.70)                                  │
  │        "Asks for the id but also implies a refund is coming, which the   │
  │         rubric forbids."                                                 │
  │  ───────────────────────────────────────────────────────────────────    │
  │  INITIAL CONDITION   userText: "refund please" · …                      │
  │                                                        [ Open trace ▸ ]  │
  └──────────────────────────────────────────────────────────────────────────┘
```

- Binary checks show ✓/✗ with the **actual** value on failure (so you see *why*).
- The judge shows its **score vs threshold** and its **reason** — the subjective
  explanation is first-class.
- **Open trace** drops into the embedded `RunViewer` for that row's real `wf_run`
  — the exact node-by-node execution the checks were graded against.

The full loop: **catalog → set editor → row editor → launcher → live report →
row detail → trace**.

---

## Phases

### Phase 0 — prototype UI (DONE, mock-backed)

The whole authoring surface — catalog, Goal, Sample, Test, versioning, and the Run
model-matrix dialog — is built against an in-memory store (see
[Implementation status](#implementation-status--prototype-ui-mock-backed)). This
front-ran Phase 6 to pin down the UX. What it leaves for the real build: the report
screen, the three ⚡ TODOs (Target dropdown, dynamic Given, Mocks/fixtures), workflow
targets, and wiring every Run/Save/Test-runs surface to real data + execution.

### Phase 1 — SDK plumbing: the `simulate` signal + fixtures ✅ DONE

**Shipped.** The neutering is **SDK-metadata-driven**, which refined the original
draft (below): instead of each host tool checking `deps.simulate` itself, tools
declare a `sideEffect` and the SDK enforces one policy in one place — so a new
tool can never silently forget to neuter.

- `src/engine/config.ts` — `RunContext` gained `simulate?: boolean` +
  `fixtures?: Record<string, unknown>`.
- `src/cloudflare/start-run.ts` — `StartGraphRunInput` gained `simulate?` +
  `fixtures?`; both flow into the `runContext` object.
- `src/cloudflare/graph-workflow.ts` — `GraphRunContextInput` carries both across
  the durable boundary; both `RunNodeContext` build sites (single-node + iteration
  subgraph) forward them.
- `src/engine/tool-registry.ts` — **the policy.** `ToolMeta` gained
  `sideEffect?: 'read' | 'write'`; a pure `simulatedToolOutput(meta, ctx)` returns
  the canned outcome (write → `{ simulated: true }`; read → `fixtures[id] ?? {}`)
  or `undefined` to run for real. Applied in `buildAgentToolSet` (swaps the AI
  tool's `execute`, leaving its schema so the model still "sees" and can call it)
  and in `nodes/tool.ts` (short-circuits both function- and ai-tool Tool nodes).
  **Untagged tools run for real even under simulate** — reserved for pure/compute
  tools (e.g. `chunk_text`). The call is still recorded (`meta.toolId`/`args`) so
  a grader can assert it happened.
- `src/engine/run-node.ts` / `nodes/agent.ts` / `executor.ts` — thread
  `simulate`/`fixtures` down to the two node executors (in-process + durable).
- `src/eval/index.ts` — the `runWorkflowUnderConditions` harness passes both from
  `tc.runContext`, so grading and tests exercise the same path.
- **Host** (`packages/wf-host/src/config.ts`) — the only host change is **tagging
  each tool**: reads (`get_document`, `search_knowledge_base`,
  `read_client_memory`) → `sideEffect: 'read'`; writes (`update_document`,
  `manage_client_memory`, `embed_and_upsert`, `prune_document_chunks`) →
  `'write'`; `chunk_text` left untagged. No `buildRunDeps`/`getFixture` change was
  needed — the SDK reads the signal off `RunContext`, not off the opaque deps.
- **Tests** — `src/eval/simulate.test.ts` (5 cases): write no-ops, read returns
  its fixture, read with no fixture → `{}`, untagged tool runs for real, and no
  `simulate` → the write really runs. Full engine+eval suite, typecheck, and lint
  green in both `007` and `wf-host`.

<details><summary>Original draft (superseded by the metadata approach above)</summary>

> 4. Host `buildRunDeps` copies `ctx.simulate`/`ctx.fixtures` into `HostDeps` (a
>    `getFixture(toolId)` helper) and each tool branches on `deps.simulate`.

This per-tool approach was rejected: it touches every `create*Tool` and is easy
to forget on a new tool. The registry `sideEffect` tag is enforced centrally.
</details>

### Phase 2 — storage & data access ✅ DONE

**Shipped** in migration `0006_safe_wallflower.sql` (all seven migrations replay
cleanly against a fresh SQLite; the four tables + the `is_eval` column exist).

- `src/storage/schema.ts` — the four `wf_eval_*` tables (`wf_eval_set`,
  `wf_eval_row`, `wf_eval_run`, `wf_eval_result`), exported in `wfSchema`. No
  tenant column (tenancy removed). Enums: `WF_EVAL_TARGET_KINDS`,
  `WF_EVAL_RESULT_STATUSES` (eval-run status reuses `WF_RUN_STATUSES`). Score
  columns are `real` (nullable → judge-only, N/A when a row has no judge check).
  **Also added `is_eval` to `wf_run`** (+ a `(is_eval, created_at)` index) — the
  isolation marker that replaces the old eval tenant.
- `src/eval/checks.ts` (**new**) — the shared zod schemas + inferred types for the
  `checks` tree, `initialCondition`, `fixtures`, and `CheckResult`. Validated at
  the data-access boundary on every row upsert; reused by the Phase 3 grader.
  (This front-runs the doc's original Phase 3 placement of `checks.ts` — only the
  *shapes* live here; the evaluators still land in Phase 3's `grade.ts`.)
- `src/storage/data.ts` — full CRUD, no tenant scoping: `listEvalSets`
  (with live row counts) / `getEvalSet` (set + ordered rows) / `createEvalSet` /
  `updateEvalSet` / `deleteEvalSet`; `upsertEvalRow` (validates JSON) /
  `deleteEvalRow` (soft-archive); `createEvalRun` / `updateEvalRun` (roll-up
  counts + score) / `listEvalRuns` / `getEvalRun` (run + results);
  `insertEvalResult` / `updateEvalResult` (attach `wfRunId` + graded verdict).
  Plus `createRun` now takes `isEval?`, `StartGraphRunInput` carries it, and
  `listRuns` **excludes eval runs by default** (`includeEval?` opts in).
- `src/storage/assert-schema.ts` — the dev probe now also selects from
  `wf_eval_set`, so a DB migrated before `0006` gets the same actionable error.
- **Tests** — `src/eval/checks.test.ts` (7 cases): every binary + judge check
  parses, unknown types and out-of-range thresholds reject, the AND/OR tree and
  initial-condition/result shapes validate. Typecheck + lint green; migration
  replay verified.

### Phase 3 — grading engine (pure, testable, no Cloudflare) ✅ DONE

**Shipped** in `src/eval/grade.ts` + `grade.test.ts` (17 cases). Pure — no DB, no
Cloudflare; deterministic checks read a hand-built trace, judge checks use a
`MockLanguageModelV3`.

- `gradeRow({ checks, steps, output, getModel?, defaultJudgeModelId? }) →
  { status, score, checkResults[] }`. Deterministic checks read the trace
  synchronously; `llm_judge` awaits `generateObject` via `getModel`. Judge checks
  resolve concurrently (`Promise.all`).
- **Tool-call extraction handles BOTH shapes** — a workflow Tool node (top-level
  `tool` step, `meta.{toolId,args}`) *and* calls made inside an Agent node
  (`meta.steps[].toolCalls[]`, `toolName`/`input`). So an agent-eval and a
  workflow-eval grade `tool_called`/`tool_args_match` through one path — the
  payoff of the Phase 1 agent-wrapper design.
- **Two signals kept apart**: `status` is the AND/OR reduction of *every* check's
  pass flag (empty tree → pass); `score` is the **weighted mean of judge scores
  only** (binary checks excluded), `null` when a row has no judge check. A judge
  failure (model error / missing model) marks the whole row `status: 'error'`.
- Binary matchers: `equals` (deep), `contains` (substring/array membership),
  `regex`; `jsonpath` is a v1 alias for `equals` after `path` selection (richer
  JSONPath matching parked in the ideas list). Failure `reason`s carry the actual
  value for the report's "why it failed" line.
- Aggregation: `rollup(results)` → `{ total, passed, failed, errored, passRate,
  meanScore }` (mean over judge-scored rows only); `rollupSet`/`rollupRun` are
  named aliases.
- `src/eval/checks.ts` (the zod schema + types) was already built in Phase 2 and
  is shared with the `bun:test` harness; Phase 3 added the evaluators here.

### Phase 4 — server protocol & handlers ✅ DONE

Landed: the wire protocol, server dispatch, and browser client for the whole
eval surface. All typecheck/lint clean; the pieces they wrap (data CRUD via
migration `0006`, `grade.ts` via unit tests) are already covered.

- `src/server/protocol.ts` — DTOs `WfEvalSetSummary` / `WfEvalSetDetail` /
  `WfEvalRowDTO` / `WfEvalRunSummary` / `WfEvalResultDTO` / `WfEvalRunDetail`
  (plus `WfEvalTargetKind`, `WfEvalResultStatus`), and re-exports the pure eval
  types (`CheckTree`, `CheckResult`, `EvalCheck`, `EvalMatch`, `EvalFixtures`,
  `EvalInitialCondition`) from `../eval/checks` so the UI imports them from one
  place. `WfDataClient` gained: `listEvalSets/getEvalSet/createEvalSet/
  updateEvalSet/deleteEvalSet`, `upsertEvalRow/deleteEvalRow`, `createEvalRun`,
  `startEvalRun`, `gradeEvalResult`, `finalizeEvalRun`, `listEvalRuns/getEvalRun`.
  (`createEvalRun`/`finalizeEvalRun` weren't in the original list but are what the
  client-driven loop needs to open and close the umbrella run.)
- `src/server/handlers.ts` — all methods implemented. Two are **not** plain data:
  - **`startEvalRun` is an optional host-wired hook** (mirrors `retryRun`): the
    SDK resolves the row + its set's target (`getEvalRow`) and hands the host a
    descriptor `{ evalRunId, rowId, target:{kind,id}, triggerKind, triggerInput,
    promptVariables, fixtures }`; the host resolves the target to a runnable
    version (for an agent target, the Phase-5 wrapper) and starts a run with
    `simulate:true, isEval:true` and the row's fixtures, returning the `wf_run`
    id. Without the hook wired, the method rejects "not configured." The first
    started row flips the umbrella run `queued → running`.
  - **`gradeEvalResult` is pure SDK** (no hook): loads the finished `wf_run`
    trace (`getRun`), maps steps → `GradeStep[]`, runs `gradeRow` (judge checks
    resolve their model through the host's `config.getModel` seam; the default
    judge model is `evalJudgeModelId ?? listModels()[0]`), and persists the
    verdict via `insertEvalResult`. `finalizeEvalRun` rolls the results up
    (`rollup`) into the run's counts/score + `status:'completed'`.
  - The eval-data handlers need no tenant scoping — like every other data handler
    they operate on the global set, gatekept by the host at the route
    (`resolveContext` returns `{ userId }` for attribution only).
- `src/server/http-client.ts` — thin `call(method, params)` wrappers; the
  launch/grade methods get the longer 120 s budget (real runs + model calls).
- `getEvalRow(db, rowId)` added to `storage/data.ts` — one row + its set's
  target/trigger identity, so `startEvalRun`/`gradeEvalResult` launch and grade a
  row without a separate set fetch.
- `src/server/index.ts` re-exports the new DTOs + eval types for hosts/UI.

### Phase 5 — execution orchestration

- **Agent target → generated wrapper workflow.** New `src/eval/wrapper.ts`:
  ensure a `trigger(manual) → agent(agentId) → output` workflow+version exists
  (created once per agent target, cached by `targetId`). Workflow targets run
  their assigned/latest version directly.
- **Orchestration (v1 = client-driven):** the Evals UI starts each row via
  `startEvalRun` (passing the row's `fixtures`), watches completion via existing
  `getRun` polling / `RunViewer` socket, then calls
  `gradeEvalResult(evalRunId, rowId, wfRunId)`. Concurrency-capped in the client.
  - _Later alternative:_ a durable `EvalRunRoom`/orchestrator DO so a test run
    survives a closed tab. Deferred.

### Phase 6 — UI (the new tab)

**Mostly built as the Phase 0 prototype** — the remaining work is (a) the report
screen, (b) the three ⚡ TODOs, (c) workflow targets, and (d) replacing the mock
store with real hooks.

- **Built** (`src/ui/wf-app.tsx` routes + hub card, components under
  `src/ui/evals/`): catalog (`evals-list.tsx`), Goal (`eval-set.tsx`), Sample
  (`eval-sample.tsx`), Test (`eval-test.tsx`), Run model-matrix
  (`run-config-dialog.tsx`), versioned mock store, shared atoms. Routes today:
  `evals`, `evals/<setId>`, `evals/<setId>/samples/<sampleId>`,
  `…/tests/<testId>`.
- **Still to build:**
  - `eval-run-report.tsx` + route `evals/runs/<evalRunId>` — per-row pass/fail
    **and score**, per-check verdicts (✓/✗ binary, score + judge reason for
    scored), embedded `RunViewer` link to the real `wf_run`; set/run pass rates +
    mean scores. (The per-entity "Test runs" tabs then link into it.)
  - ⚡ **Target picker** (dropdown of real agents/workflows), ⚡ **dynamic Given**
    (reflected from the target trigger's `inputSchema`, reusing
    `new-workflow-dialog`'s field reflection), ⚡ **Mocks/fixtures** editor.
  - **Workflow targets** — un-stub the Sample Target picker's Workflow tile.
  - Wire **Run "Next"**, **Save**, and **Test runs** tabs to real data + execution.
- `src/ui/hooks.ts` — React Query hooks for the new methods; **delete**
  `mock-store.ts` + `mock-data.ts` when they land.
- `src/index.ts` / `src/eval/index.ts` — export the pure grading utils.

---

## Deliberately NOT in v1

- Durable orchestrator (client loop first).
- Pinned versions / two-run diff view (float-only; history is a flat list first).
- Golden-snapshot authoring (hand-authored only).
- Set-level mixed targets.

## Suggested landing order

Phases 0–4 are **done** (prototype UI; the `simulate` signal + fixtures; the
`wf_eval_*` schema + data access + `checks` zod; the pure `grade.ts` engine; and
the server protocol + handlers + HTTP client). Next: **Phase 5** (execution
orchestration — the agent→wrapper-workflow, wiring the host's `startEvalRun` hook
in the 1121law app, and the client-driven run/grade loop), and finally the
**remaining** Phase 6 work (report screen + ⚡ TODOs + wiring the prototype off
the mock store).

---

## Resolved decisions

- **Agent-eval wrapper** — ✅ auto-generate a hidden `trigger → agent → output`
  workflow per agent target (created once, cached by `targetId`). The agent node
  floats to latest, so an agent eval produces the identical trace shape as a
  workflow eval and grades through one path. No bespoke non-graph path.
- **Scoring** — ✅ pass/fail over all checks; **score from judge checks only**
  (binary checks excluded) so the number is a clean model-performance metric.
- **Tenancy** — ⛔️ **superseded — there is no tenant anymore.** The earlier
  decision (one host-provided `EVAL_TENANT` owning suites, eval runs, and target
  resolution) is void: tenancy was removed SDK-wide (migration `0005` drops every
  `tenant_id`; workflows/agents are a single global set, host-gatekept). Evals now
  live in that same global set. Isolation from the general Runs explorer rides on
  an **`is_eval` marker on `wf_run`** (promoted from optional to the primary
  mechanism), not a tenant boundary. See the status callout at the top.
- **Read tools under simulate** — ✅ return the row's **canned fixtures** (or a
  safe empty default), so evals are reproducible and self-contained; no dependence
  on live firm data. Write tools no-op.
- **UI vocabulary ≠ code identifiers (deferred rename)** — ✅ the UI says
  **Goal / Sample / Test**; the code + schema keep **set / row / check**
  (`wf_eval_set`, `setId`, `EvalSet`, `MockCheck`, route `evals/<setId>`, …). The
  identifier rename is a mechanical refactor with no functional payoff yet, so it
  is **not** being done now — revisit when the real `wf_eval_*` schema is built
  (Phase 2). See [Terminology → UI vocabulary vs. code identifiers](#ui-vocabulary-vs-code-identifiers-deliberate-split).
- **Run = entity-scoped model matrix** — ✅ a run is launched from **one** entity
  (Goal / Sample / Test) and fanned across a **user-chosen set of models**, each
  with an optional **best-of-N** attempts. This is the operational form of the
  judge-only score (compare models on the same suite). **Supersedes** the earlier
  §4 "pick which sets to run" launcher. Built as `run-config-dialog.tsx`; "Next" is
  inert pending the backend.
- **Versioning shape** — ✅ **Goal = folder** (unversioned); **Sample & Test = two
  independent version lineages**, **Save** mints version `N+1` with **no
  draft/publish** step; editing a test never bumps its sample (test membership is
  live by `sampleId`). Archive is a soft flag. Implemented in the mock store; the
  real `wf_eval_*` schema must carry the same shape.

## Open questions

_(none currently — all resolved above)_

## Ideas parking lot (to expand)

- **Best-of-N aggregation (opened by the Run matrix).** The Run dialog lets a user
  request _N attempts per model_. This needs a defined roll-up: is a model's score
  the **best**, **mean**, or **median** of its N attempts? Is pass/fail "passed if
  any attempt passed" or "if all did"? Likely surface **best score + pass@k**.
  Also implies the report is a **model × sample grid** (compare models per row),
  not a single-run list — the model-comparison payoff the whole feature is for.
- **Model registry wiring.** Replace `MOCK_MODELS` with the host's real
  `config.listModels`, carrying cost + speed metadata (or fetch/estimate it).
- **Show-archived / restore.** Archive is a soft flag today with no restore UI.
- _Capture additional ideas here before implementation._
