# Evals — code review: ways to improve

A review of the eval implementation (Phases 1–6) with concrete, actionable
improvements. Ordered by priority. File references are approximate anchors, not
exact line pins. Nothing here is a blocker for the current CI-green state — these
are the sharp edges to file down before evals carry real weight.

---

## P1 — correctness / quality bugs

### 1. The LLM judge only sees the first 120 characters of the run output
`src/eval/grade.ts`, `gradeJudge()` builds the prompt with
`RUN OUTPUT:\n${preview(JSON.stringify(input.output))}`. `preview()` is the
_reason-string_ truncator — it caps at ~120 chars. So a judge grading a
paragraph-long answer scores a sentence fragment. This silently degrades every
`llm_judge` verdict.

**Fix:** don't reuse `preview()` for the judge prompt. Pass the full serialized
output (optionally capped at a much larger, explicit budget like 8–16k chars with
a "…[truncated]" marker), and consider including the trace steps too, not just the
tool-call names.

### 2. Wrapper creation races under the concurrency pool
`src/eval/wrapper.ts`, `ensureAgentEvalWrapper()` does
`findWorkflowByName()` → (miss) → `createWorkflow()`. `runEval()` in
`src/ui/hooks.ts` starts samples through a concurrency pool (default 4). If a
Goal targets an agent that has **no wrapper yet** and several of its samples start
at once, each racing `startEvalRun` misses the lookup and creates its own wrapper
— N duplicate hidden workflows, and subsequent lookups return an arbitrary one.

**Fix (pick one):**
- Add a `UNIQUE` index on `wf_workflow.name` and treat an insert conflict as
  "someone else created it — re-read." (Cleanest; the name already _is_ the cache
  key.)
