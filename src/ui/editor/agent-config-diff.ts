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

// Longest a field list gets before it stops being a label and starts being a
// paragraph. Past this the count reads better than the names.
const MAX_LISTED_FIELDS = 2

/**
 * A one-line description of an agent-config edit, for the History dropdown —
 * the agent editor's counterpart to `describeChange` for graphs.
 *
 * Doubles as the undo stack's coalescing key: two consecutive edits to the same
 * field produce the same string, which is what lets a run of keystrokes collapse
 * into one history entry instead of evicting the whole stack.
 */
export function describeAgentChange(a: AgentConfig, b: AgentConfig): string {
  const fields = changedFields(a, b)
  if (fields.length === 0) return 'Edited agent'
  if (fields.length > MAX_LISTED_FIELDS) return `Changed ${fields.length} settings`
  return `Edited ${fields.join(' and ')}`
}
