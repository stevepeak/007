# Evals — build plan for `@stevepeak/007`

> **Status:** design + **navigable prototype**. A full mock-backed authoring UI is
> built (see [Implementation status](#implementation-status--prototype-ui-mock-backed));
> the backend (schema, grading, execution — Phases 1–5) is not started. This is a
> living document. The plan below is the target architecture; the prototype is what
> exists today, and the two have some intentional deltas (called out inline).

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
- **Isolation & tenancy:** there is **one host-provided `EVAL_TENANT`** (a
  platform/builder scope). It owns the `wf_eval_*` suites, owns the `wf_run` rows
  eval runs produce, **and** is the tenant targets resolve under (agents/workflows
  are authored centrally, eval'd, then shipped to firms). Tenant isolation alone
  keeps eval runs out of any firm's Runs view, so an `is_eval` flag on `wf_run` is
  **optional** (nice-to-have for filtering within the eval tenant itself).
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
  every row under the eval tenant with `simulate=true`, grade, store a **report**.

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
              │       tenantId:  EVAL_TENANT      ◀── host-owned scope       │
              │       simulate:  true            ◀── the key signal         │
              │       fixtures:  row.fixtures    ◀── canned tool outputs     │
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
   row.checks ─────────────┼──▶ gradeRow({ checks, run, steps, output, getModel })
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
workflow) → startEvalRun(EVAL_TENANT, simulate=true) → GraphWorkflow writes
wf_run trace → gradeRow(checks vs trace) → wf_eval_result → report`. The two
load-bearing seams are the **`simulate` signal** (tools self-neuter side effects,
invisible to the model) and the **real `wf_run` trace** (single source of truth
that both the RunViewer and the grader read).

---

## Key findings from the codebase (what shapes the plan)

- **The `simulate` flag has a clean 3-hop path**: `StartGraphRunInput`
  (`src/cloudflare/start-run.ts`) → the `runContext` object built at
  `start-run.ts:61` → `RunContext` (`src/engine/config.ts:67`) →
  `buildRunDeps(ctx)` → the host's `TDeps` → each tool. The SDK change is tiny and
  additive; the host's `buildRunDeps` reads `ctx.simulate` and each tool decides.
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

## Data model — new `wf_eval_*` tables

`src/storage/schema.ts` (+ generated migration via `bun run db:generate`). All
opaque-text identity, `wf_`-prefixed, indexed by `tenantId` + parent id — same
conventions as the existing nine tables.

| Table            | Purpose               | Key columns                                                                                                   |
| ---------------- | --------------------- | ------------------------------------------------------------------------------------------------------------ |
| `wf_eval_set`    | a suite               | `id`, `tenantId`, `name`, `description`, `targetKind` (`agent`\|`workflow`), `targetId`, `triggerKind`, times |
| `wf_eval_row`    | one case              | `id`, `setId`, `name`, `initialCondition` (JSON: triggerInput + promptVariables), `fixtures` (JSON: canned tool outputs keyed by toolId), `checks` (JSON tree), `sortOrder` |
| `wf_eval_run`    | one "test" execution  | `id`, `tenantId`, `status`, `setIds` (JSON), counts (`total`/`passed`/`failed`), `score` (mean 0..1), `startedAt`/`finishedAt` |
| `wf_eval_result` | per-row outcome       | `id`, `evalRunId`, `rowId`, `wfRunId` (→ the real `wf_run`), `status` (`pass`\|`fail`\|`error`), `score` (weighted mean 0..1), `checkResults` (JSON: per-check `{pass, score?, reason?}`) |

All rows are owned by the single `EVAL_TENANT` (see Tenancy). `tenantId` on
`wf_eval_set` / `wf_eval_run` is that constant, not a firm.

### Row fixtures (canned tool outputs)

Because eval runs execute under the empty `EVAL_TENANT` with `simulate=true`, a
row supplies **fixtures** — the canned data read tools return so the run is
reproducible:

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
  step 1 of the launch flow; the follow-on (safety-rail confirm: eval tenant +
  simulate ON, then create `wf_eval_run` and open the live report) is not built.
- Models come from `MOCK_MODELS` (mock catalog); at build time this becomes the
  host's real model registry (`config.listModels`).

_Supersedes the earlier set-multiselect launcher: a run is now entity-scoped and
model-fanned, not a pick-N-suites modal._

### 5. Test run report · `evals/runs/<evalRunId>`

The payoff screen. Live while running, permanent history after.

```
 Evals ▸ Runs ▸ Jul 14, 3:20pm                                    ● running 14/19
 ────────────────────────────────────────────────────────────────────────────────
  OVERALL      pass 11/14    score 0.79    started 2m ago    simulate · eval tenant
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

### Phase 1 — SDK plumbing: the `simulate` signal + fixtures (small, standalone, shippable first)

1. `src/engine/config.ts` — add to `RunContext`: `simulate?: boolean` and
   `fixtures?: Record<string, unknown>` (canned tool outputs keyed by toolId; doc:
   "eval signal — write tools no-op, read tools return their fixture").
2. `src/cloudflare/start-run.ts` — add `simulate?` + `fixtures?` to
   `StartGraphRunInput`; pass both into the `runContext` object at ~line 61.
3. `src/cloudflare/graph-workflow.ts` — thread `simulate` + `fixtures` through
   `GraphWorkflowParams.runContext` so they survive the durable boundary.
4. **Host** (`packages/wf-host/src/config.ts`) — `buildRunDeps` copies
   `ctx.simulate` and `ctx.fixtures` into `HostDeps` (e.g. a `getFixture(toolId)`
   helper). Tool branches:
   - write/side-effect tools (`send_email`, `update_document`,
     `embed_and_upsert`, …) → `if (deps.simulate) return <no-op result>`.
   - read tools (`search_knowledge_base`, …) → `if (deps.simulate) return
     deps.getFixture(id) ?? <safe empty default>`.
5. Test: a write tool no-ops and a read tool returns its fixture under `simulate`.

_Independently useful and low-risk — land it on its own._

### Phase 2 — storage & data access

- `src/storage/schema.ts` — the four tables above; export in `wfSchema`.
- `bun run db:generate` → new `migrations/0005_*.sql`.
- `src/storage/data.ts` — CRUD: eval-set, row, eval-run, result — all
  `tenantId`-scoped.
- `src/storage/assert-schema.ts` — add the new tables to the dev schema check.

### Phase 3 — grading engine (pure, testable, no Cloudflare)

- New `src/eval/grade.ts` — `gradeRow({ checks, run, steps, output, getModel }) →
  { status, score, checkResults[] }`. Deterministic checks read `wf_run_step`
  (`meta.toolId`, `meta.args`, `step.input`, node presence) + run output;
  `llm_judge` calls `getModel` and returns a scored verdict. Reduces per-check
  `pass` flags via AND/OR for `status`, and the weighted mean of `score` for the
  row `score`. Pure function over a `WfRunDetail`-shaped input → unit-testable
  with fixtures, no DB.
- Aggregation helpers (`rollupSet`, `rollupRun`) compute set/run pass rates + mean
  scores from the row results.
- New `src/eval/checks.ts` — the zod schema + evaluators. Shared with the
  `bun:test` harness.

### Phase 4 — server protocol & handlers

- `src/server/protocol.ts` — DTOs (`WfEvalSetSummary`, `WfEvalSetDetail`,
  `WfEvalRowDTO`, `WfEvalRunSummary`, `WfEvalResultDTO`) + `WfDataClient` methods:
  `listEvalSets/getEvalSet/createEvalSet/updateEvalSet/deleteEvalSet`,
  `upsertEvalRow/deleteEvalRow`, `startEvalRun`, `listEvalRuns/getEvalRun`,
  `gradeEvalResult`.
- `src/server/handlers.ts` — implement. **`startEvalRun` is an optional
  host-wired hook** (mirrors `retryRun`/`runToolPreview`): the host injects a
  callback that calls its `WORKFLOWS.startGraphRun({ tenantId: EVAL_TENANT,
  simulate: true, fixtures: row.fixtures, workflowVersionId, triggerInput,
  promptVariables })`. The host owns `EVAL_TENANT` (the platform/builder scope) —
  the SDK never mints it. Without the hook wired, the method rejects "not
  configured." The eval-data handlers (`listEvalSets`, etc.) also scope reads to
  the host-provided `EVAL_TENANT` via `resolveContext`.
- `src/server/http-client.ts` — generic over method name; likely no change.

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

Phase 0 (prototype UI) is **done**. Next: **Phase 1 alone** (clean, useful SDK
change), then 2 → 3 → 4 → 5, and finally the **remaining** Phase 6 work (report
screen + ⚡ TODOs + wiring the prototype off the mock store). Phases 2–3 are
pure/testable with no UI and can proceed in parallel with UI polish.

---

## Resolved decisions

- **Agent-eval wrapper** — ✅ auto-generate a hidden `trigger → agent → output`
  workflow per agent target (created once, cached by `targetId`). The agent node
  floats to latest, so an agent eval produces the identical trace shape as a
  workflow eval and grades through one path. No bespoke non-graph path.
- **Scoring** — ✅ pass/fail over all checks; **score from judge checks only**
  (binary checks excluded) so the number is a clean model-performance metric.
- **Tenancy** — ✅ **one host-provided `EVAL_TENANT`** (platform/builder scope)
  owns the `wf_eval_*` suites, owns the eval `wf_run` rows, and is the tenant
  targets resolve under. Tenant isolation keeps eval runs out of firms' Runs
  views, so an `is_eval` flag on `wf_run` is optional.
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
