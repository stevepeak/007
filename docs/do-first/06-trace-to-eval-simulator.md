# 6 — Trace-to-eval-case + local mock-model simulator

**Impact: High · Effort: S · Status: both are ~50% built — this is finishing and
surfacing, not greenfield.**

Two DX features that turn production runs into a testing flywheel:

1. **Trace-to-eval-case** — one click to turn any production run into an eval /
   regression test case with an expected output.
2. **Local mock-model simulator** — run a workflow locally against mock models
   and canned tool outputs, with no D1 and no Cloudflare, for fast iteration.

**Leverage:** the in-process executor already *is* the simulator, and the
trace→eval UI already exists in skeleton — the work is closing both loops.

## Current state (audit)

- **Simulator: the engine already exists.** `eval/index.ts` →
  `runWorkflowUnderConditions()` runs any graph through `executeWorkflow` with a
  host config (point `getModel`/`toolRegistry` at mocks), an in-memory recorder,
  and a memory sink — returning `{ output, steps, progress }`. `RunContext`
  already carries `simulate` (neutralizes side-effecting tools) and `fixtures`
  (canned tool outputs keyed by tool id), honored in `run-node.ts`. What's
  missing is a *first-class dev entry point* — right now it's a test helper, not
  a runner someone reaches for locally.
- **Trace-to-eval: skeleton exists.** `ui/evals/create-sample-from-run.tsx` and
  `ui/evals/` already start the "make an eval sample from a run" flow; the eval
  check/fixture schemas exist (`eval/checks.ts`, `evalFixturesSchema`). What's
  missing is the end-to-end wiring: run → captured inputs/tool-outputs/expected
  output → a persisted eval row that re-runs.

## Plan

### A. Finish trace-to-eval-case

- From a persisted `wf_run` + its `wf_run_step` trace, build an eval case:
  - **trigger input** → the eval case's input.
  - **tool outputs** from the steps → `fixtures` (so the replay is deterministic
    without live tools), reusing `evalFixturesSchema` and the existing
    `simulate` path.
  - **final output** → the expected output / the seed for an LLM-judge check
    (synthesis mode already grades a final response in isolation — reuse it).
- Persist as an eval sample in the existing `wf_eval_*` tables via the eval data
  layer, so it shows up in the eval sets UI and re-runs on demand.
- Finish `create-sample-from-run.tsx`: capture-and-save action from the run
  viewer → new eval sample; confirm it round-trips (create → list → run → grade).
- **One-click "add to regression set"** from any run in the runs explorer.

### B. Surface the local simulator as a dev runner

- Add a CLI entry (alongside `src/cli/dump-run.ts` / `spec.ts`) e.g.
  `bun packages/007/src/cli/simulate.ts <graph.json>` that calls
  `runWorkflowUnderConditions` with a mock model + fixtures and prints the step
  trace + output. No D1, no CF.
- Document the pattern in `guide.md` (the README already shows the eval snippet)
  as the *recommended local iteration loop*: edit graph → simulate → inspect
  trace, before ever deploying.
- Optionally a `--fixtures fixtures.json` flag so a captured trace (from A) feeds
  the simulator directly — closing the loop: capture a real run → replay it
  locally deterministically.

### C. (Small, high-value adjunct) CI gate

- Because A produces persisted eval cases and B can run them headless, add a
  `runEvalSet()` helper that runs a set and returns pass/fail — so a host can
  gate deploys on eval regression. Cheap once A+B exist.

## Effort & risks

- **S.** Both halves are mostly wiring existing pieces:
  `runWorkflowUnderConditions` + `simulate`/`fixtures` + `create-sample-from-run`
  + the `wf_eval_*` tables already exist.
- Risk: fixture capture must record tool outputs faithfully from the step trace
  (including blob-ref'd values — resolve or note them) so the replay matches.
- Risk: keep the CLI out of the published runtime surface (dev-only, like the
  existing `cli/` tools).

## Acceptance criteria

- From a completed run in the run viewer, "Save as eval case" creates a persisted
  eval sample whose fixtures reproduce the run's tool outputs, and re-running it
  in the eval UI reproduces the original output.
- `bun …/cli/simulate.ts <graph.json>` runs a workflow locally against a mock
  model and prints the trace + output with no D1/CF.
- A captured fixtures file replays the same run deterministically through the
  simulator.
