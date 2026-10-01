import type { DecisionAgentConfig } from '../../engine'

// How a DECISION agent's edit is described — for the History dropdown, and as
// the undo stack's coalescing key (two consecutive edits to the same thing
// produce the same string, which is what collapses a run of keystrokes into one
// entry instead of evicting the stack).
//
// The sibling of `describeAgentChange`, and deliberately NOT `changedFields`
// over the config. That table names top-level fields, and this config has four
// of them — "Edited questions" would be the label for renaming a question,
// rewording a prompt, adding a choice and changing a threshold alike, so every
// keystroke anywhere in the matrix would coalesce into one undo entry. The
// labels here go one level deeper, to the grain an author actually edits at.

/** Longest a list gets before the count reads better than the names. */
const MAX_LISTED = 2

export function describeDecisionAgentChange(
  a: DecisionAgentConfig,
  b: DecisionAgentConfig,
): string {
  if (a.modelId !== b.modelId) return 'Changed the decision model'

  if (a.questions.length !== b.questions.length) {
    return b.questions.length > a.questions.length
      ? 'Added a question'
      : 'Removed a question'
  }
  // Which question moved, by position — the ids may have moved too (a rename is
  // an edit like any other), so comparing by id would report a rename as one
  // question removed and another added.
  const movedQuestions = a.questions
    .map((q, i) => ({ q, other: b.questions[i] }))
    .filter(({ q, other }) => JSON.stringify(q) !== JSON.stringify(other))
  if (movedQuestions.length > 0) {
    const names = movedQuestions.map(({ other }) => other?.id ?? '?')
    return names.length > MAX_LISTED
      ? `Edited ${names.length} questions`
      : `Edited question ${names.join(' and ')}`
  }

  if (JSON.stringify(a.verdicts) !== JSON.stringify(b.verdicts)) {
    return a.verdicts.length === b.verdicts.length
      ? 'Renamed a verdict'
      : b.verdicts.length > a.verdicts.length
        ? 'Added a verdict'
        : 'Removed a verdict'
  }

  if (a.rules.length !== b.rules.length) {
    return b.rules.length > a.rules.length ? 'Added a rule' : 'Removed a rule'
  }
  const movedRules = a.rules
    .map((_, i) => i)
    .filter((i) => JSON.stringify(a.rules[i]) !== JSON.stringify(b.rules[i]))
  if (movedRules.length > 0) {
    return movedRules.length > MAX_LISTED
      ? `Edited ${movedRules.length} rules`
      : `Edited rule ${movedRules.map((i) => i + 1).join(' and ')}`
  }

  return 'Edited agent'
}
