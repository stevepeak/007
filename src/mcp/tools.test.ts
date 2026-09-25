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
  // an un-flagged `wf-mcp` in silence.
  //
  // Three of these are writes for a reason other than editing a definition:
  // `run_eval` and `run_agent_preview` spend real model calls, and
  // `resume_eval_run` spends the rest of a sweep's — which is the line the flag
  // is actually drawing. `cancel_eval_run` is the inverse and still a write: it
  // moves a run to a terminal status, which no read-only session should do.
  //
  // The two model tools are the odd ones out in a different way: they are the
  // only writes here that are PLATFORM-WIDE rather than scoped to one authored
  // entity, so a read-only session must not reach them even though neither can
  // change what an existing agent runs on.
  test('marks exactly the authoring, launching and editing tools as writes', () => {
    const writes = allTools()
      .filter((t) => !t.readOnly)
      .map((t) => t.name)
      .sort()
    expect(writes).toEqual([
      'cancel_eval_run',
      'create_agent',
      'create_eval_set',
      'create_workflow',
      'delete_eval_sample',
      'discard_agent_draft',
      'discard_workflow_draft',
      'patch_workflow_draft',
      'publish_workflow',
      'refresh_connector',
      'refresh_model_catalog',
      'resume_eval_run',
      'retry_run',
      'run_agent_preview',
      'run_eval',
      'set_model_enabled',
      'triage_feedback',
      'update_agent',
      'update_agent_draft',
      'update_description',
      'update_eval_set',
      'update_workflow',
      'update_workflow_draft',
      'upsert_eval_sample',
    ])
  })

  // The line drawn in `tools-agents.ts`: a draft is reversible and invisible to
  // customers, an AGENT publish floats into every workflow that references the
  // agent. (`publish_workflow` is the deliberate exception — one trigger, two
  // refusal gates; see `tools-workflows.ts`. `create_agent` is not one: its v1 is
  // published into a graph that does not exist yet.) Neither of these belongs to
  // a surface that can be prompted into using it.
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
    expect(selectTools(tools, false).map((t) => t.name)).toEqual([
      'list_agents',
    ])
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
      listChildRuns: async () => [],
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
    const client = stubClient({
      getRun: async () => runDetail(200) as never,
      listChildRuns: async () => [],
    })
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
  const client = stubClient({
    getRun: async () => detail as never,
    listChildRuns: async () => [],
  })

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
  // The facets exist to populate the UI's dropdowns and are noise to a model
  // that already knows the value it wants — but a model that does NOT cannot
  // otherwise discover that "every complaint from this matter" is expressible.
  // So they come back on an unfiltered read and drop out once one is in use.
  test('offers the filter facets until they have been used', async () => {
    const client = stubClient({
      listFeedback: async () => {
        return {
          rows: [],
          correlations: [{ id: 'c1', label: 'A' }],
          raters: [{ id: 'r1', label: 'B' }],
        }
      },
    })
    const offered = (await toolNamed('list_feedback').run(client, {})) as {
      facets?: { correlations: { id: string; label: string | null }[] }
    }
    expect(offered.facets?.correlations).toEqual([{ id: 'c1', label: 'A' }])

    const filtered = (await toolNamed('list_feedback').run(client, {
      correlationIds: ['c1'],
    })) as { facets?: unknown }
    expect(filtered.facets).toBeUndefined()
  })

  test('forwards the client and rater filters the schema used to strip', async () => {
    let seen: Record<string, unknown> = {}
    const client = stubClient({
      listFeedback: async (input) => {
        seen = input
        return { rows: [], correlations: [], raters: [] }
      },
    })
    await toolNamed('list_feedback').run(client, {
      correlationIds: ['matter_7'],
      raterIds: ['user_3'],
    })
    expect(seen).toMatchObject({
      correlationIds: ['matter_7'],
      raterIds: ['user_3'],
    })
  })
})

