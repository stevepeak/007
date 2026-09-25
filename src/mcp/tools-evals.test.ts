import { describe, expect, test } from 'bun:test'

import type { WfDataClient } from '../server/protocol'

import type { WfMcpTool } from './tools'
import { evalReadTools, evalWriteTools } from './tools-evals'

/**
 * What these pin is the gap between "the call succeeded" and "the Sample can
 * actually be graded". The dispatcher already rejects a malformed payload; what
 * it cannot catch is a Goal pointed at an id that doesn't exist, a `task` input
 * written for a `conversation` agent, or a trajectory check under frozen tools —
 * all of which store cleanly and fail (or silently grade nothing) later.
 */

function toolNamed(name: string): WfMcpTool {
  const found = [...evalReadTools(), ...evalWriteTools()].find(
    (t) => t.name === name,
  )
  if (!found) throw new Error(`no such tool: ${name}`)
  return found
}

function stubClient(partial: Partial<WfDataClient>): WfDataClient {
  return partial as WfDataClient
}

function agentDetail(over: {
  name?: string
  inputKind?: 'task' | 'conversation'
  inputVariables?: string[]
  latestVersionNumber?: number | null
}) {
  return {
    agent: {
      id: 'ag_1',
      name: over.name ?? 'Conflict check',
      inputKind: over.inputKind ?? 'task',
      inputVariables: over.inputVariables ?? [],
      latestVersionNumber:
        over.latestVersionNumber === undefined ? 4 : over.latestVersionNumber,
    },
    draft: null,
    currentVersion: null,
  } as never
}

describe('create_eval_set target preflight', () => {
  test('refuses an id that resolves to nothing, and creates nothing', async () => {
    let created = false
    const client = stubClient({
      getAgent: async () => null,
      createEvalSet: async () => {
        created = true
        return { setId: 'set_1' }
      },
    })
    const result = (await toolNamed('create_eval_set').run(client, {
      name: 'Goal',
      targetId: 'Conflict check',
    })) as { error: string }
    // `wf_eval_set.target_id` has no FK, so without this the Goal stores fine
    // and only fails when someone runs it.
    expect(result.error).toContain('No agent found')
    expect(result.error).toContain('list_agents')
    expect(created).toBe(false)
  })

  test("hands back the target's input shape with its variables named", async () => {
    const client = stubClient({
      getAgent: async () => { return agentDetail({ inputKind: 'task', inputVariables: ['matterName', 'jurisdiction'] }) },
      createEvalSet: async () => ({ setId: 'set_1' }),
    })
    const result = (await toolNamed('create_eval_set').run(client, {
      name: 'Goal',
      targetId: 'ag_1',
    })) as { setId: string; target: { sampleInputKind: string; inputTemplate: unknown } }
    expect(result.setId).toBe('set_1')
    expect(result.target.sampleInputKind).toBe('task')
    expect(result.target.inputTemplate).toEqual({
      kind: 'task',
      variables: { matterName: '', jurisdiction: '' },
    })
  })

  test('a conversation agent gets a conversation template, never a task one', async () => {
    const client = stubClient({
      getAgent: async () => agentDetail({ inputKind: 'conversation' }),
      createEvalSet: async () => ({ setId: 'set_1' }),
    })
    const result = (await toolNamed('create_eval_set').run(client, {
      name: 'Goal',
      targetId: 'ag_1',
    })) as { target: { inputTemplate: { kind: string; turns: unknown[] } } }
    expect(result.target.inputTemplate.kind).toBe('conversation')
    expect(result.target.inputTemplate.turns).toHaveLength(1)
  })

  test('warns when the target has nothing published to run', async () => {
    const client = stubClient({
      getAgent: async () => agentDetail({ latestVersionNumber: null }),
      createEvalSet: async () => ({ setId: 'set_1' }),
    })
    const result = (await toolNamed('create_eval_set').run(client, {
      name: 'Goal',
      targetId: 'ag_1',
    })) as { target: { warnings: string[] } }
    expect(result.target.warnings.join(' ')).toContain('no published version')
  })

  test('floats to latest unless a version is actually given', async () => {
    let seen: unknown
    const client = stubClient({
      getAgent: async () => agentDetail({}),
      createEvalSet: async (input) => {
        seen = input
        return { setId: 'set_1' }
      },
    })
    await toolNamed('create_eval_set').run(client, {
      name: 'Goal',
      targetId: 'ag_1',
      // A model that "fills in" every field would otherwise pin the goal here.
      targetVersion: null,
    })
    expect((seen as { targetVersion: number | null }).targetVersion).toBeNull()

    await toolNamed('create_eval_set').run(client, {
      name: 'Goal',
      targetId: 'ag_1',
      targetVersion: 3,
    })
    expect((seen as { targetVersion: number | null }).targetVersion).toBe(3)
  })

  test('an agent goal is always recorded under the manual trigger', async () => {
    let seen: unknown
    const client = stubClient({
      getAgent: async () => agentDetail({}),
      createEvalSet: async (input) => {
        seen = input
        return { setId: 'set_1' }
      },
    })
    await toolNamed('create_eval_set').run(client, {
      name: 'Goal',
      targetId: 'ag_1',
    })
    expect((seen as { triggerKind: string }).triggerKind).toBe('manual')
  })
})

