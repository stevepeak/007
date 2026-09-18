import type { AgentConfig } from '../../engine'
import { useModels, useTools } from '../hooks'

// What the draft config IMPLIES — as opposed to what it says. Every value here
// is read off the config and the host's catalogs, and every one of them gates a
// control in the config panel.
//
// Two ideas do most of the work:
//
//   • CAPABILITIES ARE GATED ONLY WHEN REPORTED. The model picker already
//     filters to models that meet the agent's needs, so the inverse holds here:
//     a section is disabled only when the chosen model's catalog reported
//     capabilities AND this one is absent. A model with no capability info at
//     all (the pre-refresh static list) is treated as capable, because the
//     alternative is disabling working features on missing metadata.
//
//   • A TURN IS A ROUND OF CALLING SOMETHING. Delegation synthesizes
//     `spawn_*` / `await_subagents` into the tool set, so an agent with only
//     sub-agents runs just as real a multi-turn loop as one with only tools.
//     Everything that asks "is there a loop here?" gates on
//     `hasToolsOrSubAgents`, never on `toolIds` alone.

export function useAgentConfigFacts(config: AgentConfig) {
  const tools = useTools()
  const aiTools = (tools.data ?? []).filter((t) => t.kind === 'ai-tool')

  // What the currently-selected model can do. The picker only offers models
  // that meet the agent's needs, so the inverse holds here: if the chosen model
  // is KNOWN to lack a capability, the editor sections that depend on it are
  // disabled. Capabilities are only gated when reported — a model with no
  // capability info (e.g. the pre-refresh static list) is treated as capable.
  const models = useModels()

  const selectedModel = (models.data ?? []).find((m) => m.id === config.modelId)
  const modelCaps = selectedModel?.capabilities
  // Only disable a section when the model is KNOWN to lack the capability (its
  // catalog reported one but not this flag). Unknown capabilities stay enabled.
  const modelLacksTools = modelCaps != null && !modelCaps.tools
  const modelLacksStructuredOutput =
    modelCaps != null && !modelCaps.structuredOutput
  // Same "gated only when reported" rule: a model the catalog says cannot reason
  // makes the reasoning control meaningless, so it is disabled rather than
  // silently ignored at run time.
  const modelLacksReasoning = modelCaps != null && !modelCaps.reasoning
  // Provider-side web search is a per-model feature of the provider's own
  // pipeline, so a model the catalog says can't search makes the setting inert.
  const modelLacksWebSearch = modelCaps != null && !modelCaps.webSearch

  // A turn is a round of calling SOMETHING, and delegation synthesizes
  // `spawn_*` / `await_subagents` into the tool set — so an agent with only
  // sub-agents runs just as real a multi-turn loop as one with only tools.
  // Everything that asks "is there a loop here?" gates on this, never on
  // toolIds alone.
  const hasToolsOrSubAgents =
    config.toolIds.length > 0 || config.subAgents.targets.length > 0

  // With neither, there is no loop to bound: the model answers on turn 1 and
  // stops, whatever `maxTurns` says. Turns and the budget are both meaningless
  // in that shape, so the fields go read-only rather than inviting the author to
  // tune numbers that can't do anything.

  // The one shape where attached tools are NEVER offered to the model: a single
  // turn. The engine denies tools on the final answering turn (see
  // `prepareStep` in `runToolLoop`), and with one turn that is the only turn —
  // so the agent has tools it structurally cannot call, and a prompt that says
  // "use the tool" is talking to a model that can't see one. Stated where the
  // tools are attached, not just in the budget section: a run that quietly
  // answers without them looks like the model chose not to, and the author has
  // to be told the choice was never on the table.
  const toolsUnreachableReason =
    hasToolsOrSubAgents && config.maxTurns < 2
      ? 'Max turns is 1, so the only turn is the answering turn and the agent is never offered its tools. Raise Max turns to at least 2 for it to call them.'
      : null

  // The shapes where "require a call on turn 1" is inert. It lives in Settings,
  // which renders unconditionally, so the no-target case has to be stated here
  // rather than handled by not drawing the control. Mirrors the engine's
  // `forceFirstTool` guard; keep the two in step. The output kind is NOT a
  // shape: a structured agent runs the same loop and ends it with the object.
  const requireToolReason = !hasToolsOrSubAgents
    ? 'Attach a tool or sub-agent for the agent to be required to call.'
    : config.maxTurns < 2
      ? 'Needs at least 2 max turns — with 1, that turn is also the final answering turn, which never calls tools.'
      : null

  return {
    aiTools,
    models,
    selectedModel,
    modelLacksTools,
    modelLacksStructuredOutput,
    modelLacksReasoning,
    modelLacksWebSearch,
    hasToolsOrSubAgents,
    toolsUnreachableReason,
    requireToolReason,
  }
}
