import { describe, expect, test } from 'bun:test'

import type { WfDataClient, WfFeedbackRow } from '../server/protocol'

import { allTools, selectTools } from './server'
import { readTools, type WfMcpTool } from './tools'

/**
 * The tools are thin over `WfDataClient`, so what is worth testing is what the
 * thinness hides: that fat payloads are actually bounded before they reach a
 * model, that a model's arguments are clamped rather than trusted, and that the
 * write gate is about which tools EXIST.
 */

function toolNamed(name: string): WfMcpTool {
  const found = readTools().find((t) => t.name === name)
  if (!found) throw new Error(`no such tool: ${name}`)
  return found
}

/** A client with only the methods a given case exercises. */
function stubClient(partial: Partial<WfDataClient>): WfDataClient {
  return partial as WfDataClient
}

describe('the tool catalog', () => {
  // Pinned as a LIST, not a count: `readOnly` is the only thing standing between
  // a read-only session and a mutation, and it is one boolean per definition. A
  // tool added with the flag left at its neighbor's value would otherwise reach
  // both the copilot and an un-flagged `wf-mcp` in silence.
  //
  // Two of these are writes for a reason other than editing a definition:
  // `run_eval` and `run_agent_preview` spend real model calls, which is the line
  // the flag is actually drawing.
  test('marks exactly the authoring, launching and editing tools as writes', () => {
    const writes = allTools()
      .filter((t) => !t.readOnly)
      .map((t) => t.name)
      .sort()
    expect(writes).toEqual([
      'create_eval_set',
      'delete_eval_sample',
      'run_agent_preview',
      'run_eval',
      'update_agent_draft',
      'upsert_eval_sample',
    ])
  })

  // The line drawn in `tools-agents.ts`: a draft is reversible and invisible to
  // customers, a publish floats into every workflow that references the agent.
  // Neither belongs to a surface that can be prompted into using it.
  test('exposes no publish and no live tool execution at all', () => {
    const names = new Set(allTools().map((t) => t.name))
    for (const forbidden of [
      'publish_agent',
      'run_tool_preview',
      'delete_eval_set',
      'delete_all_runs',
    ]) {
      expect(names.has(forbidden)).toBe(false)
    }
  })

  test('names are unique — a duplicate would silently shadow', () => {
    const names = allTools().map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
  })

  // A schema a strict-mode client drops is worse than a loose one: nothing says
  // so, and the model's arguments arrive unvalidated anyway.
  test('declares no JSON-Schema construct strict clients drop', () => {
    for (const t of allTools()) {
      const json = JSON.stringify(t.inputSchema)
      expect(json).not.toContain('minItems')
      expect(json).not.toContain('oneOf')
    }
  })
})

describe('selectTools', () => {
  const tools: WfMcpTool[] = [
    { ...toolNamed('list_agents') },
    { ...toolNamed('list_agents'), name: 'write_thing', readOnly: false },
  ]

  test('omits mutating tools entirely when writes are off', () => {
    expect(selectTools(tools, false).map((t) => t.name)).toEqual(['list_agents'])
  })

  test('includes them when writes are on', () => {
    expect(selectTools(tools, true)).toHaveLength(2)
  })
})

describe('get_run', () => {
  const fatMeta = { prompt: 'x'.repeat(20_000) }

  function runDetail(stepCount: number) {
    return {
      run: { id: 'run_1', status: 'completed' },
      versionNumber: 3,
      workflowVersionId: 'ver_1',
      logs: [],
      steps: Array.from({ length: stepCount }, (_, i) => ({
        cursor: i,
        nodeId: `n${i}`,
        nodeKind: 'agent',
        parentNodeId: null,
        itemIndex: null,
        status: 'completed',
        error: null,
        costUsd: null,
        input: {},
        output: {},
        meta: fatMeta,
      })),
    }
  }

  test('truncates a step meta that would swamp the context window', async () => {
    const client = stubClient({
      getRun: async () => runDetail(1) as never,
    })
    const result = (await toolNamed('get_run').run(client, {
      runId: 'run_1',
    })) as { steps: { meta: unknown }[] }
    const meta = result.steps[0]?.meta
    expect(typeof meta).toBe('string')
    expect(String(meta)).toContain('truncated')
    expect(String(meta).length).toBeLessThan(4200)
  })

  // The tail, not the head: a run that failed, failed at the end.
  test('keeps the newest steps and says how many it dropped', async () => {
    const client = stubClient({ getRun: async () => runDetail(200) as never })
    const result = (await toolNamed('get_run').run(client, {
      runId: 'run_1',
    })) as { steps: unknown[] }
    expect(result.steps).toHaveLength(61)
    expect(String(result.steps[0])).toContain('140 earlier steps omitted')
    expect((result.steps.at(-1) as { nodeId: string }).nodeId).toBe('n199')
  })

  test('answers with a readable error rather than null', async () => {
    const client = stubClient({ getRun: async () => null })
    expect(await toolNamed('get_run').run(client, { runId: 'nope' })).toEqual({
      error: 'No run found for id nope.',
    })
  })
})

