import {
  Braces,
  Cpu,
  Globe,
  MessageSquareText,
  MessagesSquare,
  Settings2,
  Users,
  Wrench,
} from 'lucide-react'

import {
  type AgentConfig,
  type AgentOutput,
  agentModelRequirements,
  type WebSearchMode,
} from '../../engine'
import { cn } from '../cn'
import { useWfComponents } from '../context'

import { AgentBudgetSection } from './agent-editor-budget'
import { AgentInputEditor } from './agent-input-editor'
import { AgentOutputEditor } from './agent-output-editor'
import { EditorSection } from './editor-section'
import { ModelSelect } from './model-select'
import { PromptBodyEditor } from './prompt-body-editor'
import { SubAgentPicker } from './sub-agent-picker'
import { ToolPicker } from './tool-picker'
import { useAgentConfigFacts } from './use-agent-config-facts'

// The agent editor's LEFT column: everything that is a setting on the agent.
// (The right column is the evidence half — evals and the playground — and lives
// in the editor itself, which owns the split.)
//
// It sits apart from `agent-editor.tsx` because the whole cluster of derived
// facts it reads — what the selected model can do, whether there is a tool loop
// at all, and what a turn therefore costs — is used by these controls and by
// nothing else. Those live in `useAgentConfigFacts`, so the editor holds draft
// STATE, that hook holds what the state IMPLIES, and this file holds what the
// author sees.
//
// LENGTH: this function runs past the ~200-line bar the codebase otherwise
// keeps to, and that is a decision rather than an omission. What remains after
// the derivations moved out is a FLAT SEQUENCE of seven `<EditorSection>`
// blocks — no nesting, no branching, no shared local state between them — read
// top to bottom in the order they appear on screen. Splitting it would trade
// one file you can read straight through for seven you have to assemble in your
// head, and would break the property that the file order IS the screen order.
// Each section is already its own component (`ToolPicker`, `AgentOutputEditor`,
// `AgentBudgetSection`, …); what is left here is the arrangement of them.
export function AgentConfigPanel({
  agentId,
  config,
  initialConfig,
  patch,
  zodSource,
  editZodSource,
  registerSetBody,
  registerSetUserPrompt,
}: {
  agentId: string
  config: AgentConfig
  /** Seeds the TipTap prompt editors once; later edits arrive through `patch`. */
  initialConfig: AgentConfig
  patch: (next: Partial<AgentConfig>) => void
  /** The output schema's Zod source, held upstream so undo can restore it. */
  zodSource: string
  /** One edit carries both halves — see `AgentOutputEditor`'s `onSourceEdit`. */
  editZodSource: (edit: { source: string; output?: AgentOutput }) => void
  registerSetBody: (set: (body: string) => void) => void
  registerSetUserPrompt: (set: (body: string) => void) => void
}) {
  const { Checkbox, Select } = useWfComponents()
  const {
    aiTools,
    selectedModel,
    models,
    modelLacksTools,
    modelLacksStructuredOutput,
    modelLacksReasoning,
    modelLacksWebSearch,
    hasToolsOrSubAgents,
    requireToolReason,
  } = useAgentConfigFacts(config)

  // Switching models must not leave a setting behind that the new model cannot
  // honour. `reasoning: true` against a non-reasoning model is inert at run time
  // (the host only ever ACTS on `false`, by injecting `disable_thinking`), which
  // is precisely what makes it worth clearing: an inert-but-true flag reads like
  // a live switch in a stored config and in run dumps, and that is the exact
  // confusion that got the previous `enableReasoning` deleted.
  //
  // Unknown capabilities are left alone, matching the rule everywhere else here:
  // only a model KNOWN to lack reasoning clears the flag.
  //
  // Web search gets the same treatment, for a sharper reason: a stored
  // `webSearch: 'on'` against a model that can't search reads like a live
  // network path in a config review, and the whole point of the setting being
  // explicit is that a reviewer can trust what it says.
  function patchModel(modelId: string) {
    const next = (models.data ?? []).find((m) => m.id === modelId)
    const caps = next?.capabilities
    const knownToLackReasoning = caps != null && !caps.reasoning
    const knownToLackWebSearch = caps != null && !caps.webSearch
    patch({
      modelId,
      ...(knownToLackReasoning && config.reasoning ? { reasoning: false } : {}),
      ...(knownToLackWebSearch && config.webSearch !== 'off'
        ? { webSearch: 'off' as const, webCitations: false }
        : {}),
    })
  }

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
          onChange={patchModel}
          // Gate the picker on what THIS agent needs (see
          // `agentModelRequirements`). The picker is the PRIMARY guard — a
          // model that can't meet a requirement is never offered — and the
          // per-section disabled states below are the backstop for a config
          // that arrived some other way (a spec import, or a catalog refresh
          // that changed a model).
          requirements={agentModelRequirements(config)}
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
          onChange={(toolIds) => {
            return patchToolsAndRetireLoop({ toolIds })
          }}
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
            Agents or workflows this agent may spawn as sub-agents. It gets a
            tool to launch each in the background and an{' '}
            <code className="text-[11px]">await_subagents</code> tool to gather
            their results — like Claude Code's sub-agents.
          </>
        }
      >
        <SubAgentPicker
          value={config.subAgents}
          onChange={(subAgents) => {
            return patchToolsAndRetireLoop({ subAgents })
          }}
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
          source={zodSource}
          onSourceEdit={editZodSource}
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
              The agent must call a tool or spawn a sub-agent before it may
              answer, instead of replying from what the model already knows. Use
              it when an answer is only trustworthy if the agent looked
              something up or delegated first. Later turns are unaffected — it
              may answer as soon as it has read the results.
            </span>
          </span>
          <Checkbox
            className="mt-0.5"
            checked={config.requireToolFirstTurn && !requireToolReason}
            disabled={!!requireToolReason}
            onChange={(e) => {
              return patch({ requireToolFirstTurn: e.target.checked })
            }}
          />
        </label>
        {requireToolReason ? (
          <p className="text-xs text-amber-600">{requireToolReason}</p>
        ) : null}
        <label
          className={cn(
            'flex items-start gap-2.5',
            modelLacksReasoning
              ? 'cursor-not-allowed opacity-60'
              : 'cursor-pointer',
          )}
        >
          <span className="min-w-0 flex-1">
            <span className="text-foreground block text-sm font-medium">
              Think before answering
            </span>
            <span className="mt-0.5 block text-xs text-neutral-400">
              The model reasons through the problem in a separate pass before it
              starts answering. It costs a full extra generation — seconds on a
              short task, minutes on a long one — so it is off unless the work
              earns it.
              <br />
              <strong className="text-neutral-300">Turn it on</strong> when the
              agent has to decide something and a wrong call is expensive:
              weighing documents against each other, judgement calls like
              conflict or risk checks, long tool loops where the next step
              depends on reading the last one properly, or open-ended questions.
              <br />
              <strong className="text-neutral-300">Leave it off</strong> when
              the answer is already in the input and the job is to reshape it:
              extracting to a schema, classifying, summarizing one passage — and
              especially for per-item work inside a loop, where the cost
              multiplies by the number of items.
            </span>
          </span>
          <Checkbox
            className="mt-0.5"
            checked={config.reasoning && !modelLacksReasoning}
            disabled={modelLacksReasoning}
            onChange={(e) => patch({ reasoning: e.target.checked })}
          />
        </label>
        {modelLacksReasoning ? (
          <p className="text-xs text-amber-600">
            {selectedModel?.label ?? 'This model'} does not support reasoning.
          </p>
        ) : null}
      </EditorSection>

      {/* Web search — the PROVIDER's search, run inside the completion, as
      opposed to a search tool the agent calls. Its own section rather than a
      switch under Settings because it opens a network path and the author
      has to understand what leaves before turning it on. */}
      <EditorSection
        icon={Globe}
        title="Web search"
        description="Let the model provider search the web while answering."
      >
        <div
          className={cn(
            'space-y-2',
            modelLacksWebSearch ? 'cursor-not-allowed opacity-60' : null,
          )}
        >
          <Select
            value={modelLacksWebSearch ? 'off' : config.webSearch}
            disabled={modelLacksWebSearch}
            onChange={(e) => {
              const webSearch = e.target.value as WebSearchMode
              patch(
                webSearch === 'off'
                  ? { webSearch, webCitations: false }
                  : { webSearch },
              )
            }}
          >
            {WEB_SEARCH_MODE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          <p className="text-xs text-neutral-400">
            {WEB_SEARCH_MODE_HELP[config.webSearch]}
          </p>
          {config.webSearch !== 'off' ? (
            <p className="rounded-md border border-amber-200 bg-amber-50 px-2.5 py-2 text-xs text-amber-800">
              The provider writes the search query from the full conversation
              — including anything a client said — and sends it out before the
              model answers. Nothing here screens or logs that query. Leave
              this off for any agent whose context can hold privileged or
              confidential detail; give it a search tool instead.
            </p>
          ) : null}
        </div>
        {config.webSearch !== 'off' && !modelLacksWebSearch ? (
          <label className="flex cursor-pointer items-start gap-2.5">
            <span className="min-w-0 flex-1">
              <span className="text-foreground block text-sm font-medium">
                Cite sources
              </span>
              <span className="mt-0.5 block text-xs text-neutral-400">
                Ask the model to footnote claims with the pages it read, as
                superscript references in the answer. Off, it still reads the
                results but writes a plain answer.
              </span>
            </span>
            <Checkbox
              className="mt-0.5"
              checked={config.webCitations}
              onChange={(e) => patch({ webCitations: e.target.checked })}
            />
          </label>
        ) : null}
        {modelLacksWebSearch ? (
          <p className="text-xs text-amber-600">
            {selectedModel?.label ?? 'This model'} does not support web search.
          </p>
        ) : null}
      </EditorSection>
    </div>
  )
}

// One line per mode, in the order the select lists them. `off` first because
// it is the default and the safe choice; `auto` before `on` because it is the
// cheaper of the two ways to turn it on.
const WEB_SEARCH_MODE_OPTIONS: { value: WebSearchMode; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'auto', label: 'Auto — search when the question seems to need it' },
  { value: 'on', label: 'On — search before every reply' },
]

const WEB_SEARCH_MODE_HELP: Record<WebSearchMode, string> = {
  off: 'The model answers from its instructions, its tools and the conversation only. Default.',
  auto: 'The provider decides per message whether a web search would help — recent events, a public fact it may not know — and searches only then. Cheapest, and the model may skip a search you expected.',
  on: 'The provider searches the web before every reply, whatever the question. Most current, and every turn pays for a search and waits on it.',
}
