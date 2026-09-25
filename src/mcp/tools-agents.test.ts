import { describe, expect, test } from 'bun:test'

import { makeAgentConfig } from '../engine/agent-test-helpers'
import type {
  AgentConfig,
  AgentPreviewInput,
  AgentPreviewResult,
  ModelOption,
  ToolOption,
  WfAgentDetail,
  WfDataClient,
} from '../server/protocol'

import type { WfMcpTool } from './tools'
import { agentReadTools, agentWriteTools } from './tools-agents'

/**
 * These three tools are the only ones in the catalog that create or change an
 * agent, or spend a model call on one, so what is worth pinning is the boundary:
 * what they refuse to do, and whether a caller can tell what they just did.
 */

function toolNamed(name: string): WfMcpTool {
  const found = [...agentReadTools(), ...agentWriteTools()].find(
    (t) => t.name === name,
  )
  if (!found) throw new Error(`no such tool: ${name}`)
  return found
}

function stubClient(partial: Partial<WfDataClient>): WfDataClient {
  return partial as WfDataClient
}

const published = makeAgentConfig({ prompt: 'Be brief.', maxTurns: 3 })

function detail(over: Partial<WfAgentDetail> = {}): WfAgentDetail {
  return {
    agent: { id: 'a1', name: 'Intake' } as WfAgentDetail['agent'],
    draft: null,
    currentVersion: { id: 'v1', versionNumber: 2, config: published },
    ...over,
  }
}

/** The enabled catalog a create preflight reads. */
function models(): ModelOption[] {
  return [
    { id: 'venice:qwen', label: 'Qwen', capabilities: { tools: true } },
    { id: 'venice:tiny', label: 'Tiny', capabilities: { tools: false } },
  ]
}

function tools(): ToolOption[] {
  return [
    {
      id: 'search_matters',
      name: 'Search matters',
      description: 'finds matters',
      kind: 'function',
      origin: 'host',
    },
  ]
}

/** A client that would accept any create, so a refusal is the tool's own. */
function createClient(over: Partial<WfDataClient> = {}): WfDataClient {
  return stubClient({
    listModels: async () => models(),
    listTools: async () => tools(),
    createAgent: async () => ({ agentId: 'new1', versionId: 'v1' }),
    ...over,
  })
}

/**
 * The minimum a config needs. Written in the INPUT shape a caller would send
 * rather than via `makeAgentConfig`, because what these cases exercise is the
 * defaulting and the refusals a hand-written config runs into.
 */
const minimal = {
  modelId: 'venice:qwen',
  prompt: 'You check for conflicts.',
  userPrompt: 'Check this matter:\n\n${matter}',
}