describe('create_eval_set against a workflow', () => {
  const workflow = {
    workflow: { id: 'wf_1', name: 'Intake' },
    draft: null,
    currentVersion: {
      id: 'ver_1',
      versionNumber: 2,
      graph: {
        nodes: [
          { id: 'n0', kind: 'trigger', config: { triggerKind: 'chat_message' } },
          { id: 'n1', kind: 'output', config: {} },
        ],
        edges: [],
      },
    },
  } as never

  test("takes the trigger kind from the graph, not from the caller's guess", async () => {
    let seen: unknown
    const client = stubClient({
      getWorkflow: async () => workflow,
      listTriggerEvents: async () => { return [
          {
            kind: 'chat_message',
            description: '',
            fields: [
              { name: 'text', type: 'string', optional: false },
              { name: 'threadId', type: 'string', optional: true },
            ],
          },
        ] as never },
      createEvalSet: async (input) => {
        seen = input
        return { setId: 'set_2' }
      },
    })
    const result = (await toolNamed('create_eval_set').run(client, {
      name: 'Goal',
      targetKind: 'workflow',
      targetId: 'wf_1',
    })) as { target: { sampleInputKind: string; inputTemplate: { payload: unknown } } }
    // A goal recorded under a trigger the graph doesn't declare runs the
    // workflow under the wrong contract.
    expect((seen as { triggerKind: string }).triggerKind).toBe('chat_message')
    expect(result.target.sampleInputKind).toBe('trigger')
    expect(result.target.inputTemplate.payload).toEqual({
      text: null,
      threadId: null,
    })
  })

  test('survives a host whose trigger catalog is unavailable', async () => {
    const client = stubClient({
      getWorkflow: async () => workflow,
      listTriggerEvents: async () => {
        throw new Error('no registry')
      },
      createEvalSet: async () => ({ setId: 'set_2' }),
    })
    const result = (await toolNamed('create_eval_set').run(client, {
      name: 'Goal',
      targetKind: 'workflow',
      targetId: 'wf_1',
    })) as { target: { inputTemplate: { payload: unknown } } }
    expect(result.target.inputTemplate.payload).toEqual({})
  })
})

/**
 * A Goal whose target resolves — `upsert_eval_sample` reads both now, because the
 * lints it returns are checked AGAINST the target (a fixture keyed on a tool the
 * agent doesn't have; a judge `path` naming no declared output field).
 */
function setDetail(over?: {
  rows?: unknown[]
  targetKind?: 'agent' | 'workflow'
}) {
  return {
    set: {
      id: 'set_1',
      name: 'Goal',
      targetKind: over?.targetKind ?? 'agent',
      targetId: 'ag_1',
    },
    rows: over?.rows ?? [],
  } as never
}

