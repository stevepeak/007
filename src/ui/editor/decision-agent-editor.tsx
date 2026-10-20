import { AlertTriangle, Plus, X } from 'lucide-react'
import { useMemo } from 'react'

import {
  decisionAgentConfigIssues,
  type DecisionAgentConfig,
  type DecisionRule,
} from '../../engine'
import { cn } from '../cn'
import { useWfComponents } from '../context'
import { useDecisionModels, useDecisionProviders } from '../hooks-models'
import { Tooltip } from '../tooltip'

import { AgentEditorChrome } from './agent-editor-chrome'
import { DecisionPlaygroundPanel } from './decision-agent-playground'
import { DecisionQuestionList } from './decision-agent-questions'
import { DecisionRulesEditor } from './decision-agent-rules'
import { GuardedIconButton, ruleCount } from './decision-question-types'
import { groupModelsByProvider } from './model-grouping'
import { useAgentMeta } from './use-agent-editor-state'
import { useDecisionAgentDraft } from './use-decision-agent-editor-state'

// The DECISION agent editor — a question list and a rules table, not a prompt
// editor.
//
// A separate page from `AgentEditor` rather than a mode inside it, for the same
// reason the configs are separate types: the two share `AgentEditorChrome` —
// the shell, the appearance picker, the header actions and the publish and
// archive dialogs — and nothing else. Every control on the generation editor —
// model from the chat catalog, system prompt, user message, tools, turns,
// output contract, sub-agents, token budget — has no counterpart here, and
// every control here has none there.
//
// The layout mirrors the generation editor's, so an author moving between them
// knows where things are: configuration on the left, evidence on the right.

