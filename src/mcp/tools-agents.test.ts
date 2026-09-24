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
import { agentWriteTools } from './tools-agents'

/**
 * These three tools are the only ones in the catalog that create or change an
 * agent, or spend a model call on one, so what is worth pinning is the boundary:
 * what they refuse to do, and whether a caller can tell what they just did.
 */

function toolNamed(name: string): WfMcpTool {
  const found = agentWriteTools().find((t) => t.name === name)
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

  test('writes the draft and never the published version', async () => {
    const calls: unknown[] = []
    const client = stubClient({
      getAgent: async () => detail(),
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
    expect(calls).toEqual([{ agentId: 'a1', config }])
  })

  // The failure this exists to catch: `updateAgentDraft` REPLACES the draft, so
  // a model that re-sent the config with a field quietly dropped has written
  // something wrong in a way nothing else reports. The write still succeeds —
  // the receipt is what makes the loss visible one line after causing it.
  test('names every field that now differs from the published version', async () => {
    const client = stubClient({
      getAgent: async () => detail(),
      updateAgentDraft: async () => {},
    })
    const { maxTurns: _dropped, ...withoutMaxTurns } = published
    const result = (await tool.run(client, {
      agentId: 'a1',
      config: { ...withoutMaxTurns, prompt: 'Be very brief.' },
    })) as { draftDiffersFromPublishedIn: string[] }
    // `prompt` was intended. `maxTurns` was not, and saying so is the point.
    expect(result.draftDiffersFromPublishedIn).toEqual(['maxTurns', 'prompt'])
  })

  test('an agent that was never published has nothing to diff against', async () => {
    const client = stubClient({
      getAgent: async () => detail({ currentVersion: null }),
      updateAgentDraft: async () => {},
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
