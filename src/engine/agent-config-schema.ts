import { z } from 'zod'

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
export const agentConfigSchema = z.object({
  // Model id passed to the host `getModel(modelId)` factory.
  modelId: z.string().min(1),
  // Inline system prompt (authored in the TipTap editor). `${name}` tokens are
  // interpolated at execution time from the run's `promptVariables`.
  prompt: z.string().min(1),
  // Tool registry keys. Each id must resolve in the host tool registry.
  toolIds: z.array(z.string()).default([]),
  // How many turns (rounds of tool-calling) the agent may take before it must
  // give a final answer.
  maxTurns: z.number().int().min(1).max(20).default(5),
  // When true, per-step thinking text is forwarded to the run's StreamSink (the
  // RunRoom DO) so the user can watch the agent work.
  exposeThinking: z.boolean().default(false),
  // When true, the model is asked to reason/think for this agent. Opt-in: an
  // undefined reasoning intent falls back to the host default, so making it
  // explicit here (default off) means an agent reasons only when the author asks
  // for it. Pairs with `exposeThinking` (which streams the reasoning to the user)
  // and is gated in the editor to models whose `capabilities.reasoning` is true.
  enableReasoning: z.boolean().default(false),
  // What the agent is expected to produce.
  output: agentOutputSchema.default({ kind: 'text' }),
  // Delegation whitelist + guardrails. Non-empty `targets` makes the engine
  // synthesize `spawn_*` + `await_subagents` tools into this agent's tool set.
  subAgents: subAgentsConfigSchema,
})
export type AgentConfig = z.infer<typeof agentConfigSchema>