describe('create_agent', () => {
  const tool = toolNamed('create_agent')

  test('creates the agent with a fully defaulted config', async () => {
    const calls: { name: string; config: AgentConfig }[] = []
    const client = createClient({
      createAgent: async (input) => {
        calls.push(input)
        return { agentId: 'new1', versionId: 'v1' }
      },
    })
    const result = (await tool.run(client, {
      name: 'Conflict checker',
      config: minimal,
      description: 'Screens a new matter against existing clients.',
    })) as { ok: boolean; agentId: string; inputContract: { variables: string[] } }

    expect(result.ok).toBe(true)
    expect(result.agentId).toBe('new1')
    // The caller sent three fields; what is STORED is the parsed config, so a
    // defaulted field can never be missing from a version the engine will read.
    expect(calls[0]?.config).toEqual(
      makeAgentConfig({ ...minimal, modelId: 'venice:qwen' }),
    )
    // The bindings a node pointing at this agent will have to map — the thing
    // the caller needs next and would otherwise re-derive.
    expect(result.inputContract.variables).toEqual(['matter'])
  })

  // A new agent seeds a published v1 (as the console's own button does), and
  // that is only safe while nothing can point at it yet — so the receipt has to
  // say so rather than leave the caller to assume a draft.
  test('says the version is live and that nothing references it', async () => {
    const result = (await tool.run(createClient(), {
      name: 'Conflict checker',
      config: minimal,
    })) as { versionNumber: number; note: string }
    expect(result.versionNumber).toBe(1)
    expect(result.note).toContain('no workflow references this agent yet')
  })

  test('publishing a later version is not reachable from here', async () => {
    const client = createClient({
      publishAgent: async () => {
        throw new Error('publish must not be reachable from a tool')
      },
    })
    const result = (await tool.run(client, {
      name: 'Conflict checker',
      config: minimal,
    })) as { ok: boolean }
    expect(result.ok).toBe(true)
  })

  // Everything below is the preflight, and every case is the same failure: an id
  // or a field a model wrote from memory. Nothing may be written on any of them.
  function refusingClient(): WfDataClient {
    return createClient({
      createAgent: async () => {
        throw new Error('nothing may be created on a refusal')
      },
    })
  }

  test('reports every invalid field rather than the first', async () => {
    const result = (await tool.run(refusingClient(), {
      name: 'Broken',
      config: { modelId: 'venice:qwen', prompt: '', userPrompt: '' },
    })) as { error: string }
    expect(result.error).toContain('prompt')
    // The refinement that explains how data reaches a task agent at all.
    expect(result.error).toContain('userPrompt')
  })

  test('refuses a config that is not an object', async () => {
    const result = (await tool.run(refusingClient(), {
      name: 'Broken',
      config: 'be brief',
    })) as { error: string }
    expect(result.error).toContain('modelId')
  })

  test('refuses a model id that is not enabled, and names the ones that are', async () => {
    const result = (await tool.run(refusingClient(), {
      name: 'Conflict checker',
      config: { ...minimal, modelId: 'qwen' },
    })) as { error: string }
    // The composite-vs-native trap: the provider-native half alone 404s.
    expect(result.error).toContain('venice:qwen')
  })

  test('refuses a tool id that is not in the catalog', async () => {
    const result = (await tool.run(refusingClient(), {
      name: 'Conflict checker',
      config: { ...minimal, toolIds: ['search_matters', 'search_everything'] },
    })) as { error: string }
    expect(result.error).toContain('search_everything')
    // Only the unknown one is named — the real id is not the caller's problem.
    expect(result.error).not.toContain('search_matters')
  })

  // The editor never offers a model that cannot run what the agent is
  // configured to need; a tool call has no disabled dropdown row, so the same
  // gate has to be here or nowhere.
  test('refuses a model that cannot call the tools the agent is given', async () => {
    const result = (await tool.run(refusingClient(), {
      name: 'Conflict checker',
      config: {
        ...minimal,
        modelId: 'venice:tiny',
        toolIds: ['search_matters'],
      },
    })) as { error: string }
    expect(result.error).toContain('no tool calling')
    // And where to go instead.
    expect(result.error).toContain('venice:qwen')
  })

  test('a model with unknown capabilities is not gated', async () => {
    const client = createClient({
      listModels: async () => [{ id: 'venice:qwen', label: 'Qwen' }],
    })
    const result = (await tool.run(client, {
      name: 'Conflict checker',
      config: { ...minimal, toolIds: ['search_matters'] },
    })) as { ok?: boolean; error?: string }
    expect(result.error).toBeUndefined()
    expect(result.ok).toBe(true)
  })

  test('a conversation agent is told its nodes must bind the thread', async () => {
    const result = (await tool.run(createClient(), {
      name: 'Legal chat',
      config: {
        modelId: 'venice:qwen',
        prompt: 'You answer legal questions.',
        inputKind: 'conversation',
      },
    })) as { inputContract: { inputKind: string; note: string } }
    expect(result.inputContract.inputKind).toBe('conversation')
    expect(result.inputContract.note).toContain('MUST bind `conversation`')
  })
})

