import { z } from 'zod'

import { inferPromptVariables } from './prompt-variables'

// The versioned behavior of a reusable **agent** (a `wf_agent`): its model,
// prompt, tools, output contract, and delegation whitelist. This is a distinct
// domain from the node/edge graph model in `graph-schema.ts` — a workflow agent
// *node* is only a pointer at one of these by id — so it lives on its own and is
// re-exported through `graph-schema.ts` for existing importers.

// An agent's "expected output" contract, versioned with the rest of its config.
//   • text    — the tool-calling loop's final text (`{ text }`).
//   • boolean — a YES/NO decision (`{ answer: boolean, reason: string }` via
//               generateObject).
//   • object  — a structured object matching a JSON Schema (`schema`). The
//               author writes it as a Zod schema in the editor, which compiles
//               to `schema`; only `schema` is persisted.
export const agentOutputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text') }),
  z.object({ kind: z.literal('boolean') }),
  z.object({
    kind: z.literal('object'),
    // The compiled JSON Schema fed to `generateObject` — the SINGLE source of
    // truth. The editable Zod source shown in the editor is derived from this on
    // demand (`zodSourceFromJsonSchema`) and never persisted, so the two can't
    // drift. Legacy rows/specs may still carry a `source` key; Zod strips it.
    schema: z.record(z.string(), z.unknown()),
  }),
])
export type AgentOutput = z.infer<typeof agentOutputSchema>

// One agent/workflow an agent may DELEGATE to. The author whitelists these on
// the primary agent; at run time the engine synthesizes a `spawn_*` tool per
// target (named/documented from the target) plus a shared `await_subagents`
// join tool. A target is a pure pointer by id — the run manifest freezes the
// referenced agent config / workflow graph transitively (see resolveRunManifest),
// so a sub-agent replays against an exact version even as the target drifts.
export const subAgentTargetSchema = z.object({
  // Whether this target is a reusable agent (`wf_agent`) or a workflow
  // (`wf_workflow`). Drives how the spawn tool's input schema is derived and how
  // the sub-run executes (inline agent loop vs. inline subgraph).
  kind: z.enum(['agent', 'workflow']),
  // The target's stable `wf_agent.id` / `wf_workflow.id`.
  id: z.string().min(1),
  // Agent version pin, mirroring an agent node: `null` (default) floats to the
  // target's latest published version; a number pins that exact version. Ignored
  // for workflow targets (they always float to latest, like a workflow node).
  version: z.number().int().positive().nullable().default(null),
  // Optional override for the synthesized tool name (else derived from the
  // target's display name). Must be a valid identifier — it becomes a tool key.
  toolName: z
    .string()
    .regex(/^\w+$/, 'Tool name must be alphanumeric/underscore.')
    .optional(),
  // Optional human label used in the synthesized tool's description (else the
  // target's display name / description).
  label: z.string().optional(),
})
export type SubAgentTarget = z.infer<typeof subAgentTargetSchema>

// Delegation config: the whitelist of sub-agents/workflows this agent may spawn,
// plus the guardrails. Empty `targets` = delegation off (no tools synthesized).
export const subAgentsConfigSchema = z
  .object({
    targets: z.array(subAgentTargetSchema).default([]),
    // Ceiling on how many sub-runs execute concurrently within one primary
    // agent step (a semaphore over the in-flight spawns).
    maxConcurrent: z.number().int().min(1).max(20).default(4),
    // Hard cap on the TOTAL number of sub-agents the primary may spawn in a
    // single run of this node. Once reached, further `spawn_*` calls return an
    // error object so the model can adapt rather than exceed the budget.
    maxSpawns: z.number().int().min(1).max(50).default(10),
    // When true, sub-agents get an injected `signal_stop(reason)` tool; a
    // sub-agent calling it makes the primary's `await_subagents` short-circuit
    // as soon as that sub-agent completes.
    allowStopSignal: z.boolean().default(true),
  })
  .default({
    targets: [],
    maxConcurrent: 4,
    maxSpawns: 10,
    allowStopSignal: true,
  })
export type SubAgentsConfig = z.infer<typeof subAgentsConfigSchema>

