import type { EvalCheck, EvalMatch } from '../../server/protocol'

// How a Check gets its name.
//
// It doesn't have one. A Check has no title field — its name is *derived*, every
// time, from what it actually asserts: "Calls send_email", "Output.status is
// “filed”". That's the whole point. A hand-written title duplicates what the
// config already says and then drifts from it the moment the config changes,
// and it has to be nagged into existence with hint UI. A derived name can't lie.
//
// The voice is an assertion about the run — the name completes the sentence
// "this run…", which is what makes a column of Checks read as a checklist.

/**
 * The human-readable name of each check `type`. The last-resort summary for a
 * check too empty to describe itself ("Tool called" before a tool is picked),
 * and the label the type pickers show so authors never see a raw `snake_case`
 * id.
 */
export const CHECK_TYPE_LABELS: Record<EvalCheck['type'], string> = {
  tool_called: 'Tool called',
  tool_args_match: 'Tool arguments',
  node_visited: 'Node visited',
  node_input_match: 'Node input',
  output_match: 'Output matches',
  llm_judge: 'Judge',
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
 * A name derived from what the Check actually asserts, in the assertion voice.
 *
 * `null` when the check can't name itself: a judge (whose assertion lives in
 * free-text prose — {@link describeCheck} quotes the rubric instead) or a
 * half-configured check with no tool/node picked yet.
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
 * What to render for a Check wherever one is listed — the collapsed summary of
 * its config, in three tiers: the derived assertion, else a judge's rubric *in
 * quotes*, else the bare type name.
 *
 * The quotes on a rubric are deliberate. A quoted fragment sitting in a column
 * of assertions reads as the prose it is, rather than passing itself off as a
 * title someone wrote. The bare type name is what a just-added check shows
 * until it's configured — "Tool called" says exactly how far along it is.
 */
export function describeCheck(check: EvalCheck | undefined): string {
  if (!check) return 'check'
  const derived = heuristicCheckName(check)
  if (derived) return derived
  if (check.type === 'llm_judge' && check.rubric.trim()) {
    return `“${truncate(check.rubric, 60)}”`
  }
  return CHECK_TYPE_LABELS[check.type]
}