describe('update_agent_draft', () => {
  const tool = toolNamed('update_agent_draft')

  /**
   * Every stub here carries the model + tool catalogs now: the draft write runs
   * the same preflight `create_agent` does. It used to pass `config` straight
   * through with a cast, so a bogus modelId or an unregistered toolId saved
   * cleanly and failed on the first real run — and this is the tool used for
   * every edit AFTER the first, which made it the likeliest way for an
   * MCP-authored agent to break.
   */
  const draftClient = (over: Partial<WfDataClient> = {}) => { return stubClient({
      // The fixture's own model has to be in the catalog now, which is the
      // preflight working: an id the catalog does not know is refused.
      listModels: async () => [
        ...models(),
        { id: published.modelId, label: 'Fixture', capabilities: { tools: true } },
      ],
      listTools: async () => tools(),
      getAgent: async () => detail(),
      updateAgentDraft: async () => {},
      ...over,
    }) }

  test('writes the draft and never the published version', async () => {
    const calls: unknown[] = []
    const client = draftClient({
      updateAgentDraft: async (input) => {
        calls.push(input)
      },
      // Present on the stub precisely so a call to it would be observable —
      // nothing in this tool may reach it.
      publishAgent: async () => {
        throw new Error('publish must not be reachable from a tool')
      },
    })
    const config = { ...published, prompt: 'Be very brief.' }
    const result = (await tool.run(client, { agentId: 'a1', config })) as {
      ok: boolean
    }
    expect(result.ok).toBe(true)
    expect(calls).toHaveLength(1)
    // The PARSED config is what is written — the preflight fills every default,
    // so this is no longer byte-identical to what was sent.
    expect((calls[0] as { agentId: string }).agentId).toBe('a1')
    expect(
      (calls[0] as { config: { prompt: string } }).config.prompt,
    ).toBe('Be very brief.')
  })

  // The failure this exists to catch: `updateAgentDraft` REPLACES the draft, so
  // a model that re-sent the config with a field quietly dropped has written
  // something wrong in a way nothing else reports. The write still succeeds —
  // the receipt is what makes the loss visible one line after causing it.
  test('names every field that now differs from the published version', async () => {
    const client = draftClient()
    const { maxTurns: _dropped, ...withoutMaxTurns } = published
    const result = (await tool.run(client, {
      agentId: 'a1',
      config: { ...withoutMaxTurns, prompt: 'Be very brief.' },
    })) as { draftDiffersFromPublishedIn: string[] }
    // `prompt` was intended. `maxTurns` was not, and saying so is the point.
    expect(result.draftDiffersFromPublishedIn).toEqual(['maxTurns', 'prompt'])
  })

  test('an agent that was never published has nothing to diff against', async () => {
    const client = draftClient({
      getAgent: async () => detail({ currentVersion: null }),
    })
    const result = (await tool.run(client, {
      agentId: 'a1',
      config: published,
    })) as { draftDiffersFromPublishedIn: string[]; note: string }
    expect(result.draftDiffersFromPublishedIn).toEqual(
      Object.keys(published).sort(),
    )
    expect(result.note).toContain('never been published')
  })

  // A patch would be read as a whole config by the handler and would delete
  // everything it omitted, so a caller that sends anything but an object is
  // stopped here rather than at the point of loss.
  test('refuses anything that is not a whole config object', async () => {
    const client = stubClient({
      getAgent: async () => detail(),
      updateAgentDraft: async () => {
        throw new Error('must not be called')
      },
    })
    expect(tool.run(client, { agentId: 'a1', config: 'be brief' })).rejects.toThrow(
      /complete AgentConfig/,
    )
    expect(tool.run(client, { agentId: 'a1' })).rejects.toThrow(
      /complete AgentConfig/,
    )
  })

  test('does not write when the agent does not exist', async () => {
    const client = stubClient({
      getAgent: async () => null,
      updateAgentDraft: async () => {
        throw new Error('must not be called')
      },
    })
    const result = (await tool.run(client, {
      agentId: 'nope',
      config: published,
    })) as { error: string }
    expect(result.error).toContain('No agent found')
  })
})

