import { describe, expect, test } from 'bun:test'

import type { WfDataClient, WfEvalRowDTO } from '../server/protocol'

import type { WfMcpTool } from './tools'
import { metaWriteTools } from './tools-meta'

/**
 * What these pin is that an edit which reports success actually landed on
 * something. `updateEvalSet` updates by id with no existence check, so a
 * hallucinated id writes zero rows and returns `{ ok: true }` — the one failure
 * mode of a metadata write that looks exactly like a successful one.
 *
 * The Sample case pins the other one: its only writer replaces `input` /
 * `tools` / `checks` with whatever the call passes, so a description edit that
 * forgets to carry them forward silently resets the sample's entire test.
 */

function tool(): WfMcpTool {
  const found = metaWriteTools().find((t) => t.name === 'update_description')
  if (!found) throw new Error('no update_description tool')
  return found
}

function stubClient(partial: Partial<WfDataClient>): WfDataClient {
  return partial as WfDataClient
}

const SAMPLE: WfEvalRowDTO = {
  id: 'row_1',
  setId: 'set_1',
  name: 'Refuses an adverse party',
  description: null,
  input: { kind: 'task', variables: { matter: 'Acme v. Byrd' } },
  tools: { mode: 'mocked', fixtures: { search_rag: { hits: [] } } },
  checks: {
    op: 'and',
    checks: [{ type: 'output_match', match: 'contains', value: 'conflict' }],
  },
  sortOrder: 3,
  archived: false,
}

function setDetail() {
  return {
    set: {
      id: 'set_1',
      name: 'Conflict check — refusals',
      description: 'Old text',
    },
    rows: [SAMPLE],
  } as never
}

describe('update_description resolves before it writes', () => {
  test('refuses an unknown kind without calling anything', async () => {
    const result = (await tool().run(stubClient({}), {
      kind: 'prompt',
      id: 'x',
      description: 'hi',
    })) as { error: string }
    expect(result.error).toContain('Unknown kind')
    expect(result.error).toContain('eval_sample')
  })

  test('a goal id that resolves to nothing is a refusal, not a silent no-op', async () => {
    let wrote = false
    const client = stubClient({
      getEvalSet: async () => null,
      updateEvalSet: async () => {
        wrote = true
        return { ok: true as const }
      },
    })
    const result = (await tool().run(client, {
      kind: 'eval_set',
      id: 'set_nope',
      description: 'New text',
    })) as { error: string }
    // `updateEvalSet` has no existence check: without the preflight this call
    // updates zero rows and reports `{ ok: true }`.
    expect(result.error).toContain('No eval goal found')
    expect(result.error).toContain('list_eval_sets')
    expect(wrote).toBe(false)
  })

  test('reports the text it replaced, so the write is evidenced', async () => {
    let sent: unknown
    const client = stubClient({
      getEvalSet: async () => setDetail(),
      updateEvalSet: async (input) => {
        sent = input
        return { ok: true as const }
      },
    })
    const result = (await tool().run(client, {
      kind: 'eval_set',
      id: 'set_1',
      description: 'Grades refusal on a known adverse party.',
    })) as { before: string | null; after: string; name: string }
    expect(sent).toEqual({
      setId: 'set_1',
      description: 'Grades refusal on a known adverse party.',
    })
    expect(result.before).toBe('Old text')
    expect(result.after).toBe('Grades refusal on a known adverse party.')
    expect(result.name).toBe('Conflict check — refusals')
  })

  test('an empty string clears rather than writing nothing', async () => {
    let sent: { description?: string } | undefined
    const client = stubClient({
      getAgent: async () => {
        return { agent: { name: 'Conflict checker', description: 'stale' } } as never
      },
      updateAgentMeta: async (input) => {
        sent = input
      },
    })
    const result = (await tool().run(client, {
      kind: 'agent',
      id: 'ag_1',
      description: '   ',
    })) as { after: string }
    expect(sent?.description).toBe('')
    expect(result.after).toBe('')
  })

  test('a missing description is a thrown error, not an accidental clear', () => {
    const client = stubClient({ getAgent: async () => ({}) as never })
    expect(
      tool().run(client, { kind: 'agent', id: 'ag_1' }),
    ).rejects.toThrow('description')
  })
})

