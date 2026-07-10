# `@app/wf-sdk` — next wave

A running punch-list of incomplete work and improvements in the workflows SDK
and its host (`@app/wf-host`, `@app/tools`). Ordered roughly by impact. Item #1
(finish the document-ingestion workflow) is **in progress** and tracked
separately in the code; everything below is queued.

---

## Feature completion

### 2. Iteration observability — surface per-item results in the UI

The engine records a whole iteration as **one** `wf_run_step` (inner sub-node
steps are not individually recorded), and `RunViewer` (`ui/run-viewer.tsx:59-72`)
only renders generic input/output. So the iteration `meta` (per-item statuses,
concurrency, and the `__iterationError` placeholders produced when
`stopOnError: false`) is invisible — a failed item silently becomes
`{ __iterationError }` inside the output array.

- Add iteration-aware rendering to `StepRow`: an item grid with per-item
  status + failure flags, reading `step.meta.items`.
- Decide whether inner sub-node steps should be recorded for drill-down
  (`engine/nodes/iteration.ts` + `cloudflare/graph-workflow.ts` currently do not
  record them), and whether the shared progress `sink` interleaving across
  parallel items needs per-item channels.

### 6. Build the Evals surface (or stop advertising it)

The hub shows an "Evals" card badged **"Not implemented yet"**
(`ui/wf-hub.tsx:80-92`) even though the eval engine
(`eval/index.ts` — `runWorkflowUnderConditions`) already exists. Either build the
test-runner UI on top of it (saved cases, expected outputs, pass/fail) or hide
the card until it's real.

### 7. Wire up the Agent playground — **done**

The playground panel in `ui/editor/agent-editor.tsx` runs the editor's **live
draft** config in isolation against a scratch input and renders the final answer
plus the per-step thinking/tool-call trace. Wiring: a host-injected
`runAgentPreview` handler (mirrors `summarizeChanges`) delegates to the SDK
helper `executeAgentPreview` (`server/run-agent-preview.ts`), which drives the
real `executeAgentNode` via a synthetic one-entry manifest. Blocking v1 (one
POST returns the full trace; the client uses a 120s budget). _Follow-up: true
SSE streaming so steps appear live rather than all at once._

### 9. Let downstream nodes bind into iteration element fields

The iteration output is a single opaque `array` leaf (`ui/editor/node-io.ts:186-190`),
so downstream nodes cannot reference per-element fields. Consider surfacing the
element shape (from the subgraph's Output/Result node) for binding.

---

## Test coverage (suite is green today, but thin in risky spots)

### 4. Test `branch.ts` operator predicates — highest-value gap

All 7 deterministic operators (`equals`, `not_equals`, `contains`,
`greater_than`, `less_than`, `is_empty`, `is_not_empty`) in `evaluate()`
(`engine/nodes/branch.ts:106-124`) are **never** tested — the scheduler tests
fake the branch result. Pure, high-risk logic (string-vs-numeric comparison is
easy to get subtly wrong). Also cover path resolution + JSON/scalar coercion.

### 5. Test `judge.ts` and `agent-output.ts`

- `engine/nodes/judge.ts` — the LLM routing classifier has **zero** coverage; a
  regression silently mis-routes workflows. Mockable with `MockLanguageModelV3`
  like the existing agent eval.
- `engine/agent-output.ts` (304 lines) — a hand-written Zod-source
  tokenizer/parser (`tokenize`, `Parser`, `compileZodSource`) with zero tests.
- Follow-ups: `engine/binding.ts` (`resolvePath`/`resolveBinding` edge cases) and
  deeper `agent.ts` behavior (multi-turn tool loops, structured `generateObject`
  output modes, `exposeThinking`). Longer-term: `storage/data.ts` and
  `server/handlers.ts` have no direct tests.

---

## Housekeeping

### 8. Iteration editor — guard consistency & resize roundtrip

`ui/editor/workflow-canvas.tsx`:

- A **new** iteration node from the palette can be dropped into an existing
  container (only `handleNodeDragStop` guards this at `:366`, not `onDrop` at
  `:490-510`), so nested iteration is blocked only at schema validation, not at
  interaction. Add the same early-return to `onDrop`.
- A bookend (`Item`/`Result`) can be dragged into a **different** container
  (`:378` doesn't exclude bookends). Low likelihood, unguarded.
- Resize writes `data.config.width/height` but leaves the node `style` stale
  until reload (`node-renderers.tsx:337-357`). Verify resize→save→reload and
  inner-node-delete edge cleanup.

### 10. Fix stale docs & dedupe constants

- `README.md` (bottom) points readers to `plan.md` and `wf-TODO.md` — `plan.md`
  never existed; this file now covers the latter. Reconcile the reference.
- Dedupe magic numbers duplicated across the engine schema and the UI:
  concurrency `max=20` in both `engine/graph.ts` and
  `ui/editor/node-inspector.tsx:274`; the iteration container default dimensions
  in `ui/editor/workflow-canvas.tsx:56-57`.