describe('upsert_eval_sample', () => {
  const client = stubClient({
    getEvalSet: async () => setDetail(),
    getAgent: async () => agentDetail({}),
    upsertEvalRow: async () => ({ rowId: 'row_1' }),
  })

  test('names the layer the sample actually tests', async () => {
    const result = (await toolNamed('upsert_eval_sample').run(client, {
      setId: 'set_1',
      name: 'Refuses out of scope',
      input: { kind: 'conversation', turns: [], variables: {} },
      tools: { mode: 'frozen' },
      checks: { op: 'and', checks: [{ type: 'llm_judge', rubric: 'Refuses.' }] },
    })) as { rowId: string; layer: string; warnings: string[] }
    expect(result.rowId).toBe('row_1')
    expect(result.layer).toBe('synthesis')
    expect(result.warnings).toEqual([])
  })

  // The silent failure this whole return value exists for.
  test('flags trajectory checks that frozen tools make ungradeable', async () => {
    const result = (await toolNamed('upsert_eval_sample').run(client, {
      setId: 'set_1',
      name: 'Searches first',
      input: { kind: 'conversation', turns: [], variables: {} },
      tools: { mode: 'frozen' },
      checks: {
        op: 'and',
        checks: [{ type: 'tool_called', toolId: 'search_rag', called: true }],
      },
    })) as { warnings: string[] }
    expect(result.warnings.join(' ')).toContain('tool_called')
    expect(result.warnings.join(' ')).toContain('mocked')
  })

  test('flags a declared variable left unfilled', async () => {
    const result = (await toolNamed('upsert_eval_sample').run(client, {
      setId: 'set_1',
      name: 'Empty var',
      input: { kind: 'task', variables: { matterName: '' } },
      tools: { mode: 'mocked', fixtures: {} },
      checks: { op: 'and', checks: [] },
    })) as { warnings: string[] }
    expect(result.warnings.join(' ')).toContain('empty strings')
  })

  test('passes the payloads through untouched for the dispatcher to validate', async () => {
    let seen: unknown
    const passthrough = stubClient({
      getEvalSet: async () => setDetail(),
      getAgent: async () => agentDetail({}),
      upsertEvalRow: async (input) => {
        seen = input
        return { rowId: 'row_1' }
      },
    })
    const input = { kind: 'task', variables: { a: 'b' } }
    await toolNamed('upsert_eval_sample').run(passthrough, {
      setId: 'set_1',
      name: 'Sample',
      input,
      sortOrder: 3,
    })
    expect((seen as { input: unknown }).input).toEqual(input)
    expect((seen as { sortOrder: number }).sortOrder).toBe(3)
  })

  // The server's message names the exact path that is wrong; rewording it here
  // would cost the model the one thing it needs to self-correct.
  test("lets the server's validation message reach the caller verbatim", async () => {
    const rejecting = stubClient({
      getEvalSet: async () => setDetail(),
      getAgent: async () => agentDetail({}),
      upsertEvalRow: async () => {
        throw new Error('Invalid input: expected "task" at input.kind')
      },
    })
    await expect(
      toolNamed('upsert_eval_sample').run(rejecting, {
        setId: 'set_1',
        name: 'Sample',
        input: { kind: 'nope' },
      }),
    ).rejects.toThrow('expected "task" at input.kind')
  })
})

describe('get_eval_set', () => {
  test('carries the target contract alongside the samples', async () => {
    const client = stubClient({
      getEvalSet: async () => { return ({
          set: { id: 'set_1', targetKind: 'agent', targetId: 'ag_1' },
          rows: [
            {
              id: 'row_1',
              name: 'Sample',
              input: { kind: 'task', variables: { blob: 'x'.repeat(20_000) } },
              tools: { mode: 'mocked', fixtures: {} },
              checks: { op: 'and', checks: [] },
            },
          ],
        }) as never },
      getAgent: async () => { return agentDetail({ inputKind: 'conversation', inputVariables: ['tone'] }) },
    })
    const result = (await toolNamed('get_eval_set').run(client, {
      setId: 'set_1',
    })) as {
      target: { sampleInputKind: string }
      rows: { input: unknown }[]
    }
    // Adding a sample to an EXISTING goal needs the same contract creating one
    // does, and a second lookup is a second chance to guess wrong.
    expect(result.target.sampleInputKind).toBe('conversation')
    expect(String(result.rows[0]?.input)).toContain('truncated')
  })

  test('answers with a readable error rather than null', async () => {
    const client = stubClient({ getEvalSet: async () => null })
    expect(
      await toolNamed('get_eval_set').run(client, { setId: 'nope' }),
    ).toEqual({ error: 'No eval goal found for id nope.' })
  })
})