describe('update_description on a Sample', () => {
  test('carries input, tools and checks forward verbatim', async () => {
    let sent: Parameters<WfDataClient['upsertEvalRow']>[0] | undefined
    const client = stubClient({
      getEvalSet: async () => setDetail(),
      upsertEvalRow: async (input) => {
        sent = input
        return { rowId: 'row_1' }
      },
    })
    const result = (await tool().run(client, {
      kind: 'eval_sample',
      id: 'row_1',
      setId: 'set_1',
      description: 'Mined from the 2026-09 complaint.',
    })) as { before: string | null; after: string }

    // The whole point: `upsertEvalRow` defaults an omitted `input` to
    // `{kind:'task',variables:{}}`, `tools` to mocked-with-no-fixtures and
    // `checks` to an empty tree — a description edit that dropped them would
    // leave a sample that still runs and grades nothing.
    expect(sent?.input).toEqual(SAMPLE.input)
    expect(sent?.tools).toEqual(SAMPLE.tools)
    expect(sent?.checks).toEqual(SAMPLE.checks)
    expect(sent?.name).toBe(SAMPLE.name)
    expect(sent?.sortOrder).toBe(3)
    expect(sent?.description).toBe('Mined from the 2026-09 complaint.')
    expect(result.before).toBe(null)
  })

  test('needs the goal id, and says where to get it', async () => {
    const result = (await tool().run(stubClient({}), {
      kind: 'eval_sample',
      id: 'row_1',
      description: 'x',
    })) as { error: string }
    expect(result.error).toContain('setId')
    expect(result.error).toContain('get_eval_set')
  })

  test('a sample id that is not in the named goal is a refusal', async () => {
    let wrote = false
    const client = stubClient({
      getEvalSet: async () => setDetail(),
      upsertEvalRow: async () => {
        wrote = true
        return { rowId: 'row_x' }
      },
    })
    const result = (await tool().run(client, {
      kind: 'eval_sample',
      id: 'row_other',
      setId: 'set_1',
      description: 'x',
    })) as { error: string }
    // Without this it upserts against an id that exists nowhere: the UPDATE
    // matches no row, and `upsertEvalRow` hands the id straight back, so the
    // reply names the sample it did not touch.
    expect(result.error).toContain('no sample with id')
    expect(wrote).toBe(false)
  })
})

describe('update_description — a run’s triage note', () => {
  // An MCP triage session used to leave no trace on the run it investigated: the
  // finding lived only in a chat transcript, while `list_runs.search` reads the
  // note.
  test('writes the note and reports what it replaced', async () => {
    let seen: unknown
    const client = stubClient({
      getRun: async () => { return ({
          run: {
            id: 'run_1',
            workflowName: 'Legal chat',
            note: 'looks like a 429',
          },
          steps: [],
          logs: [],
        }) as never },
      setRunNote: async (input) => {
        seen = input
        return { ok: true as const }
      },
    })
    const result = (await tool().run(client, {
      kind: 'run',
      id: 'run_1',
      description: 'Venice rate limit; retried on v29 and it passed.',
    })) as { kind: string; before: string; after: string; name: string }
    expect(seen).toEqual({
      runId: 'run_1',
      note: 'Venice rate limit; retried on v29 and it passed.',
    })
    expect(result.kind).toBe('run')
    // Not attributed and not private — the last write wins, so what it replaced
    // is worth showing.
    expect(result.before).toBe('looks like a 429')
    expect(result.name).toBe('Legal chat')
  })

  test('a missing run is a refusal, not a silent no-op', async () => {
    const client = stubClient({ getRun: async () => null })
    const result = (await tool().run(client, {
      kind: 'run',
      id: 'nope',
      description: 'x',
    })) as { error: string }
    expect(result.error).toContain('No run found')
  })
})
