import type { Tool } from 'ai'

import type { ModelFactory, RunFlags } from '../config'
import {
  agentFromManifest,
  type AgentConfig,
  type AgentNode,
  substitutePromptVariables,
  type WfRunManifestEntry,
} from '../graph'
import type { ModelBudget } from '../model-budget'
import type { ReferenceKind } from '../references'
import type { StreamSink } from '../stream-sink'
import { buildAgentToolSet, type ToolRegistry } from '../tool-registry'

import {
  runAgentGeneration,
  stepAgentVersion,
  type AgentNodeResult,
  type RunAgentGenerationArgs,
} from './agent-generation'
import {
  buildAgentMessages,
  coerceToMessages,
  resolveNodeInputs,
} from './agent-inputs'
import {
  enabledReferenceKinds,
  finalizeReferences,
  withReferencePrompt,
} from './agent-references'
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

export type ExecuteAgentNodeArgs<TDeps> = RunFlags & {
  node: AgentNode
  // NOTE: the node's incoming `input` is deliberately absent. An agent reads only
  // what its prompts declare and its bindings resolve, so handing the payload to
  // this function at all would just be an invitation to reintroduce the implicit
  // user message. `resolveNodeInputs` reaches upstream outputs through
  // `nodeOutputs`, which is the supported path.
  getModel: ModelFactory
  toolRegistry: ToolRegistry<TDeps>
  /**
   * The host's reference-kind catalog; the agent's `referenceKinds` pick from
   * it. Optional HERE (direct callers and tests) but required on
   * `RunNodeContext`, which is what every real backend builds.
   */
  referenceKinds?: readonly ReferenceKind[]
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
    // Every agent node lands here when its entry is missing, decision agents
    // included: the manifest is the only record of an agent's kind, so a node
    // with no entry cannot be told apart. The message has to serve both.
    const at = pin == null ? 'latest' : `v${pin}`
    throw new Error(
      `Agent node ${node.id} references agent ${node.config.agentId || '(none)'} (${at}), which is not in the run manifest. ${pin == null ? 'Publish a version of that agent' : 'Pin a published version of that agent'}, then republish this workflow so the reference resolves.`,
    )
  }
  return {
    config: override ?? entry.config,
    contextLength: entry.contextLength,
    versionNumber: entry.versionNumber,
  }
}


/**
 * Run one agent config to an answer — the part a primary agent node and a
 * spawned sub-agent share: model, registry tools, status labels, system prompt
 * with references, the generation loop and the reference check. What differs
 * is the caller's: which model and prompt (an eval may override them), the
 * messages, the display intent, and any tools it adds (delegation, the stop
 * signal).
 */
