import { describe, expect, test } from 'bun:test'

import type { WorkflowGraph } from './graph'
import {
  collectDecisionWiringIssues,
  type DecisionWiringIndex,
} from './graph-decision-wiring'
import { workflowGraphShapeSchema } from './graph-schema'

// Every graph below runs without an error — and routes wrong. That is the whole
// reason for the lint: none of these mistakes fails a run, they only send it
// down the fallback.

const decisions: DecisionWiringIndex = new Map([
  [
    'triage',
    {
      name: 'Triage',
      verdicts: ['review', 'proceed', 'escalate'],
      questions: [
        { id: 'needs_review', type: 'boolean', choiceKeys: [] },
        { id: 'topic', type: 'category', choiceKeys: ['billing', 'shipping'] },
        { id: 'urgency', type: 'scale', choiceKeys: ['low', 'mid', 'high'] },
      ],
      inputVariables: ['channel'],
    },
  ],
])

const ref = (path: string) => ({ kind: 'ref', nodeId: 'decide', path })
const lit = (value: unknown) => ({ kind: 'literal', value })

function graph(args: {
  decide?: Record<string, unknown>
  others: Record<string, unknown>[]
}): WorkflowGraph {
  const base = { position: { x: 0, y: 0 }, informUser: { mode: 'off' } }
  return workflowGraphShapeSchema.parse({
    version: 1,
    edges: [],
    nodes: [
      {
        ...base,
        id: 'decide',
        kind: 'agent',
        label: 'Decide',
        config: {
          agentId: 'triage',
          inputs: { channel: lit('email') },
          ...args.decide,
        },
      },
      ...args.others.map((n) => ({ ...base, label: String(n.id), ...n })),
    ],
  })
}

function switchOn(path: string, ...values: unknown[]) {
  return {
    id: 'route',
    kind: 'switch',
    config: {
      source: ref(path),
      cases: values.map((v, i) => ({ key: `c${i}`, value: lit(v) })),
    },
  }
}

/** Exactly one issue per pattern, in order. */
function expectIssues(g: WorkflowGraph, ...patterns: RegExp[]): void {
  const messages = collectDecisionWiringIssues(g, decisions).map((i) => {
    return i.message
  })
  expect(messages).toHaveLength(patterns.length)
  for (const [i, p] of patterns.entries()) expect(messages[i]).toMatch(p)
}

describe('collectDecisionWiringIssues', () => {
  test('a correctly wired decision lints clean', () => {
    const g = graph({
      others: [
        switchOn('verdict', 'review', 'escalate'),
        {
          id: 'out',
          kind: 'output',
          config: { source: ref('answers.urgency.level') },
        },
      ],
    })
    expectIssues(g)
  })

  test('a Switch case naming a verdict the agent never returns', () => {
    const g = graph({ others: [switchOn('verdict', 'review', 'escalatee')] })
    expectIssues(
      g,
      /"escalatee".*not a verdict "Triage" can return/,
    )
  })

  test('cases on a category option or scale level are checked against its keys', () => {
    expectIssues(
      graph({ others: [switchOn('answers.topic.value', 'refunds')] }),
      /"refunds".*"topic" option/,
    )
    expectIssues(
      graph({ others: [switchOn('answers.urgency.level', 'urgent')] }),
      /"urgent".*"urgency" level/,
    )
  })

  test('a Branch equals on a verdict that does not exist', () => {
    const g = graph({
      others: [
        {
          id: 'gate',
          kind: 'branch',
          config: { source: ref('verdict'), operator: 'equals', value: 'escalte' },
        },
      ],
    })
    expectIssues(
      g,
      /always takes the no arm/,
    )
  })

  test('a ref into a renamed question, or a field the type lacks', () => {
    const g = graph({
      others: [
        { id: 'a', kind: 'output', config: { source: ref('answers.needs_human.value') } },
        { id: 'b', kind: 'output', config: { source: ref('answers.topic.probability') } },
        { id: 'c', kind: 'output', config: { source: ref('decision') } },
      ],
    })
    expectIssues(
      g,
      /no question "needs_human"/,
      /category answer has no "probability"/,
      /"decision" is not part of a decision's output/,
    )
  })

  test('an unbound ${variable} the questions use', () => {
    const g = graph({ decide: { inputs: {} }, others: [switchOn('verdict')] })
    expectIssues(
      g,
      /Unmapped input: \$\{channel\}/,
    )
  })

  test('a node pinned to a version is not judged against the latest matrix', () => {
    const g = graph({
      decide: { version: 1, inputs: {} },
      others: [switchOn('verdict', 'escalatee')],
    })
    expectIssues(g)
  })
})
