import { changedFields, type AgentConfig } from '../../engine'

// How an agent-config edit is DESCRIBED — the label table itself moved down to
// `engine/config-fields` so the change log names fields the same way this
// editor does. `changedFields` is re-exported here because its callers (the
// playground, the evals panel) all live in the editor.
//
// They ask it the same question: "is the result on this card still evidence
// about what I'm looking at?" A run whose snapshot differs from the live draft
// graded something the editor no longer shows, and saying so in the run's own
// words — "model, system prompt" — is the difference between a stale card and a
// misleading one.

export { changedFields }

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
