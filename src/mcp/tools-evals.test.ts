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

describe('upsert_eval_sample', () => {
  const client = stubClient({
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
    ).toEqual({ ok: true })
    expect(seen).toBe('row_1')
  })
})