describe('run_agent_preview', () => {
  const tool = toolNamed('run_agent_preview')

  function previewResult(): AgentPreviewResult {
    return {
      output: { text: 'the answer' },
      meta: {
        model: 'venice:qwen',
        systemPrompt: 'Be brief.',
        totalUsage: { inputTokens: 100, outputTokens: 20 },
        steps: [
          {
            stepNumber: 1,
            finishReason: 'tool-calls',
            toolCalls: [
              { toolCallId: 'c1', toolName: 'search', input: {}, output: { hits: 3 } },
            ],
          },
        ],
      },
    }
  }

  function capture(over: Partial<WfAgentDetail> = {}): {
    sent: AgentPreviewInput[]
    client: WfDataClient
  } {
    const sent: AgentPreviewInput[] = []
    return {
      sent,
      client: stubClient({
        getAgent: async () => detail(over),
        runAgentPreview: async (input) => {
          sent.push(input)
          return previewResult()
        },
      }),
    }
  }

  // The safety property of the whole tool: the UI playground offers live tools
  // behind a per-tool toggle a person flips having read the warning, and a tool
  // call has no equivalent of that moment. So there is no way to ask for one.
  test('never asks for a live tool, whatever it is passed', async () => {
    const { sent, client } = capture()
    await tool.run(client, {
      agentId: 'a1',
      input: 'hello',
      liveToolIds: ['search_matters'],
    })
    expect(sent[0]?.liveToolIds).toBeUndefined()
    expect(Object.keys(tool.inputSchema)).not.toContain('liveToolIds')
  })

  // A simulated tool result is the MODEL's invention. Naming it as such on every
  // call is what stops a plausible-looking one being read as something fetched.
  test('labels simulated tool output as simulated', async () => {
    const { client } = capture()
    const result = (await tool.run(client, {
      agentId: 'a1',
      input: 'hello',
    })) as { steps: { toolCalls: Record<string, unknown>[] }[]; note: string }
    const call = result.steps[0]?.toolCalls[0]
    expect(call).toHaveProperty('simulatedOutput')
    expect(call).not.toHaveProperty('output')
    expect(result.note).toContain('written by the model')
  })

  // Testing edits before they are published is the point of the tool, so the
  // draft is the default and the published version is the opt-in.
  test('runs the draft when there is one, and says which it ran', async () => {
    const draft = { ...published, prompt: 'Be extremely brief.' }
    const { sent, client } = capture({ draft: { config: draft } })
    const result = (await tool.run(client, {
      agentId: 'a1',
      input: 'hello',
    })) as { ranConfig: string }
    expect(sent[0]?.config).toEqual(draft)
    expect(result.ranConfig).toBe('draft')
  })

  // A draft row is kept alongside nearly every agent and publishing leaves it
  // matching the version it published, so `draft !== null` says almost nothing.
  // Announcing "ran the draft" off it alone is accurate and useless — a caller
  // reads it as evidence their edit was measured.
  test('says the draft changed nothing when it matches what is live', async () => {
    const { client } = capture({ draft: { config: published } })
    const result = (await tool.run(client, {
      agentId: 'a1',
      input: 'hello',
    })) as { ranConfig: string; unsavedFields: string[]; note: string }
    expect(result.ranConfig).toBe('draft')
    expect(result.unsavedFields).toEqual([])
    expect(result.note).toContain('IDENTICAL')
  })

  test('names the fields an unsaved edit actually changed', async () => {
    const draft = { ...published, prompt: 'Be extremely brief.', maxTurns: 9 }
    const { client } = capture({ draft: { config: draft } })
    const result = (await tool.run(client, {
      agentId: 'a1',
      input: 'hello',
    })) as { unsavedFields: string[]; note: string }
    expect(result.unsavedFields).toEqual(['maxTurns', 'prompt'])
    expect(result.note).not.toContain('IDENTICAL')
  })

  test('falls back to the published version when no draft exists', async () => {
    const { sent, client } = capture()
    const result = (await tool.run(client, {
      agentId: 'a1',
      input: 'hello',
    })) as { ranConfig: string }
    expect(sent[0]?.config).toEqual(published)
    expect(result.ranConfig).toBe('published')
  })

  test('usePublished ignores the draft', async () => {
    const draft = { ...published, prompt: 'Be extremely brief.' }
    const { sent, client } = capture({ draft: { config: draft } })
    await tool.run(client, { agentId: 'a1', input: 'hello', usePublished: true })
    expect(sent[0]?.config).toEqual(published)
  })

  // The handler rejects this too; from here the message can name what the fix
  // is for this particular agent instead of the generic ask.
  test('asks for an input before spending a model call', async () => {
    const { sent, client } = capture()
    const result = (await tool.run(client, { agentId: 'a1' })) as {
      error: string
    }
    expect(result.error).toContain('promptVariables')
    expect(sent).toHaveLength(0)
  })

  test('passes prompt variables through as the only input', async () => {
    const { sent, client } = capture()
    await tool.run(client, {
      agentId: 'a1',
      promptVariables: { matter: 'M-1', ignored: 7 },
    })
    // Strings only — the handler parses a string record, and a number silently
    // dropped downstream would render as an empty variable.
    expect(sent[0]?.promptVariables).toEqual({ matter: 'M-1' })
    expect(sent[0]?.input).toBeUndefined()
  })
})