describe('get_run_step', () => {
  const detail = {
    run: { id: 'run_1' },
    versionNumber: 1,
    workflowVersionId: 'ver_1',
    logs: [],
    steps: [
      { cursor: 7, nodeId: 'n1', meta: { prompt: 'z'.repeat(50_000) } },
      { cursor: 9, nodeId: 'n2', meta: null },
    ],
  }
  const client = stubClient({ getRun: async () => detail as never })

  // The whole point of clipping the overview: whatever it dropped has to be
  // reachable, or the truncation is just data loss.
  test('returns a field the overview would have truncated', async () => {
    const step = (await toolNamed('get_run_step').run(client, {
      runId: 'run_1',
      cursor: 7,
    })) as { meta: { prompt: string } }
    expect(step.meta.prompt).toHaveLength(50_000)
  })

  test('names the cursors it does have when given a wrong one', async () => {
    const result = (await toolNamed('get_run_step').run(client, {
      runId: 'run_1',
      cursor: 999,
    })) as { error: string; availableCursors: number[] }
    expect(result.error).toContain('no step with cursor 999')
    expect(result.availableCursors).toEqual([7, 9])
  })

  test('rejects a cursor that is not a number', async () => {
    await expect(
      toolNamed('get_run_step').run(client, { runId: 'run_1', cursor: '7' }),
    ).rejects.toThrow(/cursor/)
  })
})

describe('list_runs', () => {
  test('clamps a model-supplied limit instead of trusting it', async () => {
    let seen: unknown
    const client = stubClient({
      listRuns: async (input) => {
        seen = input
        return { runs: [], total: 0, limit: 0, offset: 0 }
      },
    })
    await toolNamed('list_runs').run(client, { limit: 5000 })
    expect((seen as { limit: number }).limit).toBe(100)

    await toolNamed('list_runs').run(client, { limit: 0 })
    expect((seen as { limit: number }).limit).toBe(1)

    await toolNamed('list_runs').run(client, {})
    expect((seen as { limit: number }).limit).toBe(20)
  })

  // `.nullish()` means an omitted filter arrives as null, and a null forwarded
  // as a filter value would match nothing.
  test('drops null filters rather than forwarding them', async () => {
    let seen: unknown
    const client = stubClient({
      listRuns: async (input) => {
        seen = input
        return { runs: [], total: 0, limit: 0, offset: 0 }
      },
    })
    await toolNamed('list_runs').run(client, { status: null, search: null })
    expect((seen as { status?: string }).status).toBeUndefined()
    expect((seen as { search?: string }).search).toBeUndefined()
  })
})

describe('list_feedback', () => {
  // Only the fields these cases read; the rest of the row is irrelevant here.
  const rows = Array.from({ length: 40 }, (_, i) => ({
    subjectId: `s${i}`,
    rating: 'down',
    body: 'y'.repeat(5000),
  })) as unknown as WfFeedbackRow[]

  test('forwards only a rating it recognises', async () => {
    let seen: unknown
    const client = stubClient({
      listFeedback: async (input) => {
        seen = input
        return { rows: [], correlations: [], raters: [] }
      },
    })
    await toolNamed('list_feedback').run(client, { rating: 'down' })
    expect((seen as { ratings?: string[] }).ratings).toEqual(['down'])

    await toolNamed('list_feedback').run(client, { rating: 'sideways' })
    expect((seen as { ratings?: string[] }).ratings).toBeUndefined()
  })

  test('caps the rows and clips each answer excerpt', async () => {
    const client = stubClient({
      listFeedback: async () => ({ rows, correlations: [], raters: [] }),
    })
    const result = (await toolNamed('list_feedback').run(client, {})) as {
      total: number
      rows: { body: unknown }[]
    }
    expect(result.total).toBe(40)
    expect(result.rows).toHaveLength(25)
    expect(String(result.rows[0]?.body)).toContain('truncated')
  })

  // The facet arrays drive the UI's filter dropdowns and are noise to a model
  // that filters by naming the value it wants.
  test('drops the filter facets', async () => {
    const client = stubClient({
      listFeedback: async () =>
        ({
          rows: [],
          correlations: [{ id: 'c1', label: 'A' }],
          raters: [{ id: 'r1', label: 'B' }],
        }),
    })
    const result = await toolNamed('list_feedback').run(client, {})
    expect(Object.keys(result as object).sort()).toEqual(['rows', 'total'])
  })
})

