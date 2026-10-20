import type { DecisionQuestionType } from './decision'
import {
  decisionAgentInputVariables,
  type DecisionAgentConfig,
} from './decision-agent-schema'
import type { AgentNode, WorkflowGraph, WorkflowNode } from './graph'
import { nodeRefs } from './graph-bindings'
import type { GraphIssue } from './graph-issues'
import { toText } from './text'

// Decision-agent wiring — what a node that runs a decision agent promises the
// rest of the graph, checked against the agent it points at.
//
// A decision node's output has a fixed shape, `{ answers, reasoning, verdict,
// because }`, but what is INSIDE it — which verdicts exist, which question ids
// key `answers`, which fields each answer carries — belongs to the agent. None
// of those mistakes fail loudly at run time. A Switch case naming a verdict the
// agent never returns just never fires; a ref into `answers.<renamed>` resolves
// to `undefined`; an unbound `${variable}` reaches the provider as literal text.
// Every one of them routes the run somewhere, so the run looks healthy.
//
// Pure function over an index, like `collectToolArgIssues` and
// `collectAgentRefIssues`: the editor builds the index from the agent list it
// already holds, the server from the rows, and the Issues panel and
// `validate_workflow_graph` report the same thing.

/** What the lint needs to know about one decision agent. */
export type DecisionWiringEntry = {
  name: string
  verdicts: readonly string[]
  questions: readonly {
    id: string
    type: DecisionQuestionType
    /** Category options or scale levels; `[]` for a boolean. */
    choiceKeys: readonly string[]
  }[]
  /** Every `${name}` the questions interpolate. */
  inputVariables: readonly string[]
}

/** Agent id → its latest published matrix. Generation agents are absent. */
export type DecisionWiringIndex = ReadonlyMap<string, DecisionWiringEntry>

export function decisionWiringEntry(args: {
  name: string
  config: DecisionAgentConfig
}): DecisionWiringEntry {
  return {
    name: args.name,
    verdicts: args.config.verdicts,
    questions: args.config.questions.map((q) => ({
      id: q.id,
      type: q.type,
      choiceKeys: q.type === 'boolean' ? [] : q.choices.map((c) => c.key),
    })),
    inputVariables: decisionAgentInputVariables(args.config),
  }
}

const OUTPUT_FIELDS = ['answers', 'reasoning', 'verdict', 'because']

// The fields of one answer, by question type. Mirrors `DecisionVerdict`.
const ANSWER_FIELDS: Record<DecisionQuestionType, readonly string[]> = {
  boolean: ['value', 'probability', 'threshold', 'confidence', 'distribution'],
  category: ['value', 'confidence', 'distribution'],
  scale: ['value', 'level', 'confidence', 'distribution'],
}

function display(value: unknown): string {
  return toText(value, { nullText: 'null' })
}

function* allNodes(nodes: WorkflowNode[]): Generator<WorkflowNode> {
  for (const n of nodes) {
    yield n
    if (n.kind === 'iteration') yield* allNodes(n.config.subgraph.nodes)
  }
}

/**
 * Why a ref `path` into a decision node's output reads nothing, or `null` when
 * it names a field the agent produces. Deeper segments (a distribution key) are
 * not checked.
 */
function badPathReason(path: string, entry: DecisionWiringEntry): string | null {
  if (!path) return null
  const [top, questionId, field] = path.split('.')
  if (!OUTPUT_FIELDS.includes(top)) {
    return `"${top}" is not part of a decision's output (${OUTPUT_FIELDS.join(', ')})`
  }
  if (top !== 'answers' || questionId === undefined) return null
  const question = entry.questions.find((q) => q.id === questionId)
  if (!question) {
    return `"${entry.name}" has no question "${questionId}" (it asks ${entry.questions.map((q) => q.id).join(', ') || 'nothing'})`
  }
  if (field !== undefined && !ANSWER_FIELDS[question.type].includes(field)) {
    return `a ${question.type} answer has no "${field}" (it has ${ANSWER_FIELDS[question.type].join(', ')})`
  }
  return null
}

/**
 * The values a ref into a decision node can equal, when the set is closed: the
 * verdicts, or a category's option keys, or a scale's level keys. `null` for
 * anything open-ended (a probability, the reasoning text).
 */