describe('update_agent_draft — the preflight it used to skip', () => {
  const client = (over: Partial<WfDataClient> = {}) => { return stubClient({
      listModels: async () => models(),
      listTools: async () => tools(),
      getAgent: async () => detail(),
      updateAgentDraft: async () => {
        throw new Error('must not reach the write')
      },
      ...over,
    }) }

  // This is the tool used for every edit AFTER the first, so it was the likeliest
  // way for an MCP-authored agent to break: the config saved cleanly and failed
  // on the first real run.
  test('refuses a modelId the catalog does not know, and writes nothing', async () => {
    const result = (await toolNamed('update_agent_draft').run(client(), {
      agentId: 'a1',
      config: { ...published, modelId: 'qwen' },
    })) as { error: string }
    expect(result.error).toContain('composite')
  })

  test('refuses an unregistered toolId', async () => {
    const result = (await toolNamed('update_agent_draft').run(client(), {
      agentId: 'a1',
      config: {
        ...published,
        modelId: 'venice:qwen',
        toolIds: ['search_the_moon'],
      },
    })) as { error: string }
    expect(result.error).toContain('search_the_moon')
  })

  test('refuses a model that cannot do what the config needs', async () => {
    const result = (await toolNamed('update_agent_draft').run(client(), {
      agentId: 'a1',
      config: {
        ...published,
        modelId: 'venice:tiny',
        toolIds: ['search_matters'],
      },
    })) as { error: string }
    expect(result.error).toContain('no tool calling')
  })
})

describe('update_agent_draft — the fields nothing prompts for', () => {
  const withSubAgents = {
    ...published,
    subAgents: {
      targets: [{ kind: 'agent', id: 'a2', version: null }],
      maxConcurrent: 2,
      maxSpawns: 4,
      allowStopSignal: true,
    },
  }

  const client = (over: Partial<WfDataClient> = {}) => { return stubClient({
      listModels: async () => [
        ...models(),
        { id: published.modelId, label: 'Fixture', capabilities: { tools: true } },
      ],
      listTools: async () => tools(),
      getAgent: async () => { return detail({ draft: { config: withSubAgents as never } }) },
      updateAgentDraft: async () => {},
      ...over,
    }) }

  // The headline data loss: a model that never learned `subAgents` exists reads
  // the config, edits the prompt, re-sends — and zod backfills an EMPTY
  // whitelist, so the omission is invisible one line later.
  test('warns when the payload silently drops the sub-agent whitelist', async () => {
    const { subAgents: _gone, ...withoutSubAgents } = withSubAgents
    const result = (await toolNamed('update_agent_draft').run(client(), {
      agentId: 'a1',
      config: { ...withoutSubAgents, prompt: 'Be terser.' },
    })) as { removed: string[]; warning: string }
    expect(result.removed).toContain('subAgents')
    expect(result.warning).toContain('DROPPED')
  })

  test('says nothing when the payload carries every field it had', async () => {
    const result = (await toolNamed('update_agent_draft').run(client(), {
      agentId: 'a1',
      config: { ...withSubAgents, prompt: 'Be terser.' },
    })) as { removed: string[]; warning?: string }
    expect(result.removed).toEqual([])
    expect(result.warning).toBeUndefined()
  })
})