// The versioned configuration of a reusable **agent** (a `wf_agent`). Workflow
// agent nodes don't carry this — they point at an agent by id and the run
// manifest freezes the resolved config. Name/icon/color are display metadata on
// the entity, not part of the versioned behavior.
const agentConfigObjectSchema = z.object({
  // Model id passed to the host `getModel(modelId)` factory.
  modelId: z.string().min(1),
  // Inline system prompt (authored in the TipTap editor). `${name}` tokens are
  // interpolated at execution time from the run's `promptVariables`.
  //
  // INSTRUCTIONS ONLY. Per-call data belongs in `userPrompt`: this string is the
  // provider's cache prefix, so a `${var}` carrying a document or a candidate
  // list here changes that prefix on every call and defeats prompt caching for a
  // workflow that runs the same agent once per item.
  prompt: z.string().min(1),
  // The single user turn a TASK agent runs on, and the ONLY way data reaches it.
  // `${name}` tokens interpolate from the same variable bag as `prompt` — their
  // UNION is the agent's input contract (see `inferPromptVariables`) — with
  // non-string values JSON-stringified by `resolveNodeInputs`.
  //
  // Required and non-empty for `inputKind: 'task'`; see the refinement below.
  // The AI SDK rejects a call carrying no messages outright (`standardizePrompt`
  // — "messages must not be empty"), so an agent that renders no user turn isn't
  // a degraded call, it's a crash.
  //
  // Optional for `inputKind: 'conversation'`, where it is appended after the
  // bound thread as the current turn; empty means the thread IS the whole input.
  userPrompt: z.string().default(''),
  // Tool registry keys. Each id must resolve in the host tool registry.
  toolIds: z.array(z.string()).default([]),
  // How many turns (rounds of tool-calling) the agent may take before it must
  // give a final answer.
  //
  // The ceiling is a runaway-loop backstop, not a recommendation — the real
  // bound on a long agent is time (the node's ~17-minute in-process budget) and
  // spend (`tokenBudget`), both of which bite well before 100 turns on any
  // normal model. The editor warns past 20 rather than the schema rejecting it,
  // because "too slow for the node budget" depends on the node's timeout and the
  // model's latency, neither of which this schema can see.
  maxTurns: z.number().int().min(1).max(100).default(5),
  // Tokens (prompt + completion, summed across every turn) the agent may spend
  // RESEARCHING before it has to write its answer. `null` — the default — means
  // no ceiling, leaving only `maxTurns` and the node's wall-clock budget.
  //
  // It exists to turn the loop's worst failure mode into a graceful one. The
  // node's wall-clock budget (`engine/model-budget.ts`) aborts an overrunning
  // agent, and that abort is classified FATAL and never retried — a run that
  // spent real money and produced nothing. A token ceiling reached first ends
  // the same investigation with a written answer instead, via the same mechanism
  // as the last-turn tool denial.
  //
  // It bounds RESEARCH, not the run: the forced final turn re-sends the
  // conversation and generates an answer on top of this number, and nothing caps
  // that (no `maxOutputTokens` is passed). So it's a floor on spend, not a
  // ceiling — an earlier draft dressed this up as a percentage split with a
  // "reserve" for the answer, which enforced nothing and just made the author do
  // arithmetic to find the only number that mattered. The editor now states the
  // cost as "from $X" for the same reason.
  toolTokenBudget: z.number().int().min(1000).nullable().default(null),
  // How much of the model's context window to keep free for writing the answer,
  // as a percentage. The loop stops calling tools once one more turn would eat
  // into it. Serves a different failure than `toolTokenBudget`: that one is about
  // money and is a soft preference; this one is about overflowing the window,
  // which is a hard provider error.
  //
  // Why a RESERVE and not a "stop at N% full" ceiling, which is the more obvious
  // control: the engine can only read a request's size after sending it, so any
  // occupancy reading is one turn stale. A raw "stop at 90%" leaves 10% to absorb
  // both the next turn's growth AND the answer — and a single large tool result
  // eats that, overflowing on the very turn that was supposed to be the graceful
  // exit. The engine instead MEASURES this agent's real per-turn growth and stops
  // when `lastInput + growth + reserve` would exceed the window, so what the
  // author sets is only the part they can actually reason about: how much room
  // their answers need. See `runToolLoop`.
  answerReservePercent: z.number().int().min(2).max(50).default(10),
  // Force the FIRST round-trip to call a tool (`toolChoice: 'required'`) instead
  // of letting the model choose. The failure mode this exists for is an agent
  // answering a retrieval question from parametric knowledge — confidently, and
  // without ever searching. A system prompt saying "always search first" is only
  // probabilistic; this makes it structural.
  //
  // Deliberately inert rather than an error in the three cases where it can't
  // hold (see `runToolLoop`): no tools registered, `maxTurns: 1` (turn 1 is also
  // the final answering turn, which denies tools and must win), and the
  // structured-output kinds, which run `generateObject` with no tool loop at all.
  requireToolFirstTurn: z.boolean().default(false),
  // NOTE: `exposeThinking` and `enableReasoning` used to live here and are gone.
  // Zod strips them from stored configs, so old rows still parse.
  //
  // Both were display/behavior switches an agent should never have owned:
  //   - What a step surfaces to the user is a per-PLACEMENT choice, so it lives
  //     on the workflow node (`informUser`) — the same agent can stream its work
  //     in one workflow and stay quiet in another. Sub-agents, which have no node
  //     of their own, inherit the primary node's choice (see `sub-agent.ts`).
  //   - Whether the model reasons at all is deliberately NOT configurable.
  //     Reasoning is a real extra generation pass that materially improves
  //     multi-step analysis; a display preference must not silently switch it
  //     off. Nothing passes a reasoning intent for agents, so the provider
  //     default (on) always wins. The one place it IS disabled is short internal
  //     utility calls (`summarize-changes.ts`), in code, per call.
  //
  // Keeping them as dead-but-parsed fields cost real debugging time: they show
  // up in run dumps reading exactly like live switches.
  //
  // What the agent is expected to produce.
  output: agentOutputSchema.default({ kind: 'text' }),
  // WHERE this agent's messages come from — a declaration about its contract,
  // like `output`. It belongs here rather than on the workflow node because it's
  // a property of the agent's prompt, not of one placement.
  //
  //   • 'task'         — the agent runs on exactly one user turn, rendered from
  //                      `userPrompt` with its `${vars}` mapped on the node. A
  //                      classifier, an extractor, a summarizer.
  //   • 'conversation' — the agent answers a chat thread. Every NODE pointing at
  //                      it MUST bind `conversation` to the message source
  //                      (usually the chat trigger's `messages`); `userPrompt`,
  //                      if set, is appended as the current turn.
  //
  // This replaced `acceptsConversation`, which was inert: nothing in the engine
  // read it. It only made the node's `conversation` input appear in the editor,
  // while at run time an unbound agent silently fell back to JSON-stringifying
  // whatever its incoming edge happened to carry. That fallback is gone — an
  // edge means sequencing and a source for `ref` bindings, never content — so
  // this field now decides how messages are built. See `engine/nodes/agent.ts`.
  inputKind: z.enum(['conversation', 'task']).default('task'),
  // Delegation whitelist + guardrails. Non-empty `targets` makes the engine
  // synthesize `spawn_*` + `await_subagents` tools into this agent's tool set.
  subAgents: subAgentsConfigSchema,
})