export async function runAgentConfig<TDeps>(args: {
  config: AgentConfig
  modelId: string
  reasoning: boolean | undefined
  promptTemplate: string
  vars: Record<string, string | undefined>
  messages: RunAgentGenerationArgs['messages']
  contextLength: number | undefined
  stream: { reasoning: boolean; toolCalls: boolean }
  /** Names the agent in errors, e.g. `Agent <nodeId>`. */
  label: string
  /** Added to the registry tools; a name already registered is an error. */
  extraTools?: Record<string, Tool>
  ctx: RunFlags & {
    getModel: ModelFactory
    toolRegistry: ToolRegistry<TDeps>
    referenceKinds: readonly ReferenceKind[]
    toolDeps: TDeps
    sink?: StreamSink
    modelBudget?: ModelBudget
  }
}): Promise<AgentNodeResult> {
  const { config, ctx } = args
  // Whether the model reasons at all is the AGENT's setting, passed explicitly
  // rather than left undefined: undefined means "take the provider default",
  // which on some providers is thinking ON. Provider-side web search is the
  // agent's own setting too — an eval has no business turning on a network
  // path the agent's author left off.
  const model = ctx.getModel(args.modelId, {
    reasoning: args.reasoning,
    webSearch: config.webSearch,
    webCitations: config.webCitations,
  })
  // Synthesis eval: an empty tool set forces the model to answer from its seeded
  // history alone. Otherwise resolve the agent's real tools (neutralized under
  // simulate).
  const tools = ctx.freezeTools
    ? {}
    : buildAgentToolSet(ctx.toolRegistry, config.toolIds, ctx.toolDeps, {
        simulate: ctx.simulate,
        fixtures: ctx.fixtures,
        liveReads: ctx.liveReads,
        toolModes: ctx.toolModes,
      })
  for (const name of Object.keys(args.extraTools ?? {})) {
    if (Object.hasOwn(tools, name)) {
      throw new Error(
        `${args.label}: tool '${name}' collides with a registered tool. Rename the sub-agent target's tool name.`,
      )
    }
  }
  // Human-readable status templates, keyed by tool id (the ToolSet's own key, so
  // it matches `toolName` at call time). Only tools that declare a `statusLabel`
  // appear here; the emission is further gated on `stream.toolCalls`.
  const toolStatusLabels: Record<string, string> = {}
  for (const id of config.toolIds) {
    const label = ctx.toolRegistry.get(id)?.statusLabel
    if (label) toolStatusLabels[id] = label
  }
  const authorPrompt = substitutePromptVariables(args.promptTemplate, args.vars)
  // Inline references: the grammar and each opted-in kind's guidance go AFTER
  // the author's prompt, so an author never writes link syntax by hand.
  const kinds = enabledReferenceKinds(config, ctx.referenceKinds, args.label)
  const generated = await runAgentGeneration({
    model,
    modelId: args.modelId,
    output: config.output,
    maxTurns: config.maxTurns,
    requireToolFirstTurn: config.requireToolFirstTurn,
    // Each agent run gets its OWN tool-token budget — a primary that fans out
    // to five sub-agents can spend roughly five; its `maxSpawns` is the guard.
    toolTokenBudget: config.toolTokenBudget,
    contextLength: args.contextLength,
    answerReservePercent: config.answerReservePercent,
    streamReasoning: args.stream.reasoning,
    streamToolCalls: args.stream.toolCalls,
    systemPrompt: withReferencePrompt(authorPrompt, kinds),
    messages: args.messages,
    tools: { ...tools, ...args.extraTools },
    toolStatusLabels,
    sink: ctx.sink,
    budget: ctx.modelBudget,
  })
  // What an agent hands back is what a reader (or its parent) may re-cite, so
  // it must already be clean.
  return await finalizeReferences({
    result: generated,
    kinds,
    authorPrompt,
    sink: ctx.sink,
  })
}
export async function executeAgentNode<TDeps>(
  deps: ExecuteAgentNodeArgs<TDeps>,
): Promise<AgentNodeResult> {
  const {
    node,
    referenceKinds = [],
    promptVariables,
    nodeOutputs,
    manifest,
    rehydrate,
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

  // Node-level bound inputs override the run-level promptVariables.
  const vars = {
    ...promptVariables,
    ...(await resolveNodeInputs(node, nodeOutputs, rehydrate)),
  }
  // The agent's messages, built ONLY from what the author declared. An incoming
  // edge means sequencing and a source for `ref` bindings — never content. It is
  // deliberately not consulted here: `input` reaches the model only where a
  // binding names it, so nothing arrives that the prompts didn't ask for.
  const messages = await buildAgentMessages({
    inputKind: config.inputKind,
    userPrompt: substitutePromptVariables(config.userPrompt, vars),
    node,
    nodeOutputs,
    rehydrate,
  })

  // Delegation: when this agent whitelists sub-agents/workflows, add the
  // synthesized spawn/await tools. freezeTools suppresses them along with the
  // registry tools.
  const delegation =
    !freezeTools &&
    subAgentCtx &&
    (config.subAgents?.targets.length ?? 0) > 0
      ? // Sub-agents inherit THIS node's display intent — they have no
        // `informUser` of their own. The executor builds the context without
        // these (it can't know them); the node that owns the field fills them in.
        synthesizeDelegationTools(config.subAgents, {
          ...subAgentCtx,
          streamReasoning,
          streamToolCalls,
        })
      : undefined

  const result = await runAgentConfig({
    config,
    modelId,
    reasoning: agentOverride?.reasoning ?? config.reasoning,
    promptTemplate,
    vars,
    messages,
    contextLength,
    stream: { reasoning: streamReasoning, toolCalls: streamToolCalls },
    label: `Agent ${node.id}`,
    extraTools: delegation,
    ctx: { ...deps, referenceKinds },
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