describe('update_agent_draft — fromVersion', () => {
  test('restores a published version into the draft', async () => {
    const writes: { config: { prompt: string } }[] = []
    const old = { ...published, prompt: 'The old wording.' }
    const client = stubClient({
      getAgent: async () => detail(),
      listAgentVersions: async () => { return [
          { id: 'v1', versionNumber: 1 },
          { id: 'v2', versionNumber: 2 },
        ] as never },
      getAgentVersion: async () => ({ config: old, versionNumber: 1 }),
      updateAgentDraft: async (input) => {
        writes.push(input)
      },
    })
    const result = (await toolNamed('update_agent_draft').run(client, {
      agentId: 'a1',
      fromVersion: 1,
    })) as { restoredFrom: number }
    expect(result.restoredFrom).toBe(1)
    expect(writes[0]?.config.prompt).toBe('The old wording.')
  })

  test('names the versions that exist when the number is wrong', async () => {
    const client = stubClient({
      getAgent: async () => detail(),
      listAgentVersions: async () => [{ id: 'v2', versionNumber: 2 }] as never,
    })
    const result = (await toolNamed('update_agent_draft').run(client, {
      agentId: 'a1',
      fromVersion: 9,
    })) as { error: string }
    expect(result.error).toContain('no published version 9')
    expect(result.error).toContain('2')
  })

  test('refuses config and fromVersion together', async () => {
    const result = (await toolNamed('update_agent_draft').run(stubClient({}), {
      agentId: 'a1',
      config: published,
      fromVersion: 1,
    })) as { error: string }
    expect(result.error).toContain('not both')
  })
})

describe('list_agent_versions', () => {
  const client = (over: Partial<WfDataClient> = {}) => { return stubClient({
      getAgent: async () => detail(),
      listAgentVersions: async () => { return [
          {
            id: 'v1',
            versionNumber: 1,
            changeNote: 'first',
            aiSummaryShort: 'Initial',
            aiSummaryLong: null,
            createdAt: 1,
            publishedAt: 1,
          },
          {
            id: 'v2',
            versionNumber: 2,
            changeNote: 'tightened the refusal',
            aiSummaryShort: 'Refuses harder',
            aiSummaryLong: null,
            createdAt: 2,
            publishedAt: 2,
          },
        ] as never },
      ...over,
    }) }

  // "When did this regress" / "what did the last publish change" — unanswerable
  // before, while the workflow twin had answered it all along.
  test('lists the history newest first, marking what is live', async () => {
    const out = (await toolNamed('list_agent_versions').run(client(), {
      agentId: 'a1',
    })) as {
      live: number
      versions: { versionNumber: number; summary: string | null }[]
    }
    expect(out.versions.map((v) => v.versionNumber)).toEqual([2, 1])
    expect(out.versions[0]?.summary).toBe('Refuses harder')
  })

  test('drills into one version’s immutable config', async () => {
    const out = (await toolNamed('list_agent_versions').run(
      client({
        getAgentVersion: async () => ({
          config: { ...published, prompt: 'v1 wording' },
          versionNumber: 1,
        }),
      }),
      { agentId: 'a1', versionNumber: 1 },
    )) as { config: { prompt: string }; isLive: boolean }
    expect(out.config.prompt).toBe('v1 wording')
    expect(out.isLive).toBe(false)
  })

  test('says so when an agent has never been published', async () => {
    const out = (await toolNamed('list_agent_versions').run(
      client({ listAgentVersions: async () => [] }),
      { agentId: 'a1' },
    )) as { note: string }
    expect(out.note).toContain('never been published')
  })
})

