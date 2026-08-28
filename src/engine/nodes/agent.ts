import type { ModelFactory } from '../config'
import {
  agentFromManifest,
  type AgentConfig,
  type AgentNode,
  type AgentOverride,
  substitutePromptVariables,
  type WfRunManifestEntry,
} from '../graph'
import type { ModelBudget } from '../model-budget'
import type { StreamSink } from '../stream-sink'
import { buildAgentToolSet, type ToolRegistry } from '../tool-registry'

import {
  runAgentGeneration,
  stepAgentVersion,
  type AgentNodeResult,
} from './agent-generation'
import {
  buildAgentMessages,
  coerceToMessages,
  resolveNodeInputs,
} from './agent-inputs'
import { type SubAgentRunCtx, synthesizeDelegationTools } from './sub-agent'

// `./agent` is the single entry point for the agent node: the input helpers live
// in `agent-inputs.ts` and the model loop (+ its result/meta types) in
// `agent-generation.ts`. Re-export the pieces `sub-agent.ts` and external
// consumers import from here so those import paths are unchanged.
export { coerceToMessages, runAgentGeneration, stepAgentVersion }
export type {
  AgentNodeMeta,
  AgentNodeResult,
  RunAgentGenerationArgs,
} from './agent-generation'

export type ExecuteAgentNodeArgs<TDeps> = {
  node: AgentNode
  // NOTE: the node's incoming `input` is deliberately absent. An agent reads only
  // what its prompts declare and its bindings resolve, so handing the payload to
  // this function at all would just be an invitation to reintroduce the implicit
  // user message. `resolveNodeInputs` reaches upstream outputs through
  // `nodeOutputs`, which is the supported path.
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

  /** Eval signal — under simulate, side-effecting tools are neutralized. */
  simulate?: boolean
  /** Canned tool outputs consumed under `simulate`. */
  fixtures?: Record<string, unknown>
  /** Eval integration signal — read tools run live. See RunContext.liveReads. */
  liveReads?: boolean
  /**
   * Eval synthesis signal — run with an EMPTY tool set (no registry tools, no
   * delegation tools), forcing the model to answer from its seeded message
   * history. Grades the final response in isolation. See RunContext.freezeTools.
   */
  freezeTools?: boolean
  /**
   * Eval override. `config` REPLACES the whole agent config the manifest froze
   * (how a goal is run against an author's unsaved draft); `modelId` swaps the
   * model this node runs on and `prompt` REPLACES the system-prompt template
   * (still `${var}`-interpolated against the run's promptVariables), both
   * layered on top of whichever config won. Any field omitted → the agent's
   * saved value. The override is not persisted to `wf_run.manifest`; only the
   * effective model is reflected in `AgentNodeMeta.model` so cost prices against
   * the model used.
   */
  agentOverride?: AgentOverride
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
  subAgentCtx?: SubAgentRunCtx<TDeps>
}

