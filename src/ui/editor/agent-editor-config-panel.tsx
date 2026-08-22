import {
  Braces,
  Cpu,
  MessageSquareText,
  MessagesSquare,
  Settings2,
  Users,
  Wrench,
} from 'lucide-react'
import { useMemo } from 'react'

import type { AgentConfig } from '../../engine'
import { cn } from '../cn'
import { useWfComponents } from '../context'
import { useModels, useTools } from '../hooks'

import { AgentBudgetSection } from './agent-editor-budget'
import { AgentInputEditor } from './agent-input-editor'
import { AgentOutputEditor } from './agent-output-editor'
import { EditorSection } from './editor-section'
import { ModelSelect } from './model-select'
import { PromptBodyEditor } from './prompt-body-editor'
import { SubAgentPicker } from './sub-agent-picker'
import { ToolPicker } from './tool-picker'

// The agent editor's LEFT column: everything that is a setting on the agent.
// (The right column is the evidence half — evals and the playground — and lives
// in the editor itself, which owns the split.)
//
// It sits apart from `agent-editor.tsx` because the whole cluster of derived
// facts below — what the selected model can do, whether there is a tool loop at
// all, and what a turn therefore costs — is read by these controls and by
// nothing else. Keeping it here means the editor holds draft STATE and this
// holds what that state IMPLIES, rather than one component holding both.
export function AgentConfigPanel({
  agentId,
  agentName,
  agentDescription,
  config,
  initialConfig,
  patch,
  registerSetBody,
  registerSetUserPrompt,
}: {
  agentId: string
  /** Entity metadata, passed down purely as Copilot grounding for the output schema. */
  agentName: string
  agentDescription: string
  config: AgentConfig
  /** Seeds the TipTap prompt editors once; later edits arrive through `patch`. */
  initialConfig: AgentConfig
  patch: (next: Partial<AgentConfig>) => void
  registerSetBody: (set: (body: string) => void) => void
  registerSetUserPrompt: (set: (body: string) => void) => void
}) {
  const { Checkbox } = useWfComponents()
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
  function patchToolsAndRetireLoop(next: Partial<AgentConfig>) {
    const merged = { ...config, ...next }
    const stillHasTools =
      merged.toolIds.length > 0 || merged.subAgents.targets.length > 0
    patch(
      stillHasTools
        ? next
        : {
            ...next,
            maxTurns: 1,
            requireToolFirstTurn: false,
            toolTokenBudget: null,
          },
    )
  }


  return (
      <div className="space-y-6">
        {/* Model */}
        <EditorSection
          icon={Cpu}
          title="Model"
          description="The LLM that powers this agent."
        >
          <ModelSelect
            value={config.modelId}
            onChange={(modelId) => patch({ modelId })}
            // Gate the picker on what THIS agent needs: a tool-calling model
            // when tools are attached, and structured output for a Yes/No or
            // structured result (both go through `generateObject`).
            requirements={{
              tools: config.toolIds.length > 0,
              structuredOutput:
                config.output.kind === 'object' ||
                config.output.kind === 'boolean',
            }}
          />
        </EditorSection>

        {/* System Prompt */}
        <EditorSection
          icon={MessageSquareText}
          title="System Prompt"
          description="The system instructions that define what this agent does."
        >
          <PromptBodyEditor
            initialBody={initialConfig.prompt}
            onChange={(body) => patch({ prompt: body })}
            registerSetBody={registerSetBody}
          />
        </EditorSection>

        {/* Input — the peer of "Expected output": what this agent
        receives. Sits directly under the system prompt because the two
        are one authoring act now that nothing arrives implicitly. */}
        <EditorSection
          icon={MessagesSquare}
          title="Input"
          description="Where this agent's messages come from, and the data it runs on."
        >
          <AgentInputEditor
            inputKind={config.inputKind}
            userPrompt={config.userPrompt}
            initialUserPrompt={initialConfig.userPrompt}
            onChange={patch}
            registerSetUserPrompt={registerSetUserPrompt}
          />
        </EditorSection>

        {/* Tools — folded away when the agent has none, same as
        Sub-agents: the header stays discoverable, the picker doesn't
        take the space until it's actually in use. */}
        <EditorSection
          icon={Wrench}
          title="Tools"
          collapsible
          defaultCollapsed={config.toolIds.length === 0}
          description="Tools the agent may call while it works."
        >
          <ToolPicker
            tools={aiTools}
            selectedIds={config.toolIds}
            onChange={(toolIds) =>
              patchToolsAndRetireLoop({ toolIds })
            }
            disabled={modelLacksTools}
            disabledReason={`${selectedModel?.label ?? 'The selected model'} can’t call tools — pick a tool-calling model to attach tools.`}
          />
        </EditorSection>

        {/* Sub-agents (delegation) — delegation is the exception, not the
        norm, so an agent with none opens folded: the header keeps it
        discoverable without spending a screenful of picker and
        guardrails on a feature this agent isn't using. */}
        <EditorSection
          icon={Users}
          title="Sub-agents"
          collapsible
          defaultCollapsed={config.subAgents.targets.length === 0}
          description={
            <>
              Agents or workflows this agent may spawn as sub-agents.
              It gets a tool to launch each in the background and an{' '}
              <code className="text-[11px]">await_subagents</code>{' '}
              tool to gather their results — like Claude Code's
              sub-agents.
            </>
          }
        >
          <SubAgentPicker
            value={config.subAgents}
            onChange={(subAgents) =>
              patchToolsAndRetireLoop({ subAgents })
            }
            currentAgentId={agentId}
          />
        </EditorSection>

        {/* Expected output */}
        <EditorSection
          icon={Braces}
          title="Expected output"
          description="The shape of the result the agent must return."
        >
          <AgentOutputEditor
            value={config.output}
            onChange={(output) => patch({ output })}
            structuredDisabled={modelLacksStructuredOutput}
            structuredDisabledReason={`${selectedModel?.label ?? 'The selected model'} doesn’t support structured output — only a Text result is available.`}
            copilotContext={schemaCopilotContext}
          />
        </EditorSection>

        <AgentBudgetSection
          config={config}
          patch={patch}
          hasToolsOrSubAgents={hasToolsOrSubAgents}
          modelLabel={selectedModel?.label}
          contextLength={selectedModel?.contextLength}
          costPerMTok={selectedModel?.costPerMTok}
        />

        {/* Settings — behavior switches that aren't limits. What the
      agent is FED moved out to its own "Input" section, next to the
      prompt it belongs with. */}
        <EditorSection
          icon={Settings2}
          title="Settings"
          description="How the agent behaves while it works."
        >
          <label
            className={cn(
              'flex items-start gap-2.5',
              requireToolReason
                ? 'cursor-not-allowed opacity-60'
                : 'cursor-pointer',
            )}
          >
            <span className="min-w-0 flex-1">
              <span className="text-foreground block text-sm font-medium">
                Require a tool or agent call on the first turn
              </span>
              <span className="mt-0.5 block text-xs text-neutral-400">
                The agent must call a tool or spawn a sub-agent before
                it may answer, instead of replying from what the model
                already knows. Use it when an answer is only
                trustworthy if the agent looked something up or
                delegated first. Later turns are unaffected — it may
                answer as soon as it has read the results.
              </span>
            </span>
            <Checkbox
              className="mt-0.5"
              checked={
                config.requireToolFirstTurn && !requireToolReason
              }
              disabled={!!requireToolReason}
              onChange={(e) =>
                patch({ requireToolFirstTurn: e.target.checked })
              }
            />
          </label>
          {requireToolReason ? (
            <p className="text-xs text-amber-600">
              {requireToolReason}
            </p>
          ) : null}
        </EditorSection>
      </div>
  )
}