describe('delete_eval_sample', () => {
  test('refuses to run without the id rather than guessing', async () => {
    await expect(
      toolNamed('delete_eval_sample').run(stubClient({}), {}),
    ).rejects.toThrow(/rowId/)
  })

  test('archives the row', async () => {
    let seen: unknown
    const client = stubClient({
      deleteEvalRow: async (rowId) => {
        seen = rowId
        return { ok: true }
      },
    })
    expect(
      await toolNamed('delete_eval_sample').run(client, { rowId: 'row_1' }),
    ).toEqual({ ok: true, rowId: 'row_1', archived: true })
    expect(seen).toBe('row_1')
  })

  // The other half of "nothing is erased". Archiving was always one flag, but
  // with no way to turn it back the only undo was to re-author the Sample and
  // lose the id every past report refers to.
  test('restores an archived row instead of archiving it again', async () => {
    let restored: unknown
    let archived = false
    const client = stubClient({
      deleteEvalRow: async () => {
        archived = true
        return { ok: true }
      },
      restoreEvalRow: async (rowId) => {
        restored = rowId
        return { ok: true }
      },
    })
    expect(
      await toolNamed('delete_eval_sample').run(client, {
        rowId: 'row_1',
        restore: true,
      }),
    ).toEqual({ ok: true, rowId: 'row_1', archived: false })
    expect(restored).toBe('row_1')
    expect(archived).toBe(false)
  })
})

describe('upsert_eval_sample — the target-keyed lints', () => {
  /** An agent with two wired tools and a declared output shape. */
  const targetedClient = (over: Partial<WfDataClient> = {}) => { return stubClient({
      getEvalSet: async () => setDetail(),
      getAgent: async () => { return ({
          agent: {
            id: 'ag_1',
            name: 'Conflict check',
            inputKind: 'task',
            inputVariables: [],
            latestVersionNumber: 3,
          },
          draft: null,
          currentVersion: {
            id: 'v3',
            versionNumber: 3,
            config: {
              toolIds: ['search_rag', 'list_matters'],
              output: {
                kind: 'object',
                schema: {
                  type: 'object',
                  properties: { verdict: { type: 'string' }, why: { type: 'string' } },
                },
              },
            },
          },
        }) as never },
      upsertEvalRow: async () => ({ rowId: 'row_1' }),
      ...over,
    }) }

  // A fixture keyed on a tool the agent cannot call validates, stores, and is
  // never read — the ART-146 failure class, one field over.
  test('flags fixtures keyed on a tool the target does not have', async () => {
    const out = (await toolNamed('upsert_eval_sample').run(targetedClient(), {
      setId: 'set_1',
      name: 'Mocks the wrong tool',
      input: { kind: 'task', variables: {} },
      tools: { mode: 'mocked', fixtures: { serch_rag: { hits: [] } } },
      checks: { op: 'and', checks: [{ type: 'output_match', match: 'equals', value: 'ok' }] },
    })) as { warnings: string[] }
    const text = out.warnings.join(' ')
    expect(text).toContain('serch_rag')
    expect(text).toContain('never be read')
    // And it names what the legal keys actually are.
    expect(text).toContain('search_rag')
  })

  test('accepts a fixture on a tool the target does have', async () => {
    const out = (await toolNamed('upsert_eval_sample').run(targetedClient(), {
      setId: 'set_1',
      name: 'Mocks the right tool',
      input: { kind: 'task', variables: {} },
      tools: { mode: 'mocked', fixtures: { search_rag: { hits: [] } } },
      checks: {
        op: 'and',
        checks: [{ type: 'tool_called', toolId: 'search_rag', called: true }],
      },
    })) as { warnings: string[] }
    expect(out.warnings).toEqual([])
  })

  // A judge `path` that resolves to nothing grades `undefined`, which reads in
  // the report as the agent answering badly.
  test('flags a judge path that names no field of the output schema', async () => {
    const out = (await toolNamed('upsert_eval_sample').run(targetedClient(), {
      setId: 'set_1',
      name: 'Judges a field that is not there',
      input: { kind: 'task', variables: {} },
      tools: { mode: 'mocked', fixtures: {} },
      checks: {
        op: 'and',
        checks: [
          { type: 'llm_judge', rubric: 'Is it right?', path: 'conclusion' },
        ],
      },
    })) as { warnings: string[] }
    const text = out.warnings.join(' ')
    expect(text).toContain('conclusion')
    expect(text).toContain('verdict')
  })

  test('allows a dotted path below a declared field', async () => {
    const out = (await toolNamed('upsert_eval_sample').run(targetedClient(), {
      setId: 'set_1',
      name: 'Judges into a declared field',
      input: { kind: 'task', variables: {} },
      tools: { mode: 'mocked', fixtures: {} },
      // Only the leading segment is knowable here, and `verdict` is declared.
      checks: {
        op: 'and',
        checks: [{ type: 'output_match', path: 'verdict.code', match: 'equals', value: 'x' }],
      },
    })) as { warnings: string[] }
    expect(out.warnings).toEqual([])
  })

  // An unpublished agent has no config to check against, and inventing warnings
  // from its absence would make the lint noise.
  test('says nothing about fixtures when the target has no published version', async () => {
    const unpublished = stubClient({
      getEvalSet: async () => setDetail(),
      getAgent: async () => agentDetail({ latestVersionNumber: null }),
      upsertEvalRow: async () => ({ rowId: 'row_1' }),
    })
    const out = (await toolNamed('upsert_eval_sample').run(unpublished, {
      setId: 'set_1',
      name: 'Anything',
      input: { kind: 'task', variables: {} },
      tools: { mode: 'mocked', fixtures: { whatever: {} } },
      checks: { op: 'and', checks: [{ type: 'output_match', match: 'equals', value: 1 }] },
    })) as { warnings: string[] }
    expect(out.warnings.join(' ')).not.toContain('whatever')
  })

  test('warns that a sample with no checks grades as an error, not a fail', async () => {
    const out = (await toolNamed('upsert_eval_sample').run(targetedClient(), {
      setId: 'set_1',
      name: 'No checks',
      input: { kind: 'task', variables: {} },
      tools: { mode: 'mocked', fixtures: {} },
      checks: { op: 'and', checks: [] },
    })) as { warnings: string[] }
    expect(out.warnings.join(' ')).toContain('NO checks')
  })
})

