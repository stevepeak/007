import { describe, expect, test } from 'bun:test'

import { makeAgentConfig } from '../engine/agent-test-helpers'
import type {
  AgentPreviewInput,
  AgentPreviewResult,
  WfAgentDetail,
  WfDataClient,
} from '../server/protocol'

import type { WfMcpTool } from './tools'
import { agentWriteTools } from './tools-agents'

/**
 * These two tools are the only ones in the catalog that change an agent or spend
 * a model call on one, so what is worth pinning is the boundary: what they
 * refuse to do, and whether a caller can tell what they just did.
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