export function DecisionAgentEditorInner({
  agentId,
  initialConfig,
  initialBaseVersionNumber,
  initialName,
  initialDescription,
  initialIcon,
  initialColor,
  className,
  onPublished,
}: {
  agentId: string
  initialConfig: DecisionAgentConfig
  initialBaseVersionNumber: number
  initialName: string
  initialDescription: string
  initialIcon: string
  initialColor: string
  className?: string
  onPublished?: (result: { versionId: string; versionNumber: number }) => void
}) {
  const { Label } = useWfComponents()
  const meta = useAgentMeta({
    agentId,
    initialName,
    initialDescription,
    initialIcon,
    initialColor,
  })
  const draft = useDecisionAgentDraft({
    agentId,
    initialConfig,
    initialBaseVersionNumber,
    onPublished,
  })

  const models = useDecisionModels()
  const providers = useDecisionProviders()
  const config = draft.config
  const chosen = (models.data ?? []).find((m) => m.id === config.modelId)

  // Everything wrong with the config right now, as sentences. A half-written
  // matrix still saves as a draft, so the schema accepts it; these gate
  // PUBLISH instead, because a rule that cannot hold evaluates false at run time
  // and silently falls through to the fallback.
  const issues = useMemo(
    () => decisionAgentConfigIssues(config),
    [config],
  )

  return (
    <AgentEditorChrome
      agentId={agentId}
      meta={meta}
      draft={draft}
      assetLabel="Decision agent"
      publishBlockedReason={
        issues.length > 0
          ? `Fix ${issues.length === 1 ? 'the issue' : `the ${issues.length} issues`} in the Issues panel before publishing.`
          : undefined
      }
      // No AI summary for a decision agent: the summarizer's prompt is written
      // around a system prompt, tools and an output contract, and the server
      // refuses rather than describing fields that aren't there.
      summarize={false}
      className={className}
    >
      <div className="w-full space-y-6 p-6">
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div className="space-y-6">
            <section className="space-y-2 rounded-lg border border-neutral-200 bg-white p-4">
              <Label>Judge with</Label>
              <select
                className={cn(
                  'border-input bg-card text-foreground h-9 w-full rounded-md border px-2 text-sm outline-none focus:border-ring',
                  !config.modelId && 'border-destructive',
                )}
                value={config.modelId}
                aria-label="Decision model"
                onChange={(e) => draft.patch({ modelId: e.target.value })}
              >
                {/* A prompt, not a choice: `modelId` cannot be blank, so once a
                    model is picked the placeholder is no longer selectable. */}
                <option value="" disabled={config.modelId !== ''}>
                  Pick a decision model…
                </option>
                {groupModelsByProvider(
                  models.data ?? [],
                  providers.data ?? [],
                ).map(({ provider, models: groupModels }) => (
                  <optgroup key={provider.id} label={provider.label}>
                    {groupModels.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                        {provider.kind === 'chat-emulated'
                          ? ' (emulated)'
                          : ''}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              {(models.data ?? []).length === 0 && !models.isLoading ? (
                <p className="text-xs text-neutral-500">
                  No decision provider is wired up in this deployment, so this
                  agent cannot run. See <code>WfSdkConfig.getDecider</code>.
                </p>
              ) : chosen && chosen.calibrated === false ? (
                <p className="text-xs text-neutral-500">
                  This decider emulates judgments on a chat model. Its
                  probabilities are the model’s own estimate rather than a
                  calibrated distribution — treat every threshold below as
                  rough.
                </p>
              ) : null}
            </section>

            <section className="space-y-2 rounded-lg border border-neutral-200 bg-white p-4">
              <Label>Questions</Label>
              <DecisionQuestionList
                questions={config.questions}
                rules={config.rules}
                model={chosen}
                onChange={(patch) => draft.patch(patch)}
              />
            </section>

            <section className="space-y-2 rounded-lg border border-neutral-200 bg-white p-4">
              {/* The rename hazard rides on the heading, same as a question's
                  name: an icon that stays visible without an amber block
                  shouting at an author who is only adding a verdict. A verdict
                  is what a Goal ASSERTS on, so renaming one is the version of
                  this cascade with the most reach. */}
              <div className="flex items-center gap-1.5">
                <Label>Verdicts</Label>
                {config.rules.length > 0 ? (
                  <Tooltip
                    side="right"
                    content={
                      <>
                        Renaming a verdict re-points the rules that return it,
                        here. It does <b>not</b> update eval samples: a Goal
                        expecting the old name will quietly stop matching. Fix
                        those by hand.
                      </>
                    }
                  >
                    <AlertTriangle
                      className="size-3 shrink-0 text-amber-600"
                      aria-label="Renaming a verdict updates the rules here but not eval samples"
                    />
                  </Tooltip>
                ) : null}
              </div>
              {/* The explanation goes ABOVE the list. Underneath, it was
                  read after the author had already guessed wrong about what
                  a verdict is — the guess being that it is a second kind of
                  question rather than the agent's answer. */}
              <p className="text-muted-foreground text-xs">
                The complete set of answers this agent can give. Every run
                returns exactly one of them as its{' '}
                <code className="text-foreground">verdict</code> — the value
                a Goal grades and a caller branches on. The questions above
                gather evidence; the rules below turn that evidence into one
                of these names.
              </p>
              <VerdictsEditor
                verdicts={config.verdicts}
                rules={config.rules}
                onChange={(patch) => draft.patch(patch)}
              />
            </section>

            <section className="space-y-2 rounded-lg border border-neutral-200 bg-white p-4">
              <Label>Rules</Label>
              <DecisionRulesEditor
                rules={config.rules}
                questions={config.questions}
                verdicts={config.verdicts}
                onChange={(rules) => draft.patch({ rules })}
              />
            </section>
          </div>

          <div className="space-y-6">
            {issues.length > 0 ? (
              <section className="space-y-1.5 rounded-lg border border-amber-200 bg-amber-50 p-4">
                <h2 className="flex items-center gap-1.5 text-sm font-medium text-amber-900">
                  <AlertTriangle className="size-4" />
                  Issues
                </h2>
                <ul className="space-y-1 text-xs text-amber-800">
                  {issues.map((issue, i) => (
                    <li key={i}>{issue}</li>
                  ))}
                </ul>
              </section>
            ) : null}
            <DecisionPlaygroundPanel config={config} />
          </div>
        </div>
      </div>
    </AgentEditorChrome>
  )
}

/**
 * The declared outcome set.
 *
 * Declared explicitly rather than derived from the rules, so a typo in a rule's
 * verdict is an error instead of a silent new outcome — and so a consumer
 * (today an eval expectation, tomorrow a Switch) can enumerate the cases before
 * a single rule has been written.
 *
 * Which is exactly what made it confusing: a list of bare text boxes, above the
 * rules that give them meaning, looks like more questions. So each row now says
 * what it costs — how many rules return it, or that nothing does yet — and a
 * rename follows into those rules instead of breaking them.
 */
function VerdictsEditor({
  verdicts,
  rules,
  onChange,
}: {
  verdicts: string[]
  rules: DecisionRule[]
  onChange: (patch: { verdicts: string[]; rules?: DecisionRule[] }) => void
}) {
  const rename = (index: number, to: string) => {
    // By index, never by value: two rows can hold the same text — both are
    // blank the moment you add a second one — and renaming by value would
    // edit them together.
    const from = verdicts[index] ?? ''
    // Typing in this box IS renaming the outcome, and every rule naming it
    // means the same outcome — so they travel together. Without this, an
    // author correcting a spelling would silently unpoint every rule that
    // returned it and get a validation error about a name they just fixed.
    // Skipped when the old name is blank or shared, where "the rules that
    // meant THIS row" is not answerable.
    const cascade =
      from !== '' && verdicts.filter((v) => v === from).length === 1
    onChange({
      verdicts: verdicts.map((v, j) => (j === index ? to : v)),
      rules: cascade
        ? rules.map((r) => (r.verdict === from ? { ...r, verdict: to } : r))
        : rules,
    })
  }
  /**
   * Applied on blur/Enter, not per keystroke: mid-word, the name passes through
   * blanks and through other verdicts' names, and the rules following it there
   * would detach (blank) or merge into the other outcome (a match). A finished
   * name that would do either, while rules return this verdict, is refused.
   */
  const commit = (index: number, input: HTMLInputElement) => {
    const from = verdicts[index] ?? ''
    const to = input.value.trim()
    if (to === from) return
    const returned = rules.some((r) => r.verdict === from)
    const taken = verdicts.some((v, j) => j !== index && v === to)
    if (from !== '' && returned && (to === '' || taken)) {
      input.value = from
      return
    }
    rename(index, to)
  }
  return (
    <div className="space-y-1.5">
      {verdicts.map((verdict, i) => {
        const returnedBy = rules.filter((r) => r.verdict === verdict).length
        const duplicate =
          verdict.trim() !== '' && verdicts.indexOf(verdict) !== i
        return (
          <div key={i} className="flex items-center gap-2">
            <input
              className={cn(
                'border-input bg-card text-foreground h-8 min-w-0 flex-1 rounded-md border px-2 font-mono text-xs outline-none focus:border-ring',
                (duplicate || !verdict.trim()) && 'border-destructive',
              )}
              aria-label={`Verdict ${i + 1}`}
              placeholder="escalate — name one possible answer"
              defaultValue={verdict}
              key={verdict}
              onBlur={(e) => commit(i, e.currentTarget)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
                if (e.key === 'Escape') {
                  e.currentTarget.value = verdict
                  e.currentTarget.blur()
                }
              }}
            />
            {/* The consequence of the row, stated on the row. An outcome no
                rule returns is dead weight an eval can never produce, and an
                author cannot see that by looking at either list alone. */}
            <span
              className={cn(
                'shrink-0 text-right text-[11px]',
                returnedBy === 0
                  ? 'text-amber-700'
                  : 'text-muted-foreground',
              )}
            >
              {duplicate
                ? 'duplicate name'
                : returnedBy === 0
                  ? 'no rule returns this'
                  : `returned by ${returnedBy} ${returnedBy === 1 ? 'rule' : 'rules'}`}
            </span>
            <GuardedIconButton
              label={`Remove verdict ${verdict}`}
              blockedReason={
                returnedBy > 0 && !duplicate
                  ? `${ruleCount(returnedBy)} return ${verdict} — point them at another verdict first.`
                  : undefined
              }
              onClick={() => onChange({ verdicts: verdicts.filter((_, j) => j !== i) })}
            >
              <X className="size-3" />
            </GuardedIconButton>
          </div>
        )
      })}
      <button
        type="button"
        className="border-input hover:bg-accent text-muted-foreground hover:text-foreground flex w-full items-center justify-center gap-1 rounded-md border border-dashed py-1.5 text-xs"
        onClick={() => onChange({ verdicts: [...verdicts, ''] })}
      >
        <Plus className="size-3" /> Add a verdict
      </button>
    </div>
  )
}
