import { useMemo } from 'react'

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

export function useAgentConfigFacts(
  config: AgentConfig,
  agentName: string,
  agentDescription: string,
) {
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

// What the Copilot needs to talk about this agent's output shape: what it is
// told to do, and what it can call. Tool IDS are resolved to names because the
// name is what an author (and the Copilot) reasons about.
const schemaCopilotContext = useMemo(
  () => ({
    agentName,
    agentDescription,
    instructions: config.prompt,
    toolNames: config.toolIds.map(
      (id) => aiTools.find((t) => t.id === id)?.name ?? id,
    ),
  }),
  [agentName, agentDescription, config.prompt, config.toolIds, aiTools],
)

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


// The three shapes where "require a call on turn 1" is inert. It lives in
// Settings now, which renders unconditionally, so the no-target case has to be
// stated here rather than handled by not drawing the control. Mirrors the
// engine's `forceFirstTool` guard; keep the two in step.
const requireToolReason = !hasToolsOrSubAgents
  ? 'Attach a tool or sub-agent for the agent to be required to call.'
  : config.output.kind !== 'text'
    ? 'Only Text agents run a tool loop — a structured result is generated in one pass, with no tools.'
    : config.maxTurns < 2
      ? 'Needs at least 2 max turns — with 1, that turn is also the final answering turn, which never calls tools.'
      : null


// Dropping the last tool retires the loop, so the turn count and budget that
// described it are retired with it — patched at the point of change rather
// than in an effect, which would mark an untouched agent dirty on open.

  return {
    aiTools,
    models,
    selectedModel,
    modelLacksTools,
    modelLacksStructuredOutput,
    schemaCopilotContext,
    hasToolsOrSubAgents,
    requireToolReason,
  }
}
