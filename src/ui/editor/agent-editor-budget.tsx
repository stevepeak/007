import { Wallet } from 'lucide-react'

import type { AgentConfig } from '../../engine'
import { cn } from '../cn'
import { useWfComponents } from '../context'

import { EditorSection } from './editor-section'
import { fmt, humanTokens, usd } from './format-tokens'

// The agent editor's "Tool Calling Budget" section: every ceiling on how much
// work one call may do, plus the token arithmetic that turns those ceilings into
// numbers an author can reason about.
//
// It sits apart from the rest of the configuration panel because it is the only
// section with real derivation behind it — the rest are controls bound straight
// to a config field. Its two numeric fields are separate components below for
// the same reason they were separate before: what is hard about them is the COPY
// (what a budget does and does not cap, why an occupancy percentage is
// deliberately not offered), which is long doc comments over short bodies.

export function AgentBudgetSection({
  config,
  patch,
  hasToolsOrSubAgents,
  modelLabel,
  contextLength,
  costPerMTok,
}: {
  config: AgentConfig
  patch: (next: Partial<AgentConfig>) => void
  /** Whether there is a tool loop at all — see the `budgetIrrelevantReason` below. */
  hasToolsOrSubAgents: boolean
  /** Model facts, all optional: a provider reporting none leaves the fields usable but unpriced. */
  modelLabel?: string
  contextLength?: number
  costPerMTok?: number
}) {
  const { Label, Input } = useWfComponents()
  const budgetIrrelevantReason = !hasToolsOrSubAgents
    ? 'This agent has no tools or sub-agents, so it answers in a single turn — there is no loop to bound or spend against. Attach a tool or sub-agent to set turns and a budget.'
    : config.output.kind !== 'text'
      ? 'Only Text agents run a tool loop — a structured result is generated in one pass, so there is nothing to budget.'
      : null

  // Such an agent's effective turn count IS 1, regardless of what an older
  // config stored. Show the truth rather than a stale 5 that does nothing.
  const effectiveMaxTurns = hasToolsOrSubAgents ? config.maxTurns : 1

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

  // Turns are cheap to raise and expensive to run. The node's in-process budget
  // is ~17 min by default (a 20 min step timeout less 3 min of slack), and an
  // agent that blows through it fails FATALLY — no retry — so the warning is
  // about the thing that actually bites, not about the turn count itself.
  const secondsPerTurn = Math.floor((17 * 60) / config.maxTurns)
  const turnsWarning =
    config.maxTurns > 20
      ? `${config.maxTurns} turns leaves about ${secondsPerTurn}s per turn against the default ~17 min node budget. Overrunning it fails the run outright with no retry — raise the node's timeout, or set a token budget below so the agent answers early instead of dying.`
      : null

  // Every ceiling on how much work one call may do: rounds, tokens, and the room
  // kept back for the answer. Turns belong here rather than under Tools because a
  // round may be spent on a sub-agent as easily as a tool, and all three trade
  // against each other — raising turns raises what the budget has to cover.
  //
  // With nothing to call there are no inner turns to bound or pay for — the agent
  // answers in one pass — so the whole section is inert. Its fields are already
  // read-only in that shape; folding it (and badging why) keeps the author from
  // tuning numbers that can't do anything. Opening it still shows the reason.
  return (
    <EditorSection
      icon={Wallet}
      title="Tool Calling Budget"
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
          modelLabel={modelLabel}
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
          modelLabel={modelLabel}
          disabled={!!budgetIrrelevantReason}
        />
      </div>
    </EditorSection>
  )
}

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
export function TokenBudgetField({
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
  const { Checkbox } = useWfComponents()
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
        <BudgetDetail
          budget={budget}
          onChange={onChange}
          maxTurns={maxTurns}
          modelLabel={modelLabel}
          contextLength={contextLength}
          cost={cost}
          suggestedTokens={suggestedTokens}
          worstCaseTokens={worstCaseTokens}
          worstCaseCost={worstCaseCost}
        />
      ) : null}
    </div>
  )
}

/**
 * The expanded budget panel — only rendered once a budget is ON.
 *
 * Mostly copy, deliberately. A token budget is the one field in the editor
 * whose number means nothing without three things stated alongside it: what the
 * model's per-turn window is, that each turn re-sends the whole conversation
 * (so the running total is what gets billed), and that the budget bounds the
 * RESEARCH only — the answer costs whatever it costs on top. An author who
 * types "500,000" without those three facts has not made a decision.
 */
function BudgetDetail({
  budget,
  onChange,
  maxTurns,
  modelLabel,
  contextLength,
  cost,
  suggestedTokens,
  worstCaseTokens,
  worstCaseCost,
}: {
  budget: number
  onChange: (next: number | null) => void
  maxTurns: number
  modelLabel?: string
  contextLength?: number
  /** Cost of the chosen budget, or null when the model reports no pricing. */
  cost: number | null
  suggestedTokens: number | null
  worstCaseTokens: number | null
  worstCaseCost: number | null
}) {
  const { Input, Button } = useWfComponents()
  return (
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
export function AnswerReserveField({
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
