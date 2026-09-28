import { describe, expect, test } from 'bun:test'

import {
  checkResultSchema,
  checkTreeSchema,
  defaultEvalTools,
  describeCheckVocabulary,
  evalCheckSchema,
  EVAL_CHECK_TYPES,
  evalSampleInputSchema,
  evalSampleLayer,
  evalToolsSchema,
  isJudgeCheck,
  legacyFreezeTools,
  parseEvalSampleInput,
  parseEvalTools,
  toolFixtures,
  toolModes,
  toolSetting,
  type CheckTree,
  type EvalSampleInput,
} from './checks'

// Phase 2 — the shared check vocabulary. These pure zod schemas are validated at
// the data-access boundary (on every row upsert) and reused by the Phase 3
// grader, so their shape is load-bearing. No DB, no engine.

describe('eval checks schema', () => {
  test('accepts each binary check type', () => {
    for (const check of [
      { type: 'tool_called', toolId: 'issue_refund', called: true },
      {
        type: 'tool_args_match',
        toolId: 'issue_refund',
        path: 'amount',
        match: 'equals',
        value: 100,
      },
      { type: 'node_visited', nodeId: 'ask_order_id', visited: false },
      {
        type: 'node_input_match',
        nodeId: 'ask_order_id',
        match: 'contains',
        value: 'missing id',
      },
      { type: 'output_match', match: 'regex', value: 'ETA' },
    ] as const) {
      expect(evalCheckSchema.parse(check)).toEqual(check)
    }
  })

  test('accepts a judge check and applies no defaults (optional stay absent)', () => {
    const judge = { type: 'llm_judge', rubric: 'asks politely' } as const
    const parsed = evalCheckSchema.parse(judge)
    expect(parsed).toEqual(judge)
    expect(isJudgeCheck(parsed)).toBe(true)
  })

  test('rejects an unknown check type', () => {
    expect(() => {
      return evalCheckSchema.parse({ type: 'telepathy', vibes: 'good' })
    }).toThrow()
  })

  test('a judge is rubric + where to look + who looks — nothing else', () => {
    // The old `bar` / `threshold` / `weight` knobs are gone; a stored one is an
    // unknown key, so zod drops it rather than failing a saved row.
    expect(
      evalCheckSchema.parse({
        type: 'llm_judge',
        rubric: 'x',
        path: 'title',
        modelId: 'm1',
        bar: 'nails_it',
        threshold: 0.7,
        weight: 2,
      }),
    ).toEqual({ type: 'llm_judge', rubric: 'x', path: 'title', modelId: 'm1' })
  })

  test('check tree reduces an op over a list', () => {
    const tree: CheckTree = {
      op: 'or',
      checks: [
        { type: 'tool_called', toolId: 't', called: true },
        { type: 'llm_judge', rubric: 'good', modelId: 'm1' },
      ],
    }
    expect(checkTreeSchema.parse(tree)).toEqual(tree)
    expect(
      checkTreeSchema.parse(tree).checks.filter(isJudgeCheck),
    ).toHaveLength(1)
  })

  test('a sample input is one tagged variant, never a bag of everything', () => {
    expect(evalSampleInputSchema.parse({ kind: 'task' })).toEqual({
      kind: 'task',
      variables: {},
    })
    const convo: EvalSampleInput = {
      kind: 'conversation',
      turns: [{ role: 'user', text: 'hi' }],
      variables: { userId: 'u1' },
    }
    expect(evalSampleInputSchema.parse(convo)).toEqual(convo)
    // The old shape is not a valid input — it has to go through the upgrade.
    expect(() => {
      return evalSampleInputSchema.parse({ promptVariables: { a: 'b' } })
    }).toThrow()
  })

  test('tools are settled per tool, and a tool defaults to mocked', () => {
    expect(evalToolsSchema.parse({})).toEqual({
      fallback: 'mocked',
      byTool: {},
    })
    // A tool named with no mode is mocked — which is why the list can render a
    // row for every tool without first writing a setting for each one.
    expect(evalToolsSchema.parse({ byTool: { search: {} } })).toEqual({
      fallback: 'mocked',
      byTool: { search: { mode: 'mocked' } },
    })
    expect(
      evalToolsSchema.parse({
        byTool: { search: { mode: 'live' }, memory: { output: { a: 1 } } },
      }).byTool,
    ).toEqual({
      search: { mode: 'live' },
      memory: { mode: 'mocked', output: { a: 1 } },
    })
  })

  test('an unlisted tool takes the fallback', () => {
    const tools = evalToolsSchema.parse({
      fallback: 'live',
      byTool: { search: { mode: 'mocked', output: { a: 1 } } },
    })
    expect(toolSetting(tools, 'search')).toEqual({
      mode: 'mocked',
      output: { a: 1 },
    })
    expect(toolSetting(tools, 'never_configured')).toEqual({ mode: 'live' })
  })

  test('only a mocked tool with something pinned becomes a fixture', () => {
    const tools = evalToolsSchema.parse({
      byTool: {
        pinned: { mode: 'mocked', output: { a: 1 } },
        unpinned: { mode: 'mocked' },
        // Keeps its output across a trip to Live, but must not be handed one.
        live: { mode: 'live', output: { a: 2 } },
      },
    })
    expect(toolFixtures(tools)).toEqual({ pinned: { a: 1 } })
    expect(toolModes(tools)).toEqual({
      pinned: 'mocked',
      unpinned: 'mocked',
      live: 'live',
    })
  })
})