describe('list_agent_calls', () => {
  function call(over: Record<string, unknown> = {}) {
    return {
      runId: 'run_1',
      nodeId: 'n1',
      callCount: 1,
      itemIndexes: [],
      status: 'completed',
      error: null,
      failedCount: 0,
      startedAt: 1,
      finishedAt: 2,
      durationMs: 1,
      workflowId: 'w1',
      workflowName: 'Intake',
      versionNumber: 3,
      model: 'qwen',
      agentVersion: 2,
      turns: 4,
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.01,
      toolCalls: [{ toolId: 'search_matters', count: 3 }],
      stoppedOnTokenBudget: false,
      stoppedOnContextLimit: false,
      subAgentName: null,
      ...over,
    }
  }

  // The finding this exists to surface: the agent did not decide to stop, it ran
  // out of room — which otherwise reads as a prompt problem.
  test('counts the calls that ran out of room, and names the lever', async () => {
    const client = stubClient({
      listAgentCalls: async () => { return [call({ stoppedOnTokenBudget: true }), call()] as never },
    })
    const out = (await toolNamed('list_agent_calls').run(client, {
      agentId: 'a1',
    })) as {
      stoppedEarly: { onTokenBudget: number }
      note: string
      calls: { toolCalls: unknown[] }[]
    }
    expect(out.stoppedEarly.onTokenBudget).toBe(1)
    expect(out.note).toContain('toolTokenBudget')
    expect(out.note).toContain('not the prompt')
    expect(out.calls[0]?.toolCalls).toEqual([
      { toolId: 'search_matters', count: 3 },
    ])
  })

  // "Never run" and "run and broken" are different answers.
  test('distinguishes an agent nothing has used', async () => {
    const client = stubClient({ listAgentCalls: async () => [] })
    const out = (await toolNamed('list_agent_calls').run(client, {
      agentId: 'a1',
    })) as { note: string }
    expect(out.note).toContain('never run in a real workflow')
  })
})

describe('discard_agent_draft', () => {
  test('names what was thrown away', async () => {
    let discarded = false
    const client = stubClient({
      getAgent: async () => { return detail({
          draft: { config: { ...published, prompt: 'A bad idea.' } },
        }) },
      discardAgentDraft: async () => {
        discarded = true
      },
    })
    const out = (await toolNamed('discard_agent_draft').run(client, {
      agentId: 'a1',
    })) as { discarded: string[]; note: string }
    expect(discarded).toBe(true)
    expect(out.discarded).toEqual(['prompt'])
    expect(out.note).toContain('published version is unchanged')
  })

  test('is a no-op when there is no draft', async () => {
    let discarded = false
    const client = stubClient({
      getAgent: async () => detail(),
      discardAgentDraft: async () => {
        discarded = true
      },
    })
    const out = (await toolNamed('discard_agent_draft').run(client, {
      agentId: 'a1',
    })) as { note: string }
    expect(out.note).toContain('no draft to discard')
    expect(discarded).toBe(false)
  })
})

describe('update_agent', () => {
  test('renames and reports which workflows show the new name', async () => {
    let seen: unknown
    const client = stubClient({
      getAgent: async () => { return detail({
          agent: {
            id: 'a1',
            name: 'Intake',
            workflows: [{ id: 'w1', name: 'Legal chat' }],
          } as never,
        }) },
      updateAgentMeta: async (input) => {
        seen = input
      },
    })
    const out = (await toolNamed('update_agent').run(client, {
      agentId: 'a1',
      name: 'Conflict checker',
      icon: 'scale',
    })) as { before: { name: string }; referencedBy: string[]; note: string }
    expect(seen).toEqual({
      agentId: 'a1',
      name: 'Conflict checker',
      icon: 'scale',
      color: undefined,
    })
    expect(out.before.name).toBe('Intake')
    expect(out.referencedBy).toEqual(['Legal chat'])
    expect(out.note).toContain('no version was created')
  })

  test('refuses a call that would change nothing', async () => {
    const out = (await toolNamed('update_agent').run(stubClient({}), {
      agentId: 'a1',
    })) as { error: string }
    expect(out.error).toContain('at least one of')
  })
})

