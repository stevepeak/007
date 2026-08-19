import type { UIMessage } from 'ai'

import type { RunContext, WfSdkConfig } from '../engine/config'
import type { AgentConfig, AgentNode } from '../engine/graph'
import { executeAgentNode } from '../engine/nodes/agent'
import { createMemorySink } from '../engine/stream-sink'

import type { AgentPreviewMessage, AgentPreviewResult } from './protocol'
import { buildPlaygroundRegistry } from './simulated-tools'

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
// Tools are simulated by default (see `buildPlaygroundRegistry`): a playground
// runs on scratch data with no real client context, and several tools mutate the
// vector store / DB or bill external calls. The model still sees the real tool
// schemas and decides which to call — only execution is mocked.
//
// `liveToolIds` opts individual tools out of that: those execute for real,
// against the host's real per-run deps, exactly as they would in a workflow run.
// The UI defaults read-only tools to live and side-effecting ones to simulated,
// and warns before a write tool is switched on. `buildRunDeps` (and the clients
// it builds) is skipped entirely when nothing is live, so an all-simulated run
// still cannot touch real data by construction.
//
// Like `summarizeChanges`, this is invoked from a host-injected handler so the
// host can supply live bindings (`env`) via the RunContext; the SDK stays
// env/auth-free.

const PREVIEW_AGENT_ID = '__playground__'

/**
 * Turn the playground's authored turns into the AI-SDK messages the node binds
 * as its conversation. Plain text parts only — a scratch history is what the
 * agent is *given*, not a replay of a past run's tool traffic.
 */
function toUiMessages(messages: readonly AgentPreviewMessage[]): UIMessage[] {
  return messages.map((m): UIMessage => ({
    id: crypto.randomUUID(),
    role: m.role,
    parts: [{ type: 'text', text: m.text }],
  }))
}

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
  /**
   * Prior turns for an agent that works on a conversation — the history that
   * precedes `input`. Bound as the node's `conversation`, the same explicit
   * source a real chat run uses, with `input` appended as the current user turn.
   * Empty/omitted → the agent runs on `input` alone, with no prior context.
   */
  messages?: readonly AgentPreviewMessage[]
  /**
   * Registry ids of the tools to run FOR REAL rather than simulate. Everything
   * else in the registry is mocked. Empty/omitted → the whole run is simulated
   * and no deps are built.
   */
  liveToolIds?: readonly string[]
  /** The host's full SDK config (model provider, tools, deps builder). */
  wfConfig: WfSdkConfig<TDeps>
  /**
   * Per-run context carrying `env` and tenant scope. Its `promptVariables` are
   * the values for the prompt's `${…}` variables.
   */
  runContext: RunContext
}): Promise<AgentPreviewResult> {
  const { config, wfConfig } = opts
  // Playground explicitly asks for reasoning so the author can inspect the
  // model's thinking per step (rendered in the trace). This is the provider-
  // agnostic signal the host's `getModel` honors; scoped to the preview so a
  // real run keeps its own default. A model that can't reason simply emits none.
  const runContext: RunContext = { ...opts.runContext, reasoning: true }
  const sink = createMemorySink()
  // Simulated tools are stood in for by the agent's own model.
  const simulator = wfConfig.getModel(config.modelId, runContext)
  // Unknown ids are dropped so a stale toggle can't fail the run. Real deps are
  // built ONLY when something is actually going to run live — an all-simulated
  // playground never constructs a DB/vector client at all.
  const liveToolIds = (opts.liveToolIds ?? []).filter((id) =>
    wfConfig.toolRegistry.has(id),
  )
  const toolDeps =
    liveToolIds.length > 0 ? await wfConfig.buildRunDeps(runContext) : undefined
  const toolRegistry = buildPlaygroundRegistry({
    registry: wfConfig.toolRegistry,
    model: simulator,
    liveToolIds,
    deps: toolDeps,
  })

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

  // A scratch conversation is bound exactly where a real run binds the chat
  // trigger's messages: the node's `conversation`. History in the engine is
  // always explicit, so without this the agent would answer `message` with no
  // prior context no matter what the author typed. The current turn is appended
  // here (not on the client) so the variable-driven path — where the message is
  // synthesized from promptVariables above — carries its turn too.
  const history = opts.messages ?? []
  const conversation =
    history.length > 0
      ? [
          ...toUiMessages(history),
          ...toUiMessages([{ role: 'user', text: message }]),
        ]
      : undefined

  const node: AgentNode = {
    id: 'playground',
    kind: 'agent',
    label: 'Playground',
    position: { x: 0, y: 0 },
    // No user-facing stream (not a real placement). Reasoning is forced on at the
    // model layer below (getModel) so the trace still shows the thinking.
    informUser: { mode: 'off' },
    config: {
      agentId: PREVIEW_AGENT_ID,
      version: null,
      inputs: {},
      imageInputs: {},
      ...(conversation
        ? { conversation: { kind: 'literal' as const, value: conversation } }
        : {}),
    },
  }

  const result = await executeAgentNode<unknown>({
    node,
    input: message,
    // Playground always reasons (runContext.reasoning) so the trace shows the
    // model's thinking, regardless of the synthetic node's inform-user flags.
    getModel: (modelId, opts) =>
      wfConfig.getModel(modelId, {
        ...runContext,
        reasoning: runContext.reasoning ?? opts?.reasoning,
      }),
    toolRegistry,
    // Every entry closes over what it needs (the simulator model, or the real
    // deps bound above), so the node itself has nothing to thread through.
    toolDeps: {},
    sink,
    promptVariables,
    nodeOutputs: new Map(),
    manifest: [
      {
        kind: 'agent',
        id: PREVIEW_AGENT_ID,
        pinnedVersion: null,
        versionId: 'preview',
        versionNumber: 0,
        name: 'Playground',
        config,
      },
    ],
  })

  return { ...result, progress: sink.events }
}