function closedValues(
  path: string,
  entry: DecisionWiringEntry,
): { values: readonly string[]; what: string } | null {
  if (path === 'verdict') return { values: entry.verdicts, what: 'verdict' }
  const [top, questionId, field] = path.split('.')
  if (top !== 'answers') return null
  const question = entry.questions.find((q) => q.id === questionId)
  if (!question) return null
  if (question.type === 'category' && field === 'value') {
    return { values: question.choiceKeys, what: `"${question.id}" option` }
  }
  if (question.type === 'scale' && field === 'level') {
    return { values: question.choiceKeys, what: `"${question.id}" level` }
  }
  return null
}

/**
 * Issues where the graph and a decision agent disagree:
 *
 * - the node leaves a `${variable}` its questions use unbound — error
 * - any node reads a path the decision's output does not have (an unknown
 *   question id, a field the answer's type lacks) — error
 * - a Switch case, or a Branch `equals`/`not_equals`, compares a verdict (or a
 *   category option / scale level) against a value the agent never produces —
 *   error, the arm can never fire
 *
 * Nodes PINNED to a version are skipped: the index describes the latest
 * version, and a pin exists precisely to keep an older matrix.
 * TODO: index by version so pinned nodes are checked too (generation-agent
 * bindings share the gap).
 */
export function collectDecisionWiringIssues(
  graph: WorkflowGraph,
  decisions: DecisionWiringIndex,
): GraphIssue[] {
  const issues: GraphIssue[] = []
  const nodes = [...allNodes(graph.nodes)]
  // The decision nodes this lint can judge, by node id.
  const deciders = new Map<string, DecisionWiringEntry>()
  for (const n of nodes) {
    if (n.kind !== 'agent' || n.config.version != null) continue
    const entry = decisions.get(n.config.agentId)
    if (entry) deciders.set(n.id, entry)
  }
  if (deciders.size === 0) return issues

  for (const node of nodes) {
    const base = { nodeId: node.id, nodeLabel: node.label } as const

    const own = deciders.get(node.id)
    if (own) {
      const inputs = (node as AgentNode).config.inputs ?? {}
      const unbound = own.inputVariables.filter((v) => inputs[v] == null)
      if (unbound.length > 0) {
        issues.push({
          ...base,
          severity: 'error',
          message: `Unmapped ${unbound.length === 1 ? 'input' : 'inputs'}: ${unbound
            .map((v) => `\${${v}}`)
            .join(', ')}. "${own.name}" asks its questions with ${unbound.length === 1 ? 'this variable' : 'these variables'}, and an unmapped one reaches the model as literal text. Map each to an upstream value.`,
        })
      }
    }

    for (const { slot, ref } of nodeRefs(node)) {
      const entry = deciders.get(ref.nodeId)
      if (!entry) continue
      const reason = badPathReason(ref.path, entry)
      if (reason) {
        issues.push({
          ...base,
          severity: 'error',
          message: `${slot.charAt(0).toUpperCase()}${slot.slice(1)} reads "${ref.path}", which is always empty: ${reason}. Re-link it to a field the decision produces.`,
        })
      }
    }

    const source =
      node.kind === 'switch' || node.kind === 'branch'
        ? node.config.source
        : undefined
    const entry = source ? deciders.get(source.nodeId) : undefined
    const closed = source && entry ? closedValues(source.path, entry) : null
    if (!closed) continue
    const never = (value: unknown): boolean => {
      return !closed.values.includes(display(value))
    }

    if (node.kind === 'switch') {
      const dead = node.config.cases.filter((c) => {
        return (
          c.value.kind === 'literal' &&
          c.value.value != null &&
          c.value.value !== '' &&
          never(c.value.value)
        )
      })
      for (const c of dead) {
        issues.push({
          ...base,
          severity: 'error',
          message: `Switch case "${c.label ?? c.key}" matches "${display(c.value.kind === 'literal' ? c.value.value : '')}", which is not a ${closed.what} "${entry?.name}" can return (${closed.values.join(', ')}), so this arm never fires.`,
        })
      }
    } else if (
      node.kind === 'branch' &&
      (node.config.operator === 'equals' ||
        node.config.operator === 'not_equals') &&
      node.config.value != null &&
      never(node.config.value)
    ) {
      issues.push({
        ...base,
        severity: 'error',
        message: `Branch compares against "${display(node.config.value)}", which is not a ${closed.what} "${entry?.name}" can return (${closed.values.join(', ')}), so it always takes the ${node.config.operator === 'equals' ? 'no' : 'yes'} arm.`,
      })
    }
  }
  return issues
}
