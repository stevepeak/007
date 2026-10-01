import { AlertTriangle, Plus, X } from 'lucide-react'
import { useMemo, useState } from 'react'

import {
  decisionAgentConfigIssues,
  type DecisionAgentConfig,
  type DecisionRule,
} from '../../engine'
import { AGENT_ICONS, DEFAULT_AGENT_COLOR } from '../agent-appearance'
import { AppearancePicker } from '../appearance-picker'
import { cn } from '../cn'
import { useWfComponents } from '../context'
import { useDecisionModels, useDecisionProviders } from '../hooks-models'
import { useWfNav } from '../nav'
import { WfShell } from '../shell'
import { Tooltip } from '../tooltip'

import { ArchiveAgentDialog } from './agent-editor-archive'
import { AgentEditorHeaderActions } from './agent-editor-header-actions'
import { PublishAgentDialog } from './agent-editor-publish'
import { DecisionPlaygroundPanel } from './decision-agent-playground'
import { DecisionQuestionList } from './decision-agent-questions'
import { DecisionRulesEditor } from './decision-agent-rules'
import { useAgentMeta } from './use-agent-editor-state'
import { useDecisionAgentDraft } from './use-decision-agent-editor-state'

// The DECISION agent editor — a question list and a rules table, not a prompt
// editor.
//
// A separate page from `AgentEditor` rather than a mode inside it, for the same
// reason the configs are separate types: the two share the shell, the
// appearance picker, the header actions and the publish dialog, and share
// nothing else. Every control on the generation editor — model from the chat
// catalog, system prompt, user message, tools, turns, output contract,
// sub-agents, token budget — has no counterpart here, and every control here
// has none there.
//
// The layout mirrors the generation editor's, so an author moving between them
// knows where things are: configuration on the left, evidence on the right.

export function DecisionAgentEditorInner({
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
  initialConfig: DecisionAgentConfig
  initialName: string
  initialDescription: string
  initialIcon: string
  initialColor: string
  className?: string
  onPublished?: (result: { versionId: string; versionNumber: number }) => void
}) {
  const { navigate } = useWfNav()
  const { Label } = useWfComponents()
  const meta = useAgentMeta({
    agentId,
    initialName,
    initialDescription,
    initialIcon: initialIcon || AGENT_ICONS[0].name,
    initialColor: initialColor || DEFAULT_AGENT_COLOR,
  })
  const draft = useDecisionAgentDraft({ agentId, initialConfig, onPublished })
  const [showArchive, setShowArchive] = useState(false)

  const models = useDecisionModels()
  const providers = useDecisionProviders()
  const config = draft.config
  const chosen = (models.data ?? []).find((m) => m.id === config.modelId)

  // Everything wrong with the config right now, as sentences. Shown rather than
  // enforced: a half-written matrix has to save as a draft, so the schema
  // accepts it and this is what says it would not yet run.
  const issues = useMemo(
    () => decisionAgentConfigIssues(config),
    [config],
  )

  return (
    <>
      <WfShell
        className={className}
        titleIcon={
          <AppearancePicker
            icon={meta.icon}
            color={meta.color}
            onSelectIcon={meta.selectIcon}
            onSelectColor={meta.selectColor}
            label="Agent appearance"
          />
        }
        assetLabel="Decision agent"
        crumbs={[
          {
            editable: {
              value: meta.name,
              onChange: meta.setName,
              onCommit: meta.commitRename,
              ariaLabel: 'Agent name',
            },
          },
        ]}
        descriptionEditable={{
          value: meta.description,
          onChange: meta.setDescription,
          onCommit: meta.commitDescription,
          ariaLabel: 'Agent description',
          placeholder: 'Add a description…',
        }}
        actions={
          <AgentEditorHeaderActions
            draft={draft}
            onArchive={() => setShowArchive(true)}
          />
        }
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
                  <option value="">Pick a decision model…</option>
                  {groupByProvider(
                    models.data ?? [],
                    providers.data ?? [],
                  ).map(({ label, kind, items }) => (
                    <optgroup key={label} label={label}>
                      {items.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                          {kind === 'chat-emulated' ? ' (emulated)' : ''}
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
      </WfShell>

      {draft.showPublish ? (
        <PublishAgentDialog
          agentId={agentId}
          config={config}
          // No AI summary for a decision agent: the summarizer's prompt is
          // written around a system prompt, tools and an output contract, and
          // the server refuses rather than describing fields that aren't there.
          summarize={false}
          publishing={draft.publishing}
          error={draft.publishError}
          onCancel={() => draft.setShowPublish(false)}
          onConfirm={draft.onPublish}
        />
      ) : null}

      {showArchive ? (
        <ArchiveAgentDialog
          agentId={agentId}
          agentName={meta.name}
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
              value={verdict}
              onChange={(e) => rename(i, e.target.value)}
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
            <button
              type="button"
              aria-label={`Remove verdict ${verdict}`}
              className="text-muted-foreground hover:text-foreground hover:bg-accent shrink-0 rounded p-1"
              onClick={() => onChange({ verdicts: verdicts.filter((_, j) => j !== i) })}
            >
              <X className="size-3" />
            </button>
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

/**
 * Models under their provider headings, with anything whose provider the host
 * no longer declares gathered under "Other" — dropping those silently would
 * leave a saved agent pointing at a model that has vanished from its own
 * picker.
 */
function groupByProvider(
  models: readonly { id: string; label: string; providerId?: string }[],
  providers: readonly { id: string; label: string; kind: string }[],
): {
  label: string
  kind: string
  items: readonly { id: string; label: string }[]
}[] {
  const groups = providers.map((p) => ({
    label: p.label,
    kind: p.kind,
    items: models.filter((m) => m.providerId === p.id),
  }))
  const known = new Set(providers.map((p) => p.id))
  const orphans = models.filter(
    (m) => m.providerId == null || !known.has(m.providerId),
  )
  if (orphans.length > 0) {
    groups.push({ label: 'Other', kind: 'custom', items: orphans })
  }
  return groups.filter((g) => g.items.length > 0)
}