// Resolve the agent an agent node points at from the frozen run manifest. The
// manifest is populated at run start from the version the node pinned (or its
// latest published version when unpinned), so a run is reproducible even as the
// agent drifts.
//
// `override` (an eval running an unsaved draft) wins over the frozen config, and
// is also the one case where a MISSING manifest entry isn't fatal: an agent that
// has never been published has no version for the manifest to freeze, and the
// whole point of the draft path is to evaluate it before it has one. The entry
// is still consulted when present — for `contextLength` (a model fact, not a
// config one) and to stamp which published version the draft diverged from.
function resolveAgentConfig(
  node: AgentNode,
  manifest: WfRunManifestEntry[],
  override?: AgentConfig,
): {
  config: AgentConfig
  contextLength?: number
  /** null when the agent has no published version at all — draft runs only. */
  versionNumber: number | null
} {
  const pin = node.config.version ?? null
  const entry = agentFromManifest(manifest, node.config.agentId, pin)
  if (!entry) {
    if (override) {
      return { config: override, versionNumber: null }
    }
    const at = pin == null ? 'latest' : `v${pin}`
    throw new Error(
      `Agent node ${node.id} references agent ${node.config.agentId || '(none)'} (${at}), which is not in the run manifest.`,
    )
  }
  return {
    config: override ?? entry.config,
    contextLength: entry.contextLength,
    versionNumber: entry.versionNumber,
  }
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
    rehydrate,
    simulate,
    fixtures,
    liveReads,
    freezeTools,
    agentOverride,
    subAgentCtx,
  } = deps
  const { config, contextLength, versionNumber } = resolveAgentConfig(
    node,
    manifest,
    agentOverride?.config,
  )
  // Eval matrix override: swap the model and/or the system-prompt template. Left
  // undefined → the (possibly overridden) config's own value. `modelId` drives
  // both `getModel` and the meta below (so run cost prices against the model
  // actually used).
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
  // thinks at all. Those are different concerns, and they now have two different
  // controls: this node toggle for what is SHOWN, and the agent's own
  // `reasoning` field for whether the model thinks at all. Coupling them would
  // mean a display preference silently changing what the model computes. Note
  // the model's reasoning reaches the dev feed and the post-answer reveal
  // regardless of this toggle (see the always-on `thinking` level in
  // `agent-generation.ts`) — when there is any to show.
  // Whether the model reasons at all is the AGENT's setting, per its config —
  // and it is passed explicitly rather than left undefined. Undefined means "no
  // intent, take the provider default", which for Venice is thinking ON; that
  // implicit default is what made a structural-extraction agent spend two
  // minutes per document in a `<think>` pass nobody asked for.
  const model = getModel(modelId, {
    reasoning: agentOverride?.reasoning ?? config.reasoning,
  })
  // Synthesis eval: an empty tool set forces the model to answer from its seeded
  // history alone. Otherwise resolve the agent's real tools (neutralized under
  // simulate). freezeTools also suppresses delegation-tool synthesis below.
  const tools = freezeTools
    ? {}
    : buildAgentToolSet(toolRegistry, config.toolIds, toolDeps, {
        simulate,
        fixtures,
        liveReads,
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
  // The agent's messages, built ONLY from what the author declared. An incoming
  // edge means sequencing and a source for `ref` bindings — never content. It is
  // deliberately not consulted here: `input` reaches the model only where a
  // binding names it, so nothing arrives that the prompts didn't ask for.
  //
  // This replaced `history = linked ?? unlinkedMessages(input)`, whose fallback
  // JSON-stringified the whole upstream output into an unlabeled user turn. That
  // sent data no prompt referenced, keyed multi-parent joins by internal node id,
  // skipped the blob rehydration that bindings get, and duplicated every payload
  // the system prompt already interpolated.
  const messages = await buildAgentMessages({
    inputKind: config.inputKind,
    userPrompt: substitutePromptVariables(config.userPrompt, vars),
    node,
    nodeOutputs,
    rehydrate,
  })

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
    // Sub-agents inherit THIS node's display intent — they have no `informUser`
    // of their own. The executor builds the context without these (it can't know
    // them); the node that owns the `informUser` field fills them in.
    const delegation = synthesizeDelegationTools(config.subAgents, {
      ...subAgentCtx,
      streamReasoning,
      streamToolCalls,
    })
    for (const name of Object.keys(delegation)) {
      if (Object.hasOwn(tools, name)) {
        throw new Error(
          `Agent ${node.id}: delegation tool '${name}' collides with a registered tool. Rename the sub-agent target's tool name.`,
        )
      }
    }
    effectiveTools = { ...tools, ...delegation }
  }

  const result = await runAgentGeneration({
    model,
    modelId,
    output: config.output,
    maxTurns: config.maxTurns,
    requireToolFirstTurn: config.requireToolFirstTurn,
    toolTokenBudget: config.toolTokenBudget,
    contextLength,
    answerReservePercent: config.answerReservePercent,
    streamReasoning,
    streamToolCalls,
    systemPrompt,
    messages,
    tools: effectiveTools,
    toolStatusLabels,
    sink,
    budget: deps.modelBudget,
  })
  // Stamp WHICH agent this was onto the recorded meta. Generation only knows a
  // prompt and a model; without this, a step can only be traced back to an agent
  // through its workflow version's graph — which the agent editor's "recent
  // calls" would otherwise have to reverse-engineer for every run.
  return {
    ...result,
    meta: {
      ...result.meta,
      agentId: node.config.agentId,
      // Absent when a draft ran against an agent with no published version —
      // the field is optional precisely so "no version" stays distinguishable
      // from "version 0".
      agentVersion: versionNumber ?? undefined,
    },
  }
}