/**
 * Back-compat for configs stored before `inputKind`/`userPrompt` existed.
 *
 * `wf_agent_version` rows are IMMUTABLE snapshots, so this reads raw stored JSON
 * ahead of the parse — the same trick `migrateInformUser` uses for legacy node
 * fields. Without it every pre-existing version fails validation, which would
 * blank the agents list (`buildAgentSummary` safe-parses and degrades) and abort
 * the run manifest for any agent not yet re-published.
 *
 * A legacy config's user turn CANNOT be reproduced: it was the incoming edge's
 * payload, which lives in the run, not the config. So the synthesized turn is an
 * approximation — one `name: ${name}` line per variable the system prompt
 * declares, the same rendering the agent playground has always stood in when an
 * author supplied variables but no test input. Republishing an agent through the
 * editor replaces it with a real authored template.
 */
function migrateInputKind(raw: unknown): unknown {
  if (raw == null || typeof raw !== 'object') return raw
  const config = raw as Record<string, unknown>
  if (config.inputKind != null && config.userPrompt != null) return config
  const inputKind =
    config.inputKind ??
    (config.acceptsConversation === true ? 'conversation' : 'task')
  let userPrompt = config.userPrompt
  if (typeof userPrompt !== 'string' || userPrompt.length === 0) {
    const vars =
      typeof config.prompt === 'string' ? inferPromptVariables(config.prompt) : []
    // A conversation agent needs no turn of its own — the thread is its input.
    userPrompt =
      inputKind === 'conversation'
        ? ''
        : vars.map((name) => `${name}: \${${name}}`).join('\n\n')
  }
  return { ...config, inputKind, userPrompt }
}

export const agentConfigSchema = z
  .preprocess(migrateInputKind, agentConfigObjectSchema)
  .superRefine((config, ctx) => {
    // A task agent with no user turn cannot be called at all: the AI SDK throws
    // `InvalidPromptError` ("messages must not be empty") before the request
    // reaches a provider. Catching it here turns a run-time crash on the author's
    // most expensive node into a save-time validation error.
    if (config.inputKind === 'task' && config.userPrompt.trim().length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['userPrompt'],
        message:
          'A task agent needs a user message — it is the only way data reaches it. Write one, using ${variables} you map on each workflow node.',
      })
    }
  })
export type AgentConfig = z.infer<typeof agentConfigSchema>

/**
 * An agent's input contract: every `${name}` it references, across BOTH prompts.
 *
 * The two templates share one variable bag at run time (`resolveNodeInputs`), so
 * a name used in both is one input mapped once. This is what the workflow editor
 * lists as the node's required bindings and what `runAgentPreview` asks for — it
 * must stay the union, or a variable that appears only in the user message would
 * be silently unmappable and reach the model as a literal `${name}`.
 */
export function agentInputVariables(
  config: Pick<AgentConfig, 'prompt' | 'userPrompt'>,
): string[] {
  return [
    ...new Set([
      ...inferPromptVariables(config.prompt),
      ...inferPromptVariables(config.userPrompt),
    ]),
  ]
}
