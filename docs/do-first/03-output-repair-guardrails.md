# 3 — Structured-output repair + guardrail node

**Impact: High · Effort: S–M · Status: greenfield (agent structured output
exists; repair + guardrails do not).**

Two related reliability/safety features:

1. **Structured-output repair** — when an agent's structured output fails its
   JSON-Schema contract, run a repair pass (re-ask with the validation error, or
   a fixer model) instead of failing the run.
2. **Guardrail node / rails** — input- and output-rail checkpoints that validate
   before/after an agent and block, redact, or re-ask on failure. High value for
   the legal host (PII redaction before a payload leaves to a provider).

**Leverage:** 007's eval framework already runs validators (LLM-judge scorers in
`eval/grade.ts`, checks in `eval/checks.ts`). Define the validator interface
once and call it in **two** places — offline in evals and online as a runtime
guardrail. One definition, two call sites.

## Current state (audit)

- Agents already support a structured output contract:
  `engine/agent-config-schema.ts` → `agentOutputSchema` (`kind: 'text' |
  'object'` with a persisted JSON `schema`). So structured output works; there
  is **no repair** on invalid output and it currently just fails/roughly-coerces.
- No guardrail / moderation / redaction concept anywhere in `engine/` or
  `cloudflare/` (`grep guardrail|moderat|redact` → only the agent-config schema
  file, incidental).

## Plan

### A. Structured-output repair (agent node)

Localized to `nodes/agent.ts`:

- When the model returns object output that fails `agentOutputSchema.schema`
  validation, don't throw immediately. Run a bounded repair loop
  (`maxRepairs`, default 1–2):
  - **Re-ask:** feed the validation error back to the same model ("your output
    failed this schema: … return corrected JSON") — cheapest, no new model.
  - **Fixer model (optional):** a configurable repair model for the second
    attempt. Reuses the fallback-model plumbing from
    [01-execution-policy.md](./01-execution-policy.md) if built.
- Mirror the Vercel AI SDK `experimental_repairToolCall` idea for tool-call args
  as well (repair malformed tool arguments the same way).
- Config: add `repair?: { maxAttempts: number; model?: string }` to the agent
  config (or node config). Record repair attempts in step `meta`.
- All of this is inside the node's own `step.do`, so it's replay-safe.

### B. Guardrail node kind

Add `'guardrail'` to `WF_NODE_KINDS` (`engine/graph-kinds.ts`) + a
`guardrailNodeSchema`:

```ts
{
  source?: RefBinding,            // value to validate (data-picker ref)
  rails: Array<{
    kind: 'pii' | 'moderation' | 'schema' | 'grounding' | 'judge' | 'custom',
    action: 'block' | 'redact' | 'reask',
    config?: Record<string, unknown>,   // rail-specific (e.g. pii entities)
  }>,
  // routing: emit 'pass' | 'fail' like a decision node so a failed rail can
  // route to a handler arm; 'redact' rewrites the value and continues 'pass'.
}
```

- Add `'guardrail'` to `DECISION_NODE_KINDS` so pass/fail routes via existing
  conditional-edge machinery.
- **Rail implementations** live behind a small `Rail` interface. Each rail is
  provider-agnostic where possible:
  - `pii` — redact detected PII before the value flows on (start with a
    regex/entity pass; optionally a classifier model via `getModel`). **Top
    priority for the legal host.**
  - `moderation` / `judge` / `grounding` — reuse the eval scorer interface so the
    same validator runs offline and online.
  - `schema` — validate against a JSON Schema (repair overlaps with A).
  - `custom` — host-supplied validator from a registry (mirror the tool
    registry's injection model).

### C. Shared validator interface (the key move)

- Extract the check/scorer contract from `eval/checks.ts` + `eval/grade.ts` into
  a `Validator` shape usable by both the eval executor and the guardrail node.
- A guardrail rail and an eval check become the *same* object called at
  different times. This is what makes B cheap and keeps behavior consistent
  between "tested offline" and "enforced online".

## Effort & risks

- **A (repair): S** — contained to `nodes/agent.ts`; the re-ask loop is small.
- **B (guardrail node): M** — new node kind + rail implementations; PII rail
  alone is a shippable v1.
- **C (shared interface): S** — refactor, but unlocks reuse; do it alongside B.
- Risk: keep engine provider-agnostic — model-backed rails go through `getModel`;
  no direct provider imports. Deterministic guard: rail model calls happen inside
  the node's `step.do`, recorded like any node output.

## Acceptance criteria

- An agent whose model returns schema-invalid object output produces a valid
  object after one repair re-ask, with the attempts recorded in the step trace.
- A guardrail node with a `pii`/`redact` rail rewrites a value to remove PII and
  routes `pass`; a `moderation`/`block` rail routes `fail` to a handler arm.
- The same validator definition runs as an eval check offline and as a guardrail
  rail online, from one source.