describe('get_tool_catalog', () => {
  const catalog = [
    {
      id: 'extract_text',
      name: 'Extract text',
      description: 'extracts text',
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

  /** The listing shape: `{ count, tools, note }`, not a bare array. */
  const listing = async (args: Record<string, unknown> = {}) => { return (await toolNamed('get_tool_catalog').run(client, args)) as {
      count: number
      tools: Record<string, unknown>[]
    } }

  test('drops the icon markup the UI needs and a model does not', async () => {
    const out = await listing()
    expect(JSON.stringify(out)).not.toContain('svg')
    expect(out.tools[0]?.name).toBe('Extract text')
    expect(out.tools[0]?.sideEffect).toBe('read')
    expect(out.tools[0]?.requiresContext).toEqual(['clientOrgId'])
  })

  // One word, and it is the only thing in the payload that says where a fix
  // would have to be made: inside the SDK, in this deployment's own repo, or at
  // a third party we do not control.
  test('keeps each tool’s origin', async () => {
    const out = await listing()
    expect(out.tools.map((r) => [r.id, r.origin])).toEqual([
      ['extract_text', 'sdk'],
      ['search_knowledge_base', 'host'],
    ])
  })

  // The catalog lists every tool at once, and the two JSON Schemas are most of
  // a tool's bytes — 48k for one call against the real registry, to answer a
  // question the description already answers.
  test('leaves the argument schemas out of a listing', async () => {
    const out = await listing()
    expect(out.tools[0]).not.toHaveProperty('inputSchema')
    expect(out.tools[0]).not.toHaveProperty('outputSchema')
    expect(out.count).toBe(2)
  })

  test('narrows the listing by query', async () => {
    const out = await listing({ query: 'CORPUS' })
    expect(out.tools.map((t) => t.id)).toEqual(['search_knowledge_base'])
  })

  // The gap the size argument was quietly paying for: no call anywhere in this
  // surface could produce ONE tool's argument shape, so a Tool node's args were
  // written out of description prose — the exact drift ART-146 exists to catch.
  test('returns the schemas for tools asked for by name', async () => {
    const out = (await toolNamed('get_tool_catalog').run(
      stubClient({
        listTools: async () => catalog as never,
        listToolContextFields: async () => [],
      }),
      { toolIds: ['extract_text'] },
    )) as { tools: Record<string, unknown>[] }
    expect(out.tools).toHaveLength(1)
    expect(out.tools[0]?.inputSchema).toEqual({
      type: 'object',
      properties: { q: { type: 'string' } },
    })
    expect(out.tools[0]?.outputSchema).toBeTruthy()
    // Still not the icon.
    expect(JSON.stringify(out)).not.toContain('svg')
  })

  // `requiresContext` is ambient scope the host supplies, never an argument an
  // agent sets — and a tool whose scope is empty quietly matches nothing rather
  // than failing, so knowing what the key MEANS is the point.
  test('explains the context keys on the drill-in', async () => {
    const out = (await toolNamed('get_tool_catalog').run(
      stubClient({
        listTools: async () => catalog as never,
        listToolContextFields: async () => { return [
            {
              key: 'clientOrgId',
              label: 'Client',
              description: 'Which client the search is scoped to.',
              required: true,
            },
          ] as never },
      }),
      { toolIds: ['extract_text'] },
    )) as { tools: { requiresContext: Record<string, unknown>[] }[] }
    expect(out.tools[0]?.requiresContext[0]).toMatchObject({
      key: 'clientOrgId',
      label: 'Client',
      required: true,
    })
  })

  test('names an id that is not in the catalog, and says why one can vanish', async () => {
    const out = (await toolNamed('get_tool_catalog').run(
      stubClient({
        listTools: async () => catalog as never,
        listToolContextFields: async () => [],
      }),
      { toolIds: ['mcp:linear:create_issue'] },
    )) as { tools: unknown[]; missing: string[]; note: string }
    expect(out.tools).toEqual([])
    expect(out.missing).toEqual(['mcp:linear:create_issue'])
    // "The tools vanished" and "the connector disconnected" are the same
    // observation, so the pointer to list_connectors belongs here.
    expect(out.note).toContain('list_connectors')
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
      getRun: async () => {
        return {
          run: { id: 'run_1', status: 'completed' },
          versionNumber: 1,
          workflowVersionId: 'ver_1',
          logs: [],
          steps: [{ cursor: 0, nodeId: 'n0', meta: { p: 'q'.repeat(9000) } }],
        } as never
      },
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

describe('get_run — the fields the projection used to drop', () => {
  function stepped(over: Record<string, unknown> = {}) {
    return {
      run: { id: 'run_1', status: 'completed' },
      versionNumber: 3,
      workflowVersionId: 'ver_1',
      logs: [],
      steps: [
        {
          cursor: 7,
          sequence: 2,
          nodeId: 'br',
          nodeKind: 'branch',
          parentNodeId: null,
          itemIndex: null,
          status: 'completed',
          error: null,
          costUsd: null,
          input: {},
          output: {},
          branchResult: 'no',
          startedAt: 1_000,
          finishedAt: 4_500,
          meta: {},
        },
      ],
      ...over,
    } as never
  }

  const run = (detail: unknown, children: unknown[] = []) => { return toolNamed('get_run').run(
      stubClient({
        getRun: async () => detail as never,
        listChildRuns: async () => children as never,
      }),
      { runId: 'run_1' },
    ) as Promise<{
      steps: Record<string, unknown>[]
      children?: { failed: number; runs: { runId: string }[] }
      logsTruncated?: true
      stepsPartial?: true
    }> }

  // A trace that shows a decision node RAN but not what it decided leaves "why
  // did it go down this path" unanswerable from the step that answered it.
  test('carries the arm a branch took', async () => {
    const out = await run(stepped())
    expect(out.steps[0]?.branchResult).toBe('no')
  })

  // The per-node timing the Inspect card shows — a slow run's shape is these two
  // fields and nothing else.
  test('carries each step’s timing, and does the subtraction', async () => {
    const out = await run(stepped())
    expect(out.steps[0]).toMatchObject({
      startedAt: 1_000,
      finishedAt: 4_500,
      durationMs: 3_500,
    })
  })

  // `cursor` is the identity to address a step by; `sequence` is the order the
  // engine ran them in, which is what a concurrent graph has to be read against.
  test('carries sequence alongside cursor', async () => {
    const out = await run(stepped())
    expect(out.steps[0]).toMatchObject({ cursor: 7, sequence: 2 })
  })

  // A clipped feed presented as the whole story is how "there is no error in the
  // logs" becomes a wrong conclusion.
  test('forwards the server’s truncation flags', async () => {
    const out = await run(stepped({ logsTruncated: true, stepsPartial: true }))
    expect(out.logsTruncated).toBe(true)
    expect(out.stepsPartial).toBe(true)
  })

  // A workflow-call node makes its callee a separate run, so a parent can read
  // green while a child failed — and the child used to be unreachable.
  test('surfaces child runs, with the failed count', async () => {
    const out = await run(stepped(), [
      { id: 'run_child', workflowName: 'Summarize', status: 'failed', error: 'boom', triggerKind: 'manual' },
      { id: 'run_child2', workflowName: 'Summarize', status: 'completed', error: null, triggerKind: 'manual' },
    ])
    expect(out.children?.failed).toBe(1)
    expect(out.children?.runs.map((r) => r.runId)).toEqual([
      'run_child',
      'run_child2',
    ])
  })

  test('omits `children` entirely on a run that called nothing', async () => {
    const out = await run(stepped())
    expect(out.children).toBeUndefined()
  })
})

describe('list_runs — the filters the schema used to strip', () => {
  // A field a schema does not name is a field the dispatcher STRIPS, so passing
  // these was silently doing nothing rather than erroring.
  test('forwards workflowVersionId, since and until', async () => {
    let seen: Record<string, unknown> = {}
    const client = stubClient({
      listRuns: async (input) => {
        seen = input
        return { runs: [], total: 0, limit: 20, offset: 0 }
      },
    })
    await toolNamed('list_runs').run(client, {
      workflowVersionId: 'ver_7',
      since: 1_700_000_000_000,
      until: 1_700_086_400_000,
    })
    expect(seen).toMatchObject({
      workflowVersionId: 'ver_7',
      since: 1_700_000_000_000,
      until: 1_700_086_400_000,
    })
  })

  test('ignores a non-numeric timestamp instead of sending it', async () => {
    let seen: Record<string, unknown> = {}
    const client = stubClient({
      listRuns: async (input) => {
        seen = input
        return { runs: [], total: 0, limit: 20, offset: 0 }
      },
    })
    await toolNamed('list_runs').run(client, { since: 'yesterday' })
    expect(seen.since).toBeUndefined()
  })
})
