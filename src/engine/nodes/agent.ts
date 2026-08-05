import type { WfBlobRef } from '../blob-ref'
import type { ModelFactory, ResolvedImage } from '../config'
import type { ModelBudget } from '../model-budget'
import {
  agentFromManifest,
  type AgentConfig,
  type AgentNode,
  substitutePromptVariables,
  type WfRunManifestEntry,
} from '../graph'
import type { StreamSink } from '../stream-sink'
import { buildAgentToolSet, type ToolRegistry } from '../tool-registry'

import {
  type AgentNodeResult,
  runAgentGeneration,
} from './agent-generation'
import {
  attachImages,
  coerceToMessages,
  resolveConversation,
  resolveImageInputs,
  resolveNodeInputs,
  unlinkedMessages,
} from './agent-inputs'
import { type SubAgentCtx, synthesizeDelegationTools } from './sub-agent'

// `./agent` is the single entry point for the agent node: the input helpers live
// in `agent-inputs.ts` and the model loop (+ its result/meta types) in
// `agent-generation.ts`. Re-export the pieces `sub-agent.ts` and external
// consumers import from here so those import paths are unchanged.
export { coerceToMessages, runAgentGeneration }
export type {
  AgentNodeMeta,
  AgentNodeResult,
  RunAgentGenerationArgs,
} from './agent-generation'

export type ExecuteAgentNodeArgs<TDeps> = {
  node: AgentNode
  input: unknown
  getModel: ModelFactory
  toolRegistry: ToolRegistry<TDeps>
  toolDeps: TDeps
  /**
   * Live progress sink. When the node has `stream: true`, each completed
   * step's text is appended as a 'progress' event (e.g. forwarded to the
   * RunRoom DO). Background runs deliver progress here rather than to an HTTP
   * caller.
   */
  sink?: StreamSink
  /** Run-level variables exposed to the system-prompt template engine. */
  promptVariables: Record<string, string | undefined>
  /**
   * Live node-output cache (from `scheduler.getOutputs()`) — used to resolve
   * this node's per-variable input bindings (`config.inputs`) into prompt vars.
   */
  nodeOutputs: Map<string, unknown>
  /** Frozen run manifest — resolves the node's `agentId` to its config. */
  manifest: WfRunManifestEntry[]
  /**
   * Deep-rehydrates blob-ref inputs (a large upstream value spilled to storage)
   * to their real text before prompt interpolation. Omitted → inputs pass
   * through unchanged.
   */
  rehydrate?: (value: unknown) => Promise<unknown>
  /**
   * Resolves an image blob-ref (from an `imageInputs` binding) to a model-ready
   * image. Bound to the run's deps by the caller. Omitted → an image blob-ref
   * input throws (a text-only run wires no image resolver).
   */
  resolveImage?: (ref: WfBlobRef) => Promise<ResolvedImage>
  /** Eval signal — under simulate, side-effecting tools are neutralized. */
  simulate?: boolean
  /** Canned tool outputs consumed under `simulate`. */
  fixtures?: Record<string, unknown>
  /**
   * Eval synthesis signal — run with an EMPTY tool set (no registry tools, no
   * delegation tools), forcing the model to answer from its seeded message
   * history. Grades the final response in isolation. See RunContext.freezeTools.
   */
  freezeTools?: boolean
  /**
   * Eval matrix override. When set, `modelId` swaps the model this node runs on
   * and `prompt` REPLACES the system-prompt template (still `${var}`-interpolated
   * against the run's promptVariables). Either omitted → the agent's saved value.
   * The override is not persisted to `wf_run.manifest`; only the effective model
   * is reflected in `AgentNodeMeta.model` so cost prices against the model used.
   */
  agentOverride?: { modelId?: string; prompt?: string }
  /**
   * Time budget for this node's model work (see `../model-budget`). Bounds the
   * agent loop from inside the step so an overrun is catchable. Omitted →
   * unbounded.
   */
  modelBudget?: ModelBudget
  /**
   * Delegation context. When present and the agent's config whitelists
   * sub-agents/workflows, the node synthesizes `spawn_*` / `await_subagents`
   * tools (backed by a per-execution SpawnManager) into its tool set. Omitted →
   * no delegation tools (e.g. a preview run, or an agent with no whitelist).
   */
  subAgentCtx?: SubAgentCtx<TDeps>
}

// Resolve the agent an agent node points at from the frozen run manifest. The
// manifest is populated at run start from the version the node pinned (or its
// latest published version when unpinned), so a run is reproducible even as the
// agent drifts.
function resolveAgentConfig(
  node: AgentNode,
  manifest: WfRunManifestEntry[],
): AgentConfig {
  const pin = node.config.version ?? null
  const entry = agentFromManifest(manifest, node.config.agentId, pin)
  if (!entry) {
    const at = pin == null ? 'latest' : `v${pin}`
    throw new Error(
      `Agent node ${node.id} references agent ${node.config.agentId || '(none)'} (${at}), which is not in the run manifest.`,
    )
  }
  return entry.config
}