describe('upsert_eval_sample — editing is a patch', () => {
  const existing = {
    id: 'row_1',
    setId: 'set_1',
    name: 'Refuses',
    input: { kind: 'task', variables: { a: 'b' } },
    tools: { mode: 'mocked', fixtures: {} },
    checks: {
      op: 'and',
      checks: [{ type: 'llm_judge', rubric: 'Refuses politely.' }],
    },
    sortOrder: 0,
    archived: false,
  }

  test('a rename sends no JSON payload and says it replaced nothing', async () => {
    let seen: Record<string, unknown> = {}
    const client = stubClient({
      getEvalSet: async () => setDetail({ rows: [existing] }),
      getAgent: async () => agentDetail({}),
      upsertEvalRow: async (input) => {
        seen = input
        return { rowId: 'row_1' }
      },
    })
    const out = (await toolNamed('upsert_eval_sample').run(client, {
      setId: 'set_1',
      id: 'row_1',
      name: 'Refuses politely',
    })) as { created: boolean; replaced: string[]; warnings: string[] }
    // Nothing is sent, so the storage layer's merge keeps what is there.
    expect(seen.input).toBeUndefined()
    expect(seen.checks).toBeUndefined()
    expect(out.created).toBe(false)
    expect(out.replaced).toEqual([])
    // The receipt describes the MERGED sample: it still has its judge, so it is
    // not warned about as check-less.
    expect(out.warnings.join(' ')).not.toContain('NO checks')
  })

  test('names the fields it did replace', async () => {
    const client = stubClient({
      getEvalSet: async () => setDetail({ rows: [existing] }),
      getAgent: async () => agentDetail({}),
      upsertEvalRow: async () => ({ rowId: 'row_1' }),
    })
    const out = (await toolNamed('upsert_eval_sample').run(client, {
      setId: 'set_1',
      id: 'row_1',
      name: 'Refuses',
      tools: { mode: 'frozen' },
    })) as { replaced: string[]; layer: string }
    expect(out.replaced).toEqual(['tools'])
    // Derived from the merge — the kept `conversation`-less task input plus the
    // new frozen tools is an io test, not synthesis.
    expect(out.layer).toBe('io')
  })

  test('refuses an id that is not in the goal rather than creating a second sample', async () => {
    let wrote = false
    const client = stubClient({
      getEvalSet: async () => setDetail({ rows: [existing] }),
      getAgent: async () => agentDetail({}),
      upsertEvalRow: async () => {
        wrote = true
        return { rowId: 'row_9' }
      },
    })
    const out = (await toolNamed('upsert_eval_sample').run(client, {
      setId: 'set_1',
      id: 'row_nope',
      name: 'Sample',
    })) as { error: string; sampleIds: string[] }
    expect(out.error).toContain('row_nope')
    expect(out.sampleIds).toEqual(['row_1'])
    expect(wrote).toBe(false)
  })
})

