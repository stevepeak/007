import type { AgentConfig } from '../../engine'

// Which fields of an agent config a frozen snapshot would change if you took it
// back — shared by everything in the editor that runs the draft and then keeps
// the configuration it ran on (the playground, the evals panel).
//
// Both panels need the same answer to the same question: "is the result on this
// card still evidence about what I'm looking at?" A run whose snapshot differs
// from the live draft graded something the editor no longer shows, and saying so
// in the run's own words — "model, system prompt" — is the difference between a
// stale card and a misleading one.

// The fields a restore actually moves, in the order the editor shows them.
const CONFIG_FIELDS: { key: keyof AgentConfig; label: string }[] = [
  { key: 'modelId', label: 'model' },
  { key: 'prompt', label: 'system prompt' },
  { key: 'userPrompt', label: 'user message' },
  { key: 'toolIds', label: 'tools' },
  { key: 'subAgents', label: 'sub-agents' },
  { key: 'output', label: 'output' },
  { key: 'maxTurns', label: 'max turns' },
  { key: 'toolTokenBudget', label: 'token budget' },
  { key: 'answerReservePercent', label: 'answer reserve' },
  { key: 'requireToolFirstTurn', label: 'tool-first' },
  { key: 'inputKind', label: 'input kind' },
]

/** Human labels for every field that differs between two configs. */
export function changedFields(a: AgentConfig, b: AgentConfig): string[] {
  return CONFIG_FIELDS.filter(
    (f) => JSON.stringify(a[f.key]) !== JSON.stringify(b[f.key]),
  ).map((f) => f.label)
}