describe('triage_feedback', () => {
  const row = {
    subjectId: 'msg_1',
    rating: 'down' as const,
    runId: 'run_1',
    acknowledgedAt: null,
    internalNote: null,
  }

  // The loop this closes: the queue never drained, so the same complaint was
  // re-triaged next session.
  test('acknowledges and writes the resolution note in one call', async () => {
    const calls: Record<string, unknown>[] = []
    const client = stubClient({
      getFeedbackForSubjects: async () => [row] as never,
      setFeedbackAcknowledged: async (input) => {
        calls.push({ ack: input })
        return { ok: true as const }
      },
      setFeedbackInternalNote: async (input) => {
        calls.push({ note: input })
        return { ok: true as const }
      },
    })
    const out = (await toolNamed('triage_feedback').run(client, {
      subjectId: 'msg_1',
      acknowledged: true,
      internalNote: 'Venice rate limit; sample added to the refusal goal.',
    })) as { before: { acknowledged: boolean }; note: string }
    expect(calls).toHaveLength(2)
    expect(out.before.acknowledged).toBe(false)
    expect(out.note).toContain('outstanding queue')
  })

  // An empty note is the documented way to clear one, and `optString` would read
  // it as absent.
  test('clears the note with an empty string', async () => {
    let seen: unknown
    const client = stubClient({
      getFeedbackForSubjects: async () => { return [{ ...row, internalNote: 'stale' }] as never },
      setFeedbackInternalNote: async (input) => {
        seen = input
        return { ok: true as const }
      },
    })
    await toolNamed('triage_feedback').run(client, {
      subjectId: 'msg_1',
      internalNote: '',
    })
    expect(seen).toEqual({ subjectId: 'msg_1', note: null })
  })

  // Neither setter checks that the row exists, so a wrong id would update zero
  // rows and answer ok.
  test('refuses a subjectId with no feedback rather than no-opping', async () => {
    let wrote = false
    const client = stubClient({
      getFeedbackForSubjects: async () => [],
      setFeedbackAcknowledged: async () => {
        wrote = true
        return { ok: true as const }
      },
    })
    const out = (await toolNamed('triage_feedback').run(client, {
      subjectId: 'nope',
      acknowledged: true,
    })) as { error: string }
    expect(out.error).toContain('not the run')
    expect(wrote).toBe(false)
  })

  test('refuses a call that would change nothing', async () => {
    const out = (await toolNamed('triage_feedback').run(stubClient({}), {
      subjectId: 'msg_1',
    })) as { error: string }
    expect(out.error).toContain('nothing else this tool changes')
  })
})

describe('run_agent_preview — a conversation agent', () => {
  const chatConfig = { ...published, inputKind: 'conversation' as const }

  /** The shape `summarizePreview` reads — `meta`, not a bare step list. */
  const previewResult = () => { return ({
      output: { text: 'ok' },
      meta: {
        model: 'qwen',
        steps: [],
        totalUsage: { inputTokens: 1, outputTokens: 1 },
        stoppedOnTokenBudget: false,
        stoppedOnContextLimit: false,
      },
    }) as never }

  test('passes the thread through as prior turns', async () => {
    let seen: Record<string, unknown> = {}
    const client = stubClient({
      getAgent: async () => { return detail({ currentVersion: { id: 'v1', versionNumber: 1, config: chatConfig } }) },
      runAgentPreview: async (input) => {
        seen = input
        return previewResult()
      },
    })
    const out = (await toolNamed('run_agent_preview').run(client, {
      agentId: 'a1',
      input: 'And the deadline?',
      messages: [
        { role: 'user', text: 'What is the statute?' },
        { role: 'assistant', text: 'Section 12.' },
      ],
    })) as { turnsSeeded: number }
    // For a conversation agent the THREAD is the input; a single string tests it
    // under conditions it never sees in production.
    expect(seen.messages).toHaveLength(2)
    expect(out.turnsSeeded).toBe(2)
  })

  test('drops a malformed turn rather than sending it', async () => {
    let seen: Record<string, unknown> = {}
    const client = stubClient({
      getAgent: async () => { return detail({ currentVersion: { id: 'v1', versionNumber: 1, config: chatConfig } }) },
      runAgentPreview: async (input) => {
        seen = input
        return previewResult()
      },
    })
    await toolNamed('run_agent_preview').run(client, {
      agentId: 'a1',
      input: 'hi',
      messages: [{ role: 'system', text: 'nope' }, { role: 'user' }],
    })
    expect(seen.messages).toBeUndefined()
  })

  // The handler ignores `messages` for a task agent, so without this it would be
  // a silently-discarded argument and the reader would assume the thread counted.
  test('warns that a task agent ignored the turns', async () => {
    const client = stubClient({
      getAgent: async () => detail(),
      runAgentPreview: async () => previewResult(),
    })
    const out = (await toolNamed('run_agent_preview').run(client, {
      agentId: 'a1',
      input: 'hi',
      messages: [{ role: 'user', text: 'ignored' }],
    })) as { warning: string }
    expect(out.warning).toContain('IGNORED')
  })
})