- Or resolve/create the wrapper **once** before the pool fans out (e.g. a
  `prewarmTargets(setIds)` step in `runEval` that ensures each distinct agent
  target's wrapper exists, single-threaded, before starting any sample).

### 3. `checkResults` are positionally zipped to the live `CheckTree`
Both the grader output and the report (`eval-run-report.tsx`, `CheckRow`) assume
`result.checkResults[i]` corresponds to `row.checks.checks[i]`. But a result is
graded against the check tree **as it was at run time**; if the author later edits
the row's checks (adds/removes/reorders), the report re-labels old results with
the wrong assertions, and the counts can desync.

**Fix:** make each `CheckResult` self-describing — persist a stable `checkId` (or
the check's rendered label) alongside `{ pass, score, reason }`, or snapshot the
graded `CheckTree` onto the `wf_eval_result` row. Then the report joins by id, not
index, and is immune to later edits.

---

## P2 — data integrity / observability

### 4. `gradeEvalResult` is not idempotent — re-grading duplicates results
`handlers.ts` `gradeEvalResult` always `insertEvalResult(...)`. A retry (network
blip on the client loop, a manual re-grade) writes a second row for the same
`(evalRunId, rowId)`, and `getEvalRun` returns both — the report double-counts.

**Fix:** upsert by `(evalRunId, rowId)` (unique index + `onConflictDoUpdate`, or
look-up-then-update). `updateEvalResult` already exists for the update half.

### 5. Samples that fail to *start* silently vanish from the totals
`runEval()` catches per-sample errors and continues (good — one bad sample
shouldn't abort the batch), but a sample whose `startEvalRun` throws never gets a
result row. `finalizeEvalRun` then rolls up over `results` only, so `total`
becomes "samples that produced a result," not "samples attempted." A run where
half the samples failed to launch reports a clean, smaller-than-real total.

**Fix:** insert an `error`-status result (with the failure reason) when
start/poll/grade throws, so the failure is counted and visible in the report.
Keep `createEvalRun`'s `total` as the source of truth for the denominator, or
reconcile the two.

### 6. Workflow eval targets ignore the assigned version
`resolveEvalTarget()` uses `getLatestVersionId()` for workflow targets. But the
runtime has `resolveAssignedVersion()` (a workflow can pin a specific version via
`wf_workflow_assignment`). Evaluating **latest** when production runs the
**assigned** version means the eval grades a different graph than ships.

**Fix:** for workflow targets, resolve the same version production would run
(assigned, falling back to latest), matching how normal runs pick a version.

### 7. `finalizeEvalRun` always marks the run `completed`
Even a run where every sample errored ends `completed`. The umbrella status then
can't distinguish "ran clean" from "ran and everything blew up" without opening
the results.

**Fix:** derive the terminal status from the rollup — e.g. `failed` when
`errored === total && total > 0`, else `completed`. (Per-sample pass/fail stays
the primary signal; this is just the run-level summary.)

---

## P3 — robustness / polish

### 8. No server-side timeout on judge model calls
`gradeJudge` awaits `generateObject` with no `abortSignal`. The HTTP client gives
`gradeEvalResult` a 120 s budget, but a provider that ignores connection close can
hang the handler. The host's `summarizeChanges` already models the fix (race a
timer, fall back).

**Fix:** pass `AbortSignal.timeout(...)` into `generateObject`, and treat a judge
timeout as a check `error` (not a hang).

### 9. Orphaned wf_run when the client loop times out
`waitForRun()` throws after `timeoutMs`, but the `wf_run` it was polling keeps
executing on Cloudflare. The eval abandons it (no result, no cancel).

**Fix:** on timeout, either record an `error` result referencing the `wfRunId`
(so it's traceable) or expose a cancel path. At minimum, log the `wfRunId` so the
orphan is findable.

### 10. Report drops results whose row was deleted
`eval-run-report.tsx` `SetSection` filters results to `rowById.has(rowId)`. If a
sample (row) is later archived/deleted, its historical results silently disappear
from past run reports.

**Fix:** render unmatched results in an "Other / removed samples" bucket keyed by
`rowId`, so historical runs stay complete.

### 11. `gradeEvalResult`'s returned DTO uses an approximate timestamp
The handler returns `createdAt: Date.now()` rather than the row's persisted
`createdAt` (it doesn't read it back). Harmless today (the client re-fetches via
`getEvalRun`), but it's a latent inconsistency if a caller trusts the returned
value.

**Fix:** have `insertEvalResult` return the created row (or its `createdAt`), or
drop `createdAt` from the immediate return and document that `getEvalRun` is
authoritative.

### 12. `jsonpath` match mode is a lie-by-omission
`matches()` treats `jsonpath` as an alias for `equals`-at-path. It's documented,
but an author who writes a real JSONPath expression (`$.items[?(@.x)]`) gets
silent wrong behavior, not an error.

**Fix:** either implement real JSONPath, or reject/validate non-trivial JSONPath
in `evalMatchSchema` so the UI can't offer it until it's real. Renaming to
`equals_at_path` would be honest in the meantime.

---

## Testing gaps

### 13. No DB/handler round-trip tests
The pure layers are well covered (`grade`, `checks`, `wrapper`, `simulate`), but
the storage CRUD and the server handlers have **no** automated tests — they're
verified only by typecheck + migration replay. The eval flow added a lot of
stateful surface (row/run/result lifecycle, the `startEvalRun`/`gradeEvalResult`
handlers, `finalizeEvalRun` rollup).

**Fix:** stand up a lightweight `bun:sqlite`-backed `WfDb` in tests (the migration
replay already proves the schema loads there) and cover: eval set/row CRUD,
`gradeEvalResult` end-to-end against a hand-built `wf_run` trace, and
`finalizeEvalRun` math. This would have caught #4, #5, and #7 directly.

### 14. `runEval` orchestrator is untested
The concurrency pool, poll-to-completion, and error-swallowing behavior are pure
enough to test against a fake `WfDataClient`. Worth a unit test — it's the piece
most likely to regress subtly (e.g. #2's race, #5's silent drops).

---

## Smaller notes

- `RunHeader` in `eval-run-report.tsx` types its prop as
  `NonNullable<ReturnType<typeof useEvalRun>['data']>['run']` — import
  `WfEvalRunSummary` from the protocol instead; it's the same type, named.
- `simulate` write-tool neutralization returns `{ simulated: true }`. A downstream
  node that maps into a write tool's output will see that sentinel, not a
  realistic shape — fine for most graphs, but worth a fixtures escape hatch for
  write tools whose output feeds control flow.
- `deepEqual` in `grade.ts` is JSON-scoped (no `Date`/`Map`/`Set`) — correct for
  the trace, but add a one-line comment so nobody reaches for it as a general util.
- Consider an index on `wf_eval_result (eval_run_id, row_id)` — it backs both the
  idempotency fix (#4) and `getEvalRun`'s per-run fetch.
