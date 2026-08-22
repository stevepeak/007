import { ArrowLeft, ArrowRight, FlaskConical, Play, ShieldCheck, X } from 'lucide-react'

import type { AgentConfig } from '../../engine'
import { useWfComponents } from '../context'
import { Modal } from '../modal'
import { useWfNav } from '../nav'

import { ConfirmStep } from './run-config-dialog-confirm'
import { ModelAxis } from './run-config-dialog-models'
import { PromptAxis } from './run-config-dialog-prompts'
import { useRunConfigMatrix } from './use-run-config-matrix'

// The "Run" confirm, shared by the catalog / Goal / Sample / Check Run buttons.
// A run always executes in SIMULATION (write tools no-op, read tools return the
// row's fixtures) and is marked `is_eval` so it stays out of the Runs explorer.
//
// This file is the SHELL — the modal chrome, the two-step flow, and which axis
// renders where. What the run actually sweeps over lives in
// `useRunConfigMatrix`, and the two axes render themselves.

export type RunConfigDialogProps = {
  open: boolean
  onClose: () => void
  /** What this run targets, for the subtitle copy. */
  scope: 'goal' | 'sample'
  /** Display name of the thing being run (shown in the subtitle). */
  targetName: string
  /** The eval set(s) to run. Empty = nothing to launch (button disabled). */
  setIds: string[]
  /**
   * Run every cell against this agent config instead of the target's published
   * version — set by the agent editor so a goal can be run against UNSAVED
   * edits. It changes three things here: the baseline prompt column is the
   * DRAFT's prompt (not the saved one), the model axis starts pre-selected on
   * the draft's model so the dialog is one click from launching, and the
   * variable hints come from the draft rather than the saved agent.
   * Omitted → the published version (the Goal / Sample / catalog callers).
   */
  draftConfig?: AgentConfig
  /**
   * Take over what happens once the umbrella run row exists. The default
   * navigates to the full report — which the agent editor must NOT do, since
   * leaving the page is exactly how the unsaved draft under test gets lost. It
   * passes a handler that shows the run inline instead.
   */
  onLaunched?: (evalRunId: string) => void
}

export function RunConfigDialog({
  open,
  onClose,
  scope,
  targetName,
  setIds,
  draftConfig,
  onLaunched,
}: RunConfigDialogProps) {
  const { Button } = useWfComponents()
  const { navigate } = useWfNav()

  const matrix = useRunConfigMatrix({
    open,
    setIds,
    draftConfig,
    onClose,
    onLaunched: (evalRunId) => {
      if (onLaunched) onLaunched(evalRunId)
      else navigate(`evals/runs/${evalRunId}`)
    },
  })

  if (!open) return null

  // "Run this goal" is wrong the moment a caller hands in several — the agent
  // editor runs every goal that targets the agent, usually more than one.
  const scopeLabel = scope === 'goal' && setIds.length > 1 ? 'goals' : scope

  return (
    <Modal
      open={open}
      onClose={onClose}
      panelClassName="flex max-h-[85vh] w-full max-w-lg flex-col rounded-lg border border-neutral-200 bg-white shadow-xl"
      footer={
        matrix.step === 'configure' ? (
          <>
            <Button variant="outline" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={!matrix.canConfigure}
              onClick={() => matrix.setStep('confirm')}
            >
              Review run
              <ArrowRight className="size-4" />
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => matrix.setStep('configure')}
            >
              <ArrowLeft className="size-4" />
              Back
            </Button>
            <Button size="sm" disabled={!matrix.canRun} onClick={matrix.launch}>
              <Play className="size-4" />
              {matrix.launching ? 'Launching…' : 'Start run'}
            </Button>
          </>
        )
      }
    >
      <div className="flex items-start justify-between border-b border-neutral-200 px-5 py-3">
        <div>
          <h2 className="text-sm font-semibold text-neutral-900">
            {matrix.step === 'confirm' ? 'Confirm test run' : 'Run tests'}
          </h2>
          <p className="mt-0.5 text-xs text-neutral-500">
            {matrix.step === 'confirm' ? (
              'Review the test matrix before launching.'
            ) : (
              <>
                Run this {scopeLabel} in simulation ·{' '}
                <span className="font-medium text-neutral-700">{targetName}</span>
              </>
            )}
          </p>
        </div>
        <button
          aria-label="Close"
          onClick={onClose}
          className="text-neutral-400 transition hover:text-neutral-700"
        >
          <X className="size-4" />
        </button>
      </div>

      {matrix.step === 'configure' ? (
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {/* What is actually under test. Stated first and unmissably, because
              every other line in this dialog reads the same whether the run
              grades a published agent or a draft that exists only in one
              browser tab — and the verdicts are worth very different things. */}
          {draftConfig ? <DraftNotice /> : null}

          <ModelAxis
            loading={matrix.loadingModels}
            groups={matrix.groups}
            counts={matrix.counts}
            collapsed={matrix.collapsed}
            onCount={matrix.setCount}
            onToggleProvider={matrix.toggleProvider}
            selectedCount={matrix.selectedIds.length}
            totalRuns={matrix.totalRuns}
          />

          <PromptAxis
            baselineLabel={matrix.baselineLabel}
            prompts={matrix.prompts}
            availableVariables={matrix.availableVariables}
            onAdd={matrix.addPrompt}
            onRemove={matrix.removePrompt}
            onBody={matrix.setPromptBody}
          />

          <SimulationNotice />

          {setIds.length === 0 ? (
            <p className="text-xs text-amber-600">
              Nothing to run yet — add a sample first.
            </p>
          ) : null}
        </div>
      ) : (
        <ConfirmStep
          baselineLabel={matrix.baselineLabel}
          selectedModels={matrix.selectedModels}
          counts={matrix.counts}
          promptCount={matrix.prompts.length}
          totalTests={matrix.totalTests}
          concurrency={matrix.concurrency}
          onConcurrencyChange={matrix.setConcurrency}
          runError={matrix.runError}
        />
      )}
    </Modal>
  )
}

function DraftNotice() {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
      <FlaskConical className="mt-0.5 size-4 shrink-0 text-amber-600" />
      <p>
        Testing your <strong>unsaved edits</strong> — the whole draft, not just
        the prompt: model, tools, expected output, turns and budget all run as
        they stand in the editor. Nothing is saved or published by running this.
      </p>
    </div>
  )
}

function SimulationNotice() {
  return (
    <div className="flex items-start gap-2 rounded-lg bg-neutral-50 px-3 py-2.5 text-sm text-neutral-600">
      <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" />
      <p>
        Every sample runs with <strong>simulation on</strong> — write tools
        (e.g. send email) no-op and read tools return the sample&apos;s
        fixtures, so no real data is touched. The run is graded against each
        sample&apos;s checks.
      </p>
    </div>
  )
}
