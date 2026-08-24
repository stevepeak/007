import { changedEvalRowFields } from '../../engine'
import type { CoalesceRule } from '../undo/use-undo-stack'

// How a sample edit is described in the History dropdown — and, because the
// label doubles as the undo stack's coalescing key, what counts as "still the
// same edit".
//
// The label table is the one the CHANGE LOG uses (`engine/change-fields`), so a
// history entry and the audit row it eventually produces name a field the same
// way. Two tables would drift, and the drift would read as the log disagreeing
// with the editor that wrote it.

/** The editable half of a sample, as both the stack and the log see it. */
export type SampleFields = {
  name: string
  description: string
  input: unknown
  tools: unknown
  checks: unknown
}

const MAX_LISTED_FIELDS = 2

export function describeSampleChange(a: SampleFields, b: SampleFields): string {
  const fields = changedEvalRowFields(a, b)
  if (fields.length === 0) return 'Edited sample'
  if (fields.length > MAX_LISTED_FIELDS) return `Changed ${fields.length} fields`
  return `Edited ${fields.join(' and ')}`
}

/**
 * Typing in one field is ONE edit to a reader. Without this a 50-character
 * rename pushes 50 entries and evicts the history it was supposed to protect.
 *
 * The label carries the field name, so it is a good enough identity for "still
 * editing the same thing"; 600ms of quiet starts a new entry.
 */
export function coalesceSampleEdit(
  _prev: SampleFields,
  _next: SampleFields,
  label: string,
): CoalesceRule {
  return label.startsWith('Edited') ? { key: label, windowMs: 600 } : null
}


/** The editable half of a Goal — the unversioned metadata, not its samples. */
export type GoalDraft = { name: string; description: string }

export function describeGoalChange(a: GoalDraft, b: GoalDraft): string {
  if (a.name !== b.name) return 'Edited name'
  if (a.description !== b.description) return 'Edited description'
  return 'Edited goal'
}