describe('update_eval_set', () => {
  const set = {
    id: 'set_1',
    name: 'Conflict check',
    targetKind: 'agent' as const,
    targetId: 'ag_1',
    targetVersion: 4,
    archived: false,
  }

  test('unpins a version pin so the goal floats to latest again', async () => {
    let seen: Record<string, unknown> = {}
    const client = stubClient({
      getEvalSet: async () => ({ set, rows: [] }) as never,
      updateEvalSet: async (input) => {
        seen = input
        return { ok: true as const }
      },
    })
    await toolNamed('update_eval_set').run(client, {
      setId: 'set_1',
      floatTargetVersion: true,
    })
    // NULL is the "float to latest" value on a nullable column, which is why the
    // unpin is its own boolean rather than an overloaded null argument.
    expect(seen.targetVersion).toBeNull()
  })

  test('refuses to pin and unpin in the same call', async () => {
    let wrote = false
    const client = stubClient({
      getEvalSet: async () => ({ set, rows: [] }) as never,
      updateEvalSet: async () => {
        wrote = true
        return { ok: true as const }
      },
    })
    const out = (await toolNamed('update_eval_set').run(client, {
      setId: 'set_1',
      targetVersion: 7,
      floatTargetVersion: true,
    })) as { error: string }
    expect(out.error).toContain('not both')
    expect(wrote).toBe(false)
  })

  // Same preflight as `create_eval_set`, for the same reason: `targetId` has no
  // FK, so a wrong id lands a Goal that only fails when someone runs it.
  test('refuses a repoint to a target that does not exist', async () => {
    let wrote = false
    const client = stubClient({
      getEvalSet: async () => ({ set, rows: [] }) as never,
      getAgent: async () => null,
      updateEvalSet: async () => {
        wrote = true
        return { ok: true as const }
      },
    })
    const out = (await toolNamed('update_eval_set').run(client, {
      setId: 'set_1',
      targetId: 'ag_nope',
    })) as { error: string }
    expect(out.error).toContain('No agent found')
    expect(wrote).toBe(false)
  })

  test('warns when a repoint leaves the existing samples ungradeable', async () => {
    const client = stubClient({
      getEvalSet: async () => { return ({
          set,
          rows: [
            { id: 'row_1', input: { kind: 'task', variables: {} } },
          ],
        }) as never },
      // The new target takes a conversation; the samples are `task`.
      getAgent: async () => agentDetail({ inputKind: 'conversation' }),
      updateEvalSet: async () => ({ ok: true as const }),
    })
    const out = (await toolNamed('update_eval_set').run(client, {
      setId: 'set_1',
      targetId: 'ag_2',
    })) as { warnings?: string[] }
    expect(out.warnings?.join(' ')).toContain('conversation')
  })

  test('a missing goal is an answer, not a silent no-op', async () => {
    // `updateEvalSet` does not check existence — a wrong id updates zero rows
    // and returns ok, which reads as success.
    const client = stubClient({ getEvalSet: async () => null })
    const out = (await toolNamed('update_eval_set').run(client, {
      setId: 'nope',
      name: 'x',
    })) as { error: string }
    expect(out.error).toContain('No eval goal found')
  })
})
