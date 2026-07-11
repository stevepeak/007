import type { RunContext, WfSdkConfig } from '../engine/config'
import type { AgentConfig, AgentNode } from '../engine/graph'
import { executeAgentNode } from '../engine/nodes/agent'
import { createMemorySink } from '../engine/stream-sink'

import type { AgentPreviewResult } from './protocol'
import { buildSimulatedRegistry } from './simulated-tools'

// Playground seam — runs a *single* agent in isolation against a scratch input,
// with no graph, no persistence, and no run record. It reuses the exact node
// executor a real workflow run uses (`executeAgentNode`), so what the author
// sees here matches production behavior.
//
// The agent config comes from the caller (the live editor draft, not a
// published version), so an author can test unsaved edits. It's passed to the
// executor through a synthetic one-entry manifest under a fixed preview id —
// the same mechanism a real run uses to freeze an agent's resolved config.
//
// Tools are *simulated*, never executed (see `buildSimulatedRegistry`): a
// playground runs on scratch data with no real client context, and several
// tools mutate the vector store / DB or bill external calls. The model still
// sees the real tool schemas and decides which to call — only execution is
// mocked. Because no real tool runs, `buildRunDeps` (and the clients it builds)
// is skipped entirely, so real data is untouchable by construction.
//
// Like `summarizeChanges`, this is invoked from a host-injected handler so the
// host can supply live bindings (`env`) via the RunContext; the SDK stays
// env/auth-free.

const PREVIEW_AGENT_ID = '__playground__'

export async function executeAgentPreview<TDeps>(opts: {
  /** The agent config to run — typically the editor's live draft. */
  config: AgentConfig
  /**
   * Free-form conversational message for agents that take one. May be empty for
   * a variable-driven agent — the message is then synthesized from the prompt
   * variables so the model still receives a non-empty user turn (mirroring how a
   * real run feeds upstream data into the node).
   */
  input: string
  /** The host's full SDK config (model provider, tools, deps builder). */
  wfConfig: WfSdkConfig<TDeps>
  /**
   * Per-run context carrying `env` and tenant scope. Its `promptVariables` are
   * the values for the prompt's `${…}` variables.
   */
  runContext: RunContext
}): Promise<AgentPreviewResult> {
  const { config, wfConfig, runContext } = opts
  const sink = createMemorySink()
  // Tools are simulated by the agent's own model — no real deps are built.
  const simulator = wfConfig.getModel(config.modelId, runContext)
  const toolRegistry = buildSimulatedRegistry(wfConfig.toolRegistry, simulator)

  const promptVariables = runContext.promptVariables ?? {}
  // A variable-driven agent (e.g. a classifier reading `${title}`/`${text}`)
  // has no conversational message. In a real run the node still receives its
  // upstream input as the message; here we stand in a compact rendering of the
  // variables so the model always gets a non-empty user turn.
  const message =
    opts.input.trim() ||
    Object.entries(promptVariables)
      .map(([name, value]) => `${name}: ${value}`)
      .join('\n\n')

  const node: AgentNode = {
    id: 'playground',
    kind: 'agent',
    label: 'Playground',
    position: { x: 0, y: 0 },
    config: { agentId: PREVIEW_AGENT_ID, inputs: {}, imageInputs: {} },
  }

  const result = await executeAgentNode<unknown>({
    node,
    input: message,
    getModel: (modelId) => wfConfig.getModel(modelId, runContext),
    toolRegistry,
    toolDeps: {},
    sink,
    promptVariables,
    nodeOutputs: new Map(),
    manifest: [
      {
        kind: 'agent',
        id: PREVIEW_AGENT_ID,
        versionId: 'preview',
        versionNumber: 0,
        name: 'Playground',
        config,
      },
    ],
  })

  return { ...result, progress: sink.events }
}