// The upgrade every stored row goes through on read. Rows written before the
// split kept four overlapping fields in one column; these are the exact shapes
// that exist in the wild.
describe('legacy row upgrade', () => {
  test('prompt variables become a task input', () => {
    expect(
      parseEvalSampleInput({
        triggerInput: { text: 'doc' },
        promptVariables: { text: 'doc' },
      }),
    ).toEqual({ kind: 'task', variables: { text: 'doc' } })
  })

  test('seeded messages become a conversation input', () => {
    const seeded = [{ role: 'user' as const, text: 'hi' }]
    expect(
      parseEvalSampleInput({ seededMessages: seeded, promptVariables: {} }),
    ).toEqual({ kind: 'conversation', turns: seeded, variables: {} })
  })

  test('a bare routed payload becomes a trigger input', () => {
    expect(parseEvalSampleInput({ triggerInput: { chatId: 'c1' } })).toEqual({
      kind: 'trigger',
      payload: { chatId: 'c1' },
      variables: {},
    })
  })

  test('an empty legacy column is an empty task input', () => {
    expect(parseEvalSampleInput({})).toEqual({ kind: 'task', variables: {} })
  })

  test('an already-upgraded input passes through untouched', () => {
    const input = { kind: 'task' as const, variables: { a: 'b' } }
    expect(parseEvalSampleInput(input)).toEqual(input)
  })

  test('a bare fixtures record becomes one pinned tool each', () => {
    expect(parseEvalTools({ search: { docs: [] } })).toEqual({
      fallback: 'mocked',
      byTool: { search: { mode: 'mocked', output: { docs: [] } } },
    })
  })

  test('the sample-wide mocked mode keeps every fixture, tool for tool', () => {
    // The behavior has to be identical: the same tools return the same results.
    expect(
      parseEvalTools({ mode: 'mocked', fixtures: { search: { docs: [] } } }),
    ).toEqual({
      fallback: 'mocked',
      byTool: { search: { mode: 'mocked', output: { docs: [] } } },
    })
  })

  test('the sample-wide live mode survives as the fallback', () => {
    // "Every read tool runs for real" never recorded WHICH tools it covered, so
    // there is nothing to write per tool — the fallback is the only lossless
    // place to put it, and every row in the list still reads as Live.
    expect(parseEvalTools({ mode: 'live' })).toEqual({
      fallback: 'live',
      byTool: {},
    })
  })

  test('a frozen row becomes all-mocked — tools can no longer be taken away', () => {
    // Its tools now EXIST and return `{}` rather than being absent. A synthesis
    // sample still grades the answer it synthesizes from its staged turns, but
    // the agent can reach for a tool instead of having none.
    expect(parseEvalTools({ mode: 'frozen' })).toEqual(defaultEvalTools())
    const legacyInput = { freezeTools: true, promptVariables: {} }
    expect(
      parseEvalTools({ search: { docs: [] } }, legacyFreezeTools(legacyInput)),
    ).toEqual(defaultEvalTools())
  })
})