describe('get_tool_catalog', () => {
  const catalog = [
    {
      id: 'tavily_search',
      name: 'Web search',
      description: 'searches',
      kind: 'ai-tool',
      origin: 'sdk',
      sideEffect: 'read',
      requiresContext: ['clientOrgId'],
      // Inline brand markup for the UI's chips — kilobytes that say nothing
      // about what the tool does, listed once per tool in the catalog.
      icon: `<svg>${'d'.repeat(30_000)}</svg>`,
      inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
      outputSchema: { type: 'object', properties: { r: { type: 'string' } } },
    },
    {
      id: 'search_knowledge_base',
      name: 'Knowledge base',
      description: 'searches the client corpus',
      kind: 'ai-tool',
      origin: 'host',
      sideEffect: 'read',
    },
  ]
  const client = stubClient({ listTools: async () => catalog as never })

  test('drops the icon markup the UI needs and a model does not', async () => {
    const rows = (await toolNamed('get_tool_catalog').run(
      client,
      {},
    )) as Record<string, unknown>[]
    expect(JSON.stringify(rows)).not.toContain('svg')
    expect(rows[0]?.name).toBe('Web search')
    expect(rows[0]?.sideEffect).toBe('read')
    expect(rows[0]?.requiresContext).toEqual(['clientOrgId'])
  })

  // One word, and it is the only thing in the payload that says where a fix
  // would have to be made: inside the SDK, or in this deployment's own repo.
  test('keeps each tool’s origin', async () => {
    const rows = (await toolNamed('get_tool_catalog').run(
      client,
      {},
    )) as Record<string, unknown>[]
    expect(rows.map((r) => [r.id, r.origin])).toEqual([
      ['tavily_search', 'sdk'],
      ['search_knowledge_base', 'host'],
    ])
  })

  // The catalog lists every tool at once, and the two JSON Schemas are most of
  // a tool's bytes — 48k for one call against the real registry, to answer a
  // question the description already answers.
  test('leaves the argument schemas out of a listing', async () => {
    const rows = (await toolNamed('get_tool_catalog').run(
      client,
      {},
    )) as Record<string, unknown>[]
    expect(rows[0]).not.toHaveProperty('inputSchema')
    expect(rows[0]).not.toHaveProperty('outputSchema')
  })
})

describe('get_feedback_context', () => {
  const feedback: Partial<WfFeedbackRow> = {
    subjectId: 'msg_1',
    rating: 'down',
    runId: 'run_1',
  }

  test('answers with the complaint and the run that caused it', async () => {
    const client = stubClient({
      getFeedbackForSubjects: async () => [feedback as WfFeedbackRow],
      getRun: async () =>
        ({
          run: { id: 'run_1', status: 'completed' },
          versionNumber: 1,
          workflowVersionId: 'ver_1',
          logs: [],
          steps: [{ cursor: 0, nodeId: 'n0', meta: { p: 'q'.repeat(9000) } }],
        }) as never,
    })
    const result = (await toolNamed('get_feedback_context').run(client, {
      subjectId: 'msg_1',
    })) as { feedback: unknown; run: { steps: { meta: unknown }[] } }
    expect(result.feedback).toEqual(feedback)
    // The same shape, and the same budget, `get_run` reports a trace in.
    expect(String(result.run.steps[0]?.meta)).toContain('truncated')
  })

  // A rating and a note are worth reading on their own; a purged run is the
  // answer to "why", not a reason to fail the call.
  test('still returns the rating when the run is gone', async () => {
    const client = stubClient({
      getFeedbackForSubjects: async () => [
        { ...feedback, runId: null } as WfFeedbackRow,
      ],
    })
    expect(
      await toolNamed('get_feedback_context').run(client, {
        subjectId: 'msg_1',
      }),
    ).toEqual({ feedback: { ...feedback, runId: null }, run: null })
  })

  test('says so when nothing was ever rated on that subject', async () => {
    const client = stubClient({ getFeedbackForSubjects: async () => [] })
    expect(
      await toolNamed('get_feedback_context').run(client, {
        subjectId: 'nope',
      }),
    ).toEqual({ error: 'No feedback found for subject nope.' })
  })
})
