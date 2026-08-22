import {
  Archive,
  Braces,
  Check,
  Cpu,
  History,
  MessageSquareText,
  MessagesSquare,
  Settings2,
  Users,
  Wallet,
  Wrench,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { type AgentConfig } from '../../engine'
import type { WfAgentCall } from '../../server/protocol'
import { AGENT_ICONS, DEFAULT_AGENT_COLOR } from '../agent-appearance'
import { AppearancePicker } from '../appearance-picker'
import { cn } from '../cn'
import { useWfClient, useWfComponents } from '../context'
import { Tabs } from '../filters'
import {
  useAgent,
  useAgentVersions,
  useModels,
  usePublishAgent,
  useSaveAgentDraft,
  useTools,
  useUpdateAgentMeta,
} from '../hooks'
import { useWfNav } from '../nav'
import { QueryState } from '../query-state'
import { WfShell } from '../shell'
import { SaveStateBadge } from '../save-state-badge'
import { Tooltip } from '../tooltip'
import { AgentEvalsPanel } from './agent-editor-evals'
import { AgentInputEditor } from './agent-input-editor'
import { AgentOutputEditor } from './agent-output-editor'
import { AgentCallInspect } from './agent-editor-call-inspect'
import { AgentCallMetrics, AgentCallsList, callKey } from './agent-editor-calls'
import { ArchiveAgentDialog } from './agent-editor-archive'
import { EditorSection } from './editor-section'
import { VersionsMenu } from './editor-menus'
import { fmt, humanTokens, usd } from './format-tokens'
import { PlaygroundPanel } from './agent-editor-playground'
import { PublishAgentDialog } from './agent-editor-publish'
import { ModelSelect } from './model-select'
import { PromptBodyEditor } from './prompt-body-editor'
import { SubAgentPicker } from './sub-agent-picker'
import { ToolPicker } from './tool-picker'

// The agent editor — same draft/version lifecycle as the prompt editor, but
// over the whole AgentConfig (model, prompt, tools, expected output, advanced),
// plus the entity's appearance (icon + color), which lives in the header popover
// behind the title icon and saves immediately. The right-hand column is the
// evidence half: the agent's eval goals and an isolated Playground, both running
// the live DRAFT so a change can be judged before it is published.

/**
 * The agent's research budget: one number, in tokens.
 *
 * It caps RESEARCH, not the run. The final answer is generated on top of this
 * number and nothing bounds it (no `maxOutputTokens` is passed), so the honest
 * framing is a floor — "from $X" — not a total. An earlier draft split this into
 * a budget plus a "reserve %" for the answer, which enforced nothing: the reserve
 * was a subtraction shown back to the author while the only number with any
 * effect was the ceiling. One field, stated plainly, is the whole feature.
 *
 * Note what is NOT here: the context-window guard. Overflowing the window is a
 * hard provider error with no tradeoff to tune, so it's always on in the engine
 * and deliberately has no control — see `contextLength` in `agent-generation.ts`.
 */
function TokenBudgetField({
  value,
  onChange,
  maxTurns,
  modelLabel,
  contextLength,
  costPerMTok,
  suggestedTokens,
  worstCaseTokens,
  disabledReason,
}: {
  value: number | null
  onChange: (next: number | null) => void
  maxTurns: number
  modelLabel?: string
  contextLength?: number
  costPerMTok?: number
  suggestedTokens: number | null
  worstCaseTokens: number | null
  disabledReason: string | null
}) {
  const { Input, Checkbox, Button } = useWfComponents()
  const on = value != null && !disabledReason
  const budget = value ?? suggestedTokens ?? 100_000
  const cost = costPerMTok != null ? (budget / 1_000_000) * costPerMTok : null
  // What this agent can cost with nothing stopping it. Shown while the budget is
  // OFF, which is the state where the number is a risk rather than a footnote.
  const worstCaseCost =
    costPerMTok != null && worstCaseTokens != null
      ? (worstCaseTokens / 1_000_000) * costPerMTok
      : null

  return (
    <div>
      <label
        className={cn(
          'flex items-start gap-2.5',
          disabledReason ? 'cursor-not-allowed' : 'cursor-pointer',
        )}
      >
        <span className="min-w-0 flex-1">
          <span className="text-foreground block text-sm font-medium">
            Research budget
          </span>
          <span className="mt-0.5 block text-xs text-neutral-400">
            Stop calling tools once the agent has spent this many tokens, and
            make it answer with what it has. Without one, only max turns and the
            node&rsquo;s time limit bound the agent — and running out of time
            fails the run outright instead of producing an answer.
          </span>
        </span>
        <Checkbox
          className="mt-0.5"
          checked={on}
          disabled={!!disabledReason}
          onChange={(e) =>
            onChange(e.target.checked ? (suggestedTokens ?? 100_000) : null)
          }
        />
      </label>

      {/* The unbudgeted exposure, stated while the budget is OFF. This is the
          default state, so it's the one that has to carry the number — an author
          who never opens this field should still have seen what the agent can
          cost. `worstCaseTokens` is maxTurns × the model's window: every turn
          re-sends the conversation, so a loop that fills the window each turn
          lands near it. */}
      {!on && !disabledReason && worstCaseTokens != null ? (
        <p className="mt-2 text-xs text-amber-600">
          ⚠ Unbudgeted, this agent is bounded only by Max turns: {maxTurns}{' '}
          {maxTurns === 1 ? 'turn' : 'turns'} ×{' '}
          {humanTokens(contextLength as number)} of context is up to{' '}
          {humanTokens(worstCaseTokens)} tokens
          {worstCaseCost != null ? (
            <> — about {usd(worstCaseCost)}</>
          ) : null}{' '}
          per run
          {modelLabel ? ` on ${modelLabel}` : ''}.
        </p>
      ) : null}

      {/* `disabledReason` only greys the control here — the Budget section states
          it once at the top. */}
      {on ? (
        <div className="mt-3 space-y-4 rounded-md bg-neutral-50 p-3">
          {/* What the author is budgeting AGAINST, stated before the input — a
              budget of "500,000" means nothing until you know whether the model
              holds 128K or 2 Million. */}
          <div className="space-y-1.5 border-b border-neutral-200 pb-3">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <span className="text-xs text-neutral-500">
                Model token allowance
              </span>
              <span className="text-sm font-medium text-neutral-800">
                {contextLength != null ? (
                  <>
                    {humanTokens(contextLength)}
                    <span className="ml-1.5 font-normal text-neutral-400">
                      per turn{modelLabel ? ` · ${modelLabel}` : ''}
                    </span>
                  </>
                ) : (
                  <span className="font-normal text-neutral-400">
                    Not reported by {modelLabel ?? 'this model'}
                  </span>
                )}
              </span>
            </div>
            {/* The conversion the whole field depends on. Without it "131K per
                turn" and a budget of "328,000" look like they contradict. */}
            {contextLength != null ? (
              <p className="text-xs text-neutral-400">
                That&rsquo;s the ceiling on any <em>single</em> turn. Each turn
                re-sends the whole conversation, so turn 3 pays for turns 1 and
                2 again — your budget below caps that running total, which is
                what you&rsquo;re billed for.
              </p>
            ) : null}
          </div>

          <div className="space-y-2">
            <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
              <div className="space-y-1">
                <span className="block text-xs font-medium text-neutral-600">
                  Spend on tool calls
                </span>
                <Input
                  type="number"
                  min={1000}
                  step={1000}
                  className="max-w-[10rem]"
                  value={budget}
                  onChange={(e) =>
                    onChange(
                      Math.max(
                        1000,
                        Number.parseInt(e.target.value, 10) || 1000,
                      ),
                    )
                  }
                />
              </div>
              {suggestedTokens != null ? (
                // Named for what it's derived FROM, not just the number it sets:
                // the value moves with Max turns, and a bare "Use 5 Million"
                // gives no clue why it changed when the author edited a field in
                // a different section.
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => onChange(suggestedTokens)}
                >
                  Estimate for {maxTurns} {maxTurns === 1 ? 'turn' : 'turns'}:{' '}
                  {humanTokens(suggestedTokens)}
                </Button>
              ) : null}
            </div>

            <p className="text-xs text-neutral-600">
              <span className="text-neutral-400">=</span> stops calling tools at{' '}
              <strong className="text-neutral-800">{fmt(budget)}</strong>{' '}
              tokens, then writes its answer
              {cost != null ? (
                <>
                  {' '}
                  ·{' '}
                  <strong className="text-neutral-800">
                    from {usd(cost)}
                  </strong>{' '}
                  per run
                </>
              ) : null}
            </p>
          </div>

          <div className="space-y-1.5 border-t border-neutral-200 pt-3 text-xs text-neutral-500">
            <p>
              &ldquo;From&rdquo;, not &ldquo;up to&rdquo;: this budget covers
              the research. Writing the answer costs whatever it costs on top,
              so a run always lands somewhat above {fmt(budget)}.
            </p>
            {cost == null ? (
              <p>
                No pricing reported for {modelLabel ?? 'the selected model'}, so
                the cost of this budget can&rsquo;t be estimated.
              </p>
            ) : null}
            {suggestedTokens != null && worstCaseTokens != null ? (
              <p>
                The {humanTokens(suggestedTokens)} estimate assumes the
                conversation grows steadily to fill{' '}
                {humanTokens(contextLength as number)} over your {maxTurns}{' '}
                {maxTurns === 1 ? 'turn' : 'turns'}, averaging half a window per
                turn. Change Max turns and it moves with it. Unbudgeted and
                worst-case, the same {maxTurns}{' '}
                {maxTurns === 1 ? 'turn' : 'turns'} could reach{' '}
                {humanTokens(worstCaseTokens)}
                {worstCaseCost != null ? (
                  <> — about {usd(worstCaseCost)}</>
                ) : null}{' '}
                per run.
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}

/**
 * How much of the model's context window to keep free for writing the answer.
 *
 * Separate from the spend budget on purpose: that one is about money and is a
 * preference, this one is about overflowing the window, which is a hard provider
 * error. It sits outside the budget's on/off because it applies to every agent
 * with a tool loop, budgeted or not.
 *
 * The deliberately-not-offered control is "stop at N% full", which is what this
 * looks like from the outside. The engine can only read a request's size after
 * sending it, so occupancy is always one turn stale, and an N% ceiling silently
 * asks the author to pad for their own tool-result sizes. The engine measures
 * that growth instead — so this field only asks for the part a human can answer:
 * how much room your answers need.
 */
function AnswerReserveField({
  value,
  onChange,
  contextLength,
  modelLabel,
  disabled,
}: {
  value: number
  onChange: (next: number) => void
  contextLength?: number
  modelLabel?: string
  disabled: boolean
}) {
  const { Input } = useWfComponents()
  const reserveTokens =
    contextLength != null ? Math.floor((contextLength * value) / 100) : null

  return (
    <div className="space-y-2">
      <span className="text-foreground block text-sm font-medium">
        Leave room for the answer
      </span>
      <div className="flex items-center gap-1">
        <Input
          type="number"
          min={2}
          max={50}
          className="max-w-[5rem]"
          disabled={disabled}
          value={value}
          onChange={(e) =>
            onChange(
              Math.min(
                50,
                Math.max(2, Number.parseInt(e.target.value, 10) || 10),
              ),
            )
          }
        />
        <span className="text-sm text-neutral-400">
          % of the context window
        </span>
      </div>
      <p className="text-xs text-neutral-400">
        The agent stops calling tools once another turn would leave less than
        this free
        {reserveTokens != null ? (
          <>
            {' '}
            —{' '}
            <strong className="text-neutral-600">
              {fmt(reserveTokens)} tokens
            </strong>{' '}
            of {modelLabel ?? 'this model'}&rsquo;s{' '}
            {humanTokens(contextLength as number)} window
          </>
        ) : null}
        . It measures how much this agent&rsquo;s own tool results grow the
        conversation each turn, so agents with large results stop earlier on
        their own — you don&rsquo;t have to pad this number for them. Raise it
        if answers come out truncated; lower it to let the agent research
        longer.
      </p>
      {contextLength == null ? (
        <p className="text-xs text-amber-600">
          {modelLabel ?? 'This model'} reports no context window, so this guard
          is inactive — nothing stops the conversation from overflowing it.
        </p>
      ) : null}
    </div>
  )
}

export type AgentEditorProps = {
  agentId: string
  className?: string
  onPublished?: (result: { versionId: string; versionNumber: number }) => void
}

export function AgentEditor({
  agentId,
  className,
  onPublished,
}: AgentEditorProps) {
  const query = useAgent(agentId)

  return (
    <QueryState
      query={query}
      loading={
        <div className={cn('p-4 text-sm text-neutral-500', className)}>
          Loading…
        </div>
      }
      error={(error) => (
        <div className={cn('p-4 text-sm text-red-600', className)}>
          {error.message}
        </div>
      )}
      isEmpty={(data) => !(data?.draft?.config ?? data?.currentVersion?.config)}
      empty={
        <div className={cn('p-4 text-sm text-neutral-500', className)}>
          Agent has no configuration yet.
        </div>
      }
    >
      {(data) => {
        const initialConfig = data.draft?.config ?? data.currentVersion?.config
        return initialConfig ? (
          <AgentEditorInner
            agentId={agentId}
            initialConfig={initialConfig}
            initialName={data.agent.name}
            initialDescription={data.agent.description ?? ''}
            initialIcon={data.agent.icon ?? AGENT_ICONS[0].name}
            initialColor={data.agent.color ?? DEFAULT_AGENT_COLOR}
            className={className}
            onPublished={onPublished}
          />
        ) : null
      }}
    </QueryState>
  )
}

type EditorTab = 'editor' | 'calls'

const EDITOR_TABS = [
  { key: 'editor', label: 'Editor' },
  { key: 'calls', label: 'Recent calls' },
]

function AgentEditorInner({
  agentId,
  initialConfig,
  initialName,
  initialDescription,
  initialIcon,
  initialColor,
  className,
  onPublished,
}: {
  agentId: string
  initialConfig: AgentConfig
  initialName: string
  initialDescription: string
  initialIcon: string
  initialColor: string
  className?: string
  onPublished?: (result: { versionId: string; versionNumber: number }) => void
}) {
  const { Button, Label, Input, Checkbox } = useWfComponents()
  const tools = useTools()
  const aiTools = (tools.data ?? []).filter((t) => t.kind === 'ai-tool')

  const [config, setConfig] = useState<AgentConfig>(initialConfig)
  // What the currently-selected model can do. The picker only offers models
  // that meet the agent's needs, so the inverse holds here: if the chosen model
  // is KNOWN to lack a capability, the editor sections that depend on it are
  // disabled. Capabilities are only gated when reported — a model with no
  // capability info (e.g. the pre-refresh static list) is treated as capable.
  const models = useModels()
  const [name, setName] = useState(initialName)
  const [description, setDescription] = useState(initialDescription)
  const [icon, setIcon] = useState(initialIcon)
  const [color, setColor] = useState(initialColor)
  const [savedConfig, setSavedConfig] = useState<AgentConfig>(initialConfig)
  const [savedName, setSavedName] = useState(initialName)
  const [savedDescription, setSavedDescription] = useState(initialDescription)
  const [showPublish, setShowPublish] = useState(false)
  const [showVersions, setShowVersions] = useState(false)
  const [showArchive, setShowArchive] = useState(false)
  // Transient "Published" confirmation shown in place of navigating away.
  const [justPublished, setJustPublished] = useState<number | null>(null)
  // Which half of the page you're on: authoring the agent (config + playground)
  // or inspecting what it has actually been doing.
  const [tab, setTab] = useState<EditorTab>('editor')
  // The call site open in the bottom dock, selected from the Recent calls list.
  // Kept while you flip back to the Editor tab, so returning to the list picks
  // up the investigation where you left it.
  const [inspectedCall, setInspectedCall] = useState<WfAgentCall | null>(null)
  // Set when you load an older configuration back out of a playground run: the
  // edits you had at that moment, parked so the restore is a toggle and not a
  // one-way door. Cleared only by taking them back, which is why restoring a
  // second run doesn't overwrite them — they're still the newest thing you wrote.
  const [latestEdits, setLatestEdits] = useState<AgentConfig | null>(null)

  const saveDraft = useSaveAgentDraft()
  const publish = usePublishAgent()
  const versions = useAgentVersions(agentId)
  const updateMeta = useUpdateAgentMeta()
  const { navigate } = useWfNav()
  const client = useWfClient()

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
      agentName: name,
      agentDescription: description,
      instructions: config.prompt,
      toolNames: config.toolIds.map(
        (id) => aiTools.find((t) => t.id === id)?.name ?? id,
      ),
    }),
    [name, description, config.prompt, config.toolIds, aiTools],
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
  const budgetIrrelevantReason = !hasToolsOrSubAgents
    ? 'This agent has no tools or sub-agents, so it answers in a single turn — there is no loop to bound or spend against. Attach a tool or sub-agent to set turns and a budget.'
    : config.output.kind !== 'text'
      ? 'Only Text agents run a tool loop — a structured result is generated in one pass, so there is nothing to budget.'
      : null

  // Such an agent's effective turn count IS 1, regardless of what an older
  // config stored. Show the truth rather than a stale 5 that does nothing.
  const effectiveMaxTurns = hasToolsOrSubAgents ? config.maxTurns : 1

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

  // Model facts the budget field reasons about. Both are optional — a provider
  // that reports neither leaves the field usable but unpriced, never blocked.
  const contextLength = selectedModel?.contextLength
  const costPerMTok = selectedModel?.costPerMTok

  // Both numbers below turn the model's PER-TURN window into a CUMULATIVE spend,
  // which is the conversion the whole field hinges on and the one an author has
  // no reason to already know. A tool loop re-sends the entire conversation every
  // turn, so turn 3 pays for turns 1 and 2 again; `contextLength` caps any single
  // turn, while the running total is what gets billed.
  //
  //   worstCase — every turn already full: maxTurns × window. A true ceiling,
  //               reached only by a loop that starts at the window and stays there.
  //   estimate  — the conversation grows roughly linearly from near-zero to full
  //               over maxTurns, so the average turn is half a window and the sum
  //               is the trapezoid: maxTurns × window ÷ 2.
  //
  // Both scale with maxTurns because spend genuinely does: allowing 10 turns
  // instead of 5 really is about twice the tokens.
  const worstCaseTokens =
    contextLength != null ? effectiveMaxTurns * contextLength : null
  const suggestedTokens =
    worstCaseTokens != null
      ? Math.max(1000, Math.round(worstCaseTokens / 2 / 1000) * 1000)
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

  // Turns are cheap to raise and expensive to run. The node's in-process budget
  // is ~17 min by default (a 20 min step timeout less 3 min of slack), and an
  // agent that blows through it fails FATALLY — no retry — so the warning is
  // about the thing that actually bites, not about the turn count itself.
  const secondsPerTurn = Math.floor((17 * 60) / config.maxTurns)
  const turnsWarning =
    config.maxTurns > 20
      ? `${config.maxTurns} turns leaves about ${secondsPerTurn}s per turn against the default ~17 min node budget. Overrunning it fails the run outright with no retry — raise the node's timeout, or set a token budget below so the agent answers early instead of dying.`
      : null

  const dirty = JSON.stringify(config) !== JSON.stringify(savedConfig)
  const saveError =
    (saveDraft.error as Error | null)?.message ??
    (publish.error as Error | null)?.message ??
    null

  function patch(next: Partial<AgentConfig>) {
    setConfig((c) => ({ ...c, ...next }))
  }

  // Every other control is driven by `config`, but both prompt bodies are TipTap
  // documents seeded once from `initialBody` — so a restore has to push the new
  // text into them imperatively or the editors would keep showing the old text
  // while `config` held the restored one.
  const setPromptBody = useRef<((body: string) => void) | null>(null)
  const registerSetBody = useCallback((set: (body: string) => void) => {
    setPromptBody.current = set
  }, [])
  const setUserPromptBody = useRef<((body: string) => void) | null>(null)
  const registerSetUserPrompt = useCallback((set: (body: string) => void) => {
    setUserPromptBody.current = set
  }, [])

  function loadConfig(next: AgentConfig) {
    setConfig(next)
    setPromptBody.current?.(next.prompt)
    setUserPromptBody.current?.(next.userPrompt)
  }

  /** Take a playground run's frozen config, parking the current edits. */
  function restoreConfig(next: AgentConfig) {
    setLatestEdits((parked) => parked ?? config)
    loadConfig(next)
  }

  /** Go back to the edits parked by the first restore. */
  function returnToLatestEdits() {
    if (!latestEdits) return
    loadConfig(latestEdits)
    setLatestEdits(null)
  }

  function commitRename() {
    const trimmed = name.trim()
    if (!trimmed || trimmed === savedName) {
      setName(savedName)
      return
    }
    setName(trimmed)
    setSavedName(trimmed)
    updateMeta.mutate({ agentId, name: trimmed })
  }

  // Description is entity metadata (not versioned) — commit on blur, like the
  // name. Empty is allowed, so no restore-on-empty guard.
  function commitDescription() {
    const trimmed = description.trim()
    if (trimmed === savedDescription) {
      setDescription(savedDescription)
      return
    }
    setDescription(trimmed)
    setSavedDescription(trimmed)
    updateMeta.mutate({ agentId, description: trimmed })
  }

  // Appearance saves immediately (it's entity metadata, not versioned) — the
  // header's `AppearancePicker` calls straight into these.
  function selectIcon(next: string) {
    setIcon(next)
    updateMeta.mutate({ agentId, icon: next })
  }
  function selectColor(next: string) {
    setColor(next)
    updateMeta.mutate({ agentId, color: next })
  }

  function onSaveDraft() {
    saveDraft.mutate(
      { agentId, config },
      { onSuccess: () => setSavedConfig(config) },
    )
  }

  // Load a published version back into the editor as an unsaved edit. Nothing is
  // published and the live version doesn't move — the author reviews it and, if
  // they want it back, publishes it as a NEW version on top. History is never
  // rewritten. (The workflow editor parks this in its undo stack; the agent
  // editor has none, so the dirty check below is what makes it recoverable.)
  async function loadVersion(versionId: string) {
    const v = await client.getAgentVersion(versionId)
    setShowVersions(false)
    if (!v) return
    setConfig(v.config)
  }

  function onPublish({
    changeNote,
    aiSummary,
  }: {
    changeNote: string
    aiSummary: { short: string; long: string } | null
  }) {
    publish.mutate(
      {
        agentId,
        config,
        changeNote: changeNote.trim() || undefined,
        aiSummary: aiSummary ?? undefined,
      },
      {
        onSuccess: (result) => {
          setSavedConfig(config)
          setShowPublish(false)
          setJustPublished(result.versionNumber)
          onPublished?.(result)
        },
      },
    )
  }

  // Auto-dismiss the "Published" confirmation after a few seconds.
  useEffect(() => {
    if (justPublished == null) return
    const timer = setTimeout(() => setJustPublished(null), 4000)
    return () => clearTimeout(timer)
  }, [justPublished])

  return (
    <>
      <WfShell
        className={className}
        // Not `scroll`: the page owns its own scroll region so the call dock can
        // stay pinned to the bottom instead of riding down with the content.
        titleIcon={
          <AppearancePicker
            icon={icon}
            color={color}
            onSelectIcon={selectIcon}
            onSelectColor={selectColor}
            label="Agent appearance"
          />
        }
        assetLabel="Agent"
        crumbs={[
          {
            editable: {
              value: name,
              onChange: setName,
              onCommit: commitRename,
              ariaLabel: 'Agent name',
            },
          },
        ]}
        descriptionEditable={{
          value: description,
          onChange: setDescription,
          onCommit: commitDescription,
          ariaLabel: 'Agent description',
          placeholder: 'Add a description…',
        }}
        actions={
          <>
            <SaveStateBadge
              dirty={dirty}
              dirtyTooltip="You have unsaved changes"
              savedTooltip="All configuration changes saved"
            />
            {justPublished != null ? (
              <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600">
                <Check className="size-3.5" />
                Published v{justPublished}
              </span>
            ) : null}
            {saveError ? (
              <span className="text-xs text-red-600">{saveError}</span>
            ) : null}
            {latestEdits ? (
              <Tooltip
                content="You're on a configuration restored from a playground run — go back to the edits you had before restoring."
                side="bottom"
              >
                <Button
                  variant="outline"
                  size="sm"
                  onClick={returnToLatestEdits}
                >
                  <History className="mr-1.5 size-3.5" />
                  Latest changes
                </Button>
              </Tooltip>
            ) : null}
            <Tooltip content="Archive" side="bottom">
              <button
                type="button"
                aria-label="Archive"
                onClick={() => setShowArchive(true)}
                className="inline-flex size-8 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-800"
              >
                <Archive className="size-4" />
              </button>
            </Tooltip>
            <VersionsMenu
              open={showVersions}
              onToggle={() => setShowVersions((v) => !v)}
              versions={versions.data}
              onSelect={(id) => void loadVersion(id)}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={onSaveDraft}
              disabled={saveDraft.isPending}
            >
              {saveDraft.isPending ? 'Saving…' : 'Save draft'}
            </Button>
            <Button
              size="sm"
              onClick={() => setShowPublish(true)}
              disabled={publish.isPending}
            >
              Publish
            </Button>
          </>
        }
      >
        {/* Full-bleed, in bands — the first three scroll together, the dock is
            pinned under them:
              1. the agent's key metrics — averages over its real calls, which is
                 what you're tuning against, so they stay visible on both tabs;
              2. the tabs;
              3. the pane. Editor = configuration alongside the playground, an
                 even split so neither is the cramped one; Recent calls = the
                 call rows with the whole page width to spread into.
            The Editor pane stays MOUNTED while Recent calls is showing — the
            prompt editor seeds itself from `initialConfig` and the playground
            holds its last result, so unmounting would silently throw both
            away. */}
        <div className="flex h-full min-h-0 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="w-full space-y-6 p-6">
              <AgentCallMetrics agentId={agentId} />

              <Tabs
                active={tab}
                onChange={(k) => setTab(k as EditorTab)}
                tabs={EDITOR_TABS}
              />

              {tab === 'calls' ? (
                <AgentCallsList
                  agentId={agentId}
                  selectedKey={inspectedCall ? callKey(inspectedCall) : null}
                  onSelect={setInspectedCall}
                />
              ) : null}

              <div
                className={cn(
                  'grid grid-cols-1 gap-6 lg:grid-cols-2',
                  tab !== 'editor' && 'hidden',
                )}
              >
                {/* Left: configuration */}
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

                  {/* Prompt */}
                  <EditorSection
                    icon={MessageSquareText}
                    title="Prompt"
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

                  {/* Budget — every ceiling on how much work one call may do: rounds,
                tokens, and the room kept back for the answer. Turns belong here
                rather than under Tools because a round may be spent on a
                sub-agent as easily as a tool, and all three trade against each
                other — raising turns raises what the budget has to cover. */}
                  {/* With nothing to call there are no inner turns to bound or pay
                  for — the agent answers in one pass — so the whole section is
                  inert. Its fields are already read-only in that shape; folding
                  it (and badging why) keeps the author from tuning numbers that
                  can't do anything. Opening it still shows the reason. */}
                  <EditorSection
                    icon={Wallet}
                    title="Budget"
                    collapsible
                    defaultCollapsed={!!budgetIrrelevantReason}
                    badge={
                      budgetIrrelevantReason ? 'Not applicable' : undefined
                    }
                    description="How much work the agent may do, and what it may spend, before it has to answer."
                  >
                    {budgetIrrelevantReason ? (
                      <p className="rounded-md bg-neutral-50 p-3 text-xs text-neutral-500">
                        {budgetIrrelevantReason}
                      </p>
                    ) : null}

                    <div className="space-y-2">
                      <Label>Max turns</Label>
                      <Input
                        type="number"
                        min={1}
                        max={100}
                        className="max-w-[8rem]"
                        disabled={!!budgetIrrelevantReason}
                        value={effectiveMaxTurns}
                        onChange={(e) =>
                          patch({
                            // Clamp here rather than relying on the `max` attribute,
                            // which doesn't stop a typed value — an out-of-range number
                            // reaches the server and fails as a raw schema error.
                            maxTurns: Math.min(
                              100,
                              Math.max(
                                1,
                                Number.parseInt(e.target.value, 10) || 1,
                              ),
                            ),
                          })
                        }
                      />
                      <p className="text-xs text-neutral-400">
                        How many turns the agent may take before it must give a
                        final answer. Each turn is one round of calling tools or
                        spawning sub-agents and reading the results; a higher
                        limit lets the agent do more work but costs more and
                        runs longer. Defaults to 5.
                      </p>
                      {turnsWarning && !budgetIrrelevantReason ? (
                        <p className="text-xs text-amber-600">
                          ⚠ {turnsWarning}
                        </p>
                      ) : null}
                    </div>

                    <div className="border-t border-neutral-200 pt-4">
                      <TokenBudgetField
                        value={config.toolTokenBudget}
                        onChange={(toolTokenBudget) =>
                          patch({ toolTokenBudget })
                        }
                        maxTurns={effectiveMaxTurns}
                        modelLabel={selectedModel?.label}
                        contextLength={contextLength}
                        costPerMTok={costPerMTok}
                        suggestedTokens={suggestedTokens}
                        worstCaseTokens={worstCaseTokens}
                        disabledReason={budgetIrrelevantReason}
                      />
                    </div>

                    {/* Outside the budget's on/off: an unbudgeted agent can still
                  overflow the window, so this applies either way. */}
                    <div className="border-t border-neutral-200 pt-4">
                      <AnswerReserveField
                        value={config.answerReservePercent}
                        onChange={(answerReservePercent) =>
                          patch({ answerReservePercent })
                        }
                        contextLength={contextLength}
                        modelLabel={selectedModel?.label}
                        disabled={!!budgetIrrelevantReason}
                      />
                    </div>
                  </EditorSection>

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

                {/* Right: the evidence. Neither of these is a setting, so both
                stay out of the configuration column — and at half the page the
                playground finally has room for a real transcript.

                Evals sit above the playground because they are the stronger of
                the two answers to "did my edit work?": the playground shows one
                answer to one input you just made up, while a goal grades every
                sample you have written checks for. Both run the same unsaved
                draft, so neither asks you to publish to find out. */}
                <div className="space-y-6">
                  <AgentEvalsPanel
                    agentId={agentId}
                    agentName={name}
                    config={config}
                    onRestore={restoreConfig}
                  />
                  <PlaygroundPanel config={config} onRestore={restoreConfig} />
                </div>
              </div>
            </div>
          </div>
          {/* Band 4, and only while a call is selected: that call site's steps,
              in the same dock the workflow editor and run viewer use. Reading
              what the agent DID stays on this page, so the prompt above (and
              the playground's last result) survive the trip. */}
          {tab === 'calls' && inspectedCall ? (
            <AgentCallInspect
              call={inspectedCall}
              onClose={() => setInspectedCall(null)}
            />
          ) : null}
        </div>
      </WfShell>

      {showPublish ? (
        <PublishAgentDialog
          agentId={agentId}
          config={config}
          publishing={publish.isPending}
          error={(publish.error as Error | null)?.message ?? null}
          onCancel={() => setShowPublish(false)}
          onConfirm={onPublish}
        />
      ) : null}

      {showArchive ? (
        <ArchiveAgentDialog
          agentId={agentId}
          agentName={name}
          onClose={() => setShowArchive(false)}
          onArchived={() => {
            setShowArchive(false)
            navigate('agents')
          }}
        />
      ) : null}
    </>
  )
}
