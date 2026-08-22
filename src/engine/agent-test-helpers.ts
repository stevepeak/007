import type { z } from 'zod'

import { agentConfigSchema, type AgentConfig } from './agent-config-schema'

/**
 * Build a fully-defaulted {@link AgentConfig} for tests from only the fields a
 * case actually cares about.
 *
 * `AgentConfig` is `z.infer` of the schema — the **output** type, where every
 * `.default()` has already been applied and is therefore REQUIRED. Fixtures
 * naturally get written in the *input* shape (`{ modelId, prompt, toolIds }`),
 * which does not satisfy it. Before this helper existed, ~10 test files each
 * hand-rolled that literal, none of them typechecked, and all of them had
 * silently fallen behind the schema — missing `toolTokenBudget`,
 * `answerReservePercent`, `requireToolFirstTurn`, and `subAgents`.
 *
 * Parsing rather than spreading a literal of defaults is the point: when the
 * schema gains another defaulted field, every fixture picks it up for free
 * instead of breaking or drifting again.
 */
export function makeAgentConfig(
  overrides: Partial<z.input<typeof agentConfigSchema>> = {},
): AgentConfig {
  return agentConfigSchema.parse({
    modelId: 'test-model',
    prompt: 'You are a test agent.',
    // Non-empty because the schema's `superRefine` rejects a `task` agent (the
    // default `inputKind`) whose user message is blank — it would throw
    // `InvalidPromptError` at run time with no way for data to reach it.
    userPrompt: 'Do the thing.',
    ...overrides,
  })
}
