import type { EvalCheck, EvalMatch } from '../../server/protocol'

// How a Check gets its name.
//
// A Check's name is an *assertion about the run* — "Has correct title",
// "Never calls send_email" — not a topic ("Alimony test"). The name completes
// the sentence "this run…", which makes it falsifiable and makes a column of
// Checks read as a checklist.
//
// Nothing here validates or enforces that; a name is free text. What this
// module does is make the convention the path of least resistance: every name
// the UI derives, suggests, or offers as an example is written in that voice,
// so an author sees it before they read a word of documentation.

/**
 * Verb starters offered as one-click chips when a Check has no name. Ordered
 * presence → absence → behavior, since the negative forms ("Avoids", "Never
 * calls") are the ones authors rarely think of unprompted.
 */
export const CHECK_NAME_VERBS = [
  'Has',
  'Mentions',
  'Cites',
  'Avoids',
  'Never',
  'Asks for',
  'Calls',
] as const

// Exemplar names, rotated by the Check's index within its sample, so a sample
// with several unnamed Checks shows several *different* well-formed names
// rather than the same one repeated — which teaches the range of the
// convention (presence, absence, behavior, quality) rather than one instance.
const EXAMPLE_CHECK_NAMES = [
  'Has correct title',
  'Mentions alimony',
  'Avoids legal advice',
  'Asks for the filing date',
  'Cites the right statute',
  'Stays under 200 words',
]

/** A well-formed example name, varied by position. */
export function exampleCheckName(index: number): string {
  const i = Number.isFinite(index) ? Math.abs(Math.trunc(index)) : 0
  return EXAMPLE_CHECK_NAMES[i % EXAMPLE_CHECK_NAMES.length]
}

// Third-person verb for each comparison, so a derived name reads as a sentence
// about the value rather than as an operator ("query contains" not "query ~=").
const MATCH_VERB: Record<EvalMatch, string> = {
  equals: 'is',
  contains: 'contains',
  jsonpath: 'matches',
  regex: 'matches',
}

/** Render a check's expected value compactly for use inside a name. */
function formatValue(value: unknown): string {
  if (typeof value === 'string') return `“${truncate(value, 30)}”`
  if (value == null) return 'nothing'
  if (typeof value === 'object') return truncate(JSON.stringify(value), 30)
  return String(value)
}

function truncate(text: string, max: number): string {
  const t = text.trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

/**
 * A name derived from what the Check actually asserts, in the assertion voice —
 * the suggestion offered for a deterministic Check.
 *
 * `null` when the check can't name itself: a judge (whose assertion lives in
 * free-text prose, so naming it needs a model — see `suggestCheckName` on the
 * data client) or a half-configured check with no tool/node picked yet.
 */
export function heuristicCheckName(check: EvalCheck): string | null {
  switch (check.type) {
    case 'tool_called':
      if (!check.toolId) return null
      return `${check.called ? 'Calls' : 'Never calls'} ${check.toolId}`
    case 'tool_args_match':
      if (!check.toolId) return null
      return `Calls ${check.toolId} where ${check.path || 'args'} ${MATCH_VERB[check.match]} ${formatValue(check.value)}`
    case 'node_visited':
      if (!check.nodeId) return null
      return `${check.visited ? 'Reaches' : 'Never reaches'} ${check.nodeId}`
    case 'node_input_match':
      if (!check.nodeId) return null
      return `Reaches ${check.nodeId} where ${check.path || 'input'} ${MATCH_VERB[check.match]} ${formatValue(check.value)}`
    case 'output_match':
      return `Output${check.path ? `.${check.path}` : ''} ${MATCH_VERB[check.match]} ${formatValue(check.value)}`
    case 'llm_judge':
      return null
  }
}

/**
 * What to render for a Check wherever one is listed — its name if the author
 * wrote one, else the best stand-in.
 *
 * An unnamed judge falls back to its rubric *in quotes* rather than to a
 * derived title. That's deliberate: a quoted fragment sitting in a column of
 * assertions looks unfinished, which is the nudge. A label that looked like a
 * name would remove the reason to write one.
 */
export function describeCheck(check: EvalCheck | undefined): string {
  if (!check) return 'check'
  if (check.label?.trim()) return check.label.trim()
  const derived = heuristicCheckName(check)
  if (derived) return derived
  if (check.type === 'llm_judge' && check.rubric.trim()) {
    return `“${truncate(check.rubric, 60)}”`
  }
  return 'Unnamed check'
}

/** True when a Check is still leaning on a derived stand-in for its name. */
export function isUnnamed(check: EvalCheck | undefined): boolean {
  return !check?.label?.trim()
}