describe('derived sample layer', () => {
  const task = { kind: 'task' as const, variables: {} }
  const convo = { kind: 'conversation' as const, turns: [], variables: {} }

  test('names the layer a sample actually belongs to', () => {
    expect(evalSampleLayer(task, defaultEvalTools())).toBe('io')
    expect(
      evalSampleLayer(task, {
        fallback: 'mocked',
        byTool: { s: { mode: 'mocked', output: {} } },
      }),
    ).toBe('trajectory')
    expect(
      evalSampleLayer(task, { fallback: 'mocked', byTool: { s: { mode: 'live' } } }),
    ).toBe('integration')
    expect(evalSampleLayer(convo, { fallback: 'live', byTool: {} })).toBe(
      'integration',
    )
  })

  test('one live tool decides the layer, however much else is pinned', () => {
    // The strongest claim wins: a sample with anything running for real is not
    // reproducible, and that is the fact worth putting on the badge.
    expect(
      evalSampleLayer(task, {
        fallback: 'mocked',
        byTool: {
          pinned: { mode: 'mocked', output: {} },
          real: { mode: 'live' },
        },
      }),
    ).toBe('integration')
  })

  test('check result carries an optional confidence + reason', () => {
    // A binary check has nothing to add to its own pass flag.
    expect(checkResultSchema.parse({ pass: true })).toEqual({ pass: true })
    expect(
      checkResultSchema.parse({ pass: false, confidence: 9, reason: 'nope' }),
    ).toEqual({ pass: false, confidence: 9, reason: 'nope' })
    // Confidence is out of 10, not a 0..1 float.
    expect(() => {
      return checkResultSchema.parse({ pass: true, confidence: 11 })
    }).toThrow()
  })
})

describe('describeCheckVocabulary', () => {
  // The MCP's `upsert_eval_sample` description is the only thing telling a model
  // what a check may contain, and it hardcoded the list until it drifted: six
  // types, no `decision_judge`, neither judge's `modelId`. Generating it is the
  // fix; this is what keeps it generated.
  test('names every check type in the union', () => {
    const lines = describeCheckVocabulary()
    expect(lines).toHaveLength(EVAL_CHECK_TYPES.length)
    for (const type of EVAL_CHECK_TYPES) {
      expect(lines.some((l) => l.startsWith(`${type} {`))).toBe(true)
    }
  })

  test('carries the fields a picker would render, optionality included', () => {
    const lines = describeCheckVocabulary()
    const decision = lines.find((l) => l.startsWith('decision_judge'))
    // The three fields whose absence from the prose made a calibrated judge
    // unauthorable over MCP.
    expect(decision).toContain('rubric')
    expect(decision).toContain('modelId?')
    expect(decision).toContain('threshold?')
  })

  test('marks `value` as required — it is z.unknown(), not .optional()', () => {
    // A match check with no `value` compares against undefined. Deriving
    // optionality from "accepts undefined" would advertise it as omittable.
    const line = describeCheckVocabulary().find((l) => { return l.startsWith('output_match') },
    )
    expect(line).toContain('value')
    expect(line).not.toContain('value?')
    expect(line).toContain('path?')
  })
})