export async function executeAgentNode<TDeps>(
  deps: ExecuteAgentNodeArgs<TDeps>,
): Promise<AgentNodeResult> {
  const {
    node,
    getModel,
    toolRegistry,
    toolDeps,
    sink,
    promptVariables,
    nodeOutputs,
    manifest,
    input,
    rehydrate,
    resolveImage,
    simulate,
    fixtures,
    freezeTools,
    agentOverride,
    subAgentCtx,
  } = deps
  const config = resolveAgentConfig(node, manifest)
  // Eval matrix override: swap the model and/or the system-prompt template. Left
  // undefined → the agent's saved value. `modelId` drives both `getModel` and the
  // meta below (so run cost prices against the model actually used).
  const modelId = agentOverride?.modelId ?? config.modelId
  const promptTemplate = agentOverride?.prompt ?? config.prompt
  // "Inform user → Dynamic" streams the agent's live activity to the user. The
  // node's `informUser` field is the single source of truth; its two sub-toggles
  // pick WHAT streams — reasoning and/or tool-call announcements — each
  // display-only. Neither affects which tools the agent may call.
  const inform = node.informUser
  const streamReasoning = inform.mode === 'dynamic' && inform.reasoning
  const streamToolCalls = inform.mode === 'dynamic' && inform.tools
  // DISPLAY-ONLY, deliberately. `streamReasoning` decides whether the model's
  // thinking is shown live to the end user; it must NOT decide whether the model
  // thinks at all. Those are different concerns: reasoning is a real extra
  // generation pass that materially improves multi-step analysis, so a display
  // preference silently switching it off would degrade every answer with no
  // signal. We therefore pass NO reasoning intent here — leaving it undefined
  // keeps the provider's own default (thinking on). Note the model's reasoning
  // reaches the dev feed and the post-answer reveal regardless of this toggle
  // (see the always-on `thinking` level in `agent-generation.ts`).
  const model = getModel(modelId)
  // Synthesis eval: an empty tool set forces the model to answer from its seeded
  // history alone. Otherwise resolve the agent's real tools (neutralized under
  // simulate). freezeTools also suppresses delegation-tool synthesis below.
  const tools = freezeTools
    ? {}
    : buildAgentToolSet(toolRegistry, config.toolIds, toolDeps, {
        simulate,
        fixtures,
      })
  // Human-readable status templates, keyed by tool id (the ToolSet's own key, so
  // it matches `toolName` at call time). Only tools that declare a `statusLabel`
  // appear here; the emission is further gated on `streamToolCalls` downstream.
  const toolStatusLabels: Record<string, string> = {}
  for (const id of config.toolIds) {
    const label = toolRegistry.get(id)?.statusLabel
    if (label) toolStatusLabels[id] = label
  }
  // Node-level bound inputs override the run-level promptVariables.
  const vars = {
    ...promptVariables,
    ...(await resolveNodeInputs(node, nodeOutputs, rehydrate)),
  }
  const systemPrompt = substitutePromptVariables(promptTemplate, vars)
  // Any bound image inputs ride along as vision parts on the user turn.
  const imageParts = await resolveImageInputs(node, nodeOutputs, resolveImage)
  // History is EXPLICIT: it comes only from the node's `conversation` binding (a
  // linked message source, typically the chat trigger's `messages`). Without a
  // link, a chat/trigger payload does NOT implicitly become the thread — the agent
  // answers only the current turn with no prior context (surfaced as an editor
  // warning). See `unlinkedMessages`.
  const linked = await resolveConversation(node, nodeOutputs, rehydrate)
  const history = linked ?? unlinkedMessages(input)
  const messages = attachImages(history, imageParts)

  // Delegation: when this agent whitelists sub-agents/workflows, merge the
  // synthesized spawn/await tools into its tool set (text agents only — the
  // structured-output paths run no tool loop). A synthesized name that collides
  // with a registered tool is an author error surfaced loudly here.
  let effectiveTools = tools
  if (
    !freezeTools &&
    subAgentCtx &&
    config.output.kind === 'text' &&
    (config.subAgents?.targets.length ?? 0) > 0
  ) {
    const delegation = synthesizeDelegationTools(config.subAgents, subAgentCtx)
    for (const name of Object.keys(delegation)) {
      if (Object.hasOwn(tools, name)) {
        throw new Error(
          `Agent ${node.id}: delegation tool '${name}' collides with a registered tool. Rename the sub-agent target's tool name.`,
        )
      }
    }
    effectiveTools = { ...tools, ...delegation }
  }

  return await runAgentGeneration({
    model,
    modelId,
    output: config.output,
    maxTurns: config.maxTurns,
    streamReasoning,
    streamToolCalls,
    systemPrompt,
    messages,
    tools: effectiveTools,
    toolStatusLabels,
    sink,
    budget: deps.modelBudget,
  })
}
