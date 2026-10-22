import { Play, Target } from 'lucide-react'
import { useMemo } from 'react'

import { useWfComponents } from '../context'
import { EmptyState } from '../empty-state'
import { useEvalSets } from '../hooks'
import { useWfNav } from '../nav'
import { WfShell } from '../shell'

import { SimulationNotice } from './run-config-dialog'
import { ConfirmStep } from './run-config-dialog-confirm'
import { JudgeAxis } from './run-config-dialog-judges'
import { ModelAxis } from './run-config-dialog-models'
import { PromptAxis } from './run-config-dialog-prompts'
import { useRunConfigMatrix } from './use-run-config-matrix'

// The "Run tests" page (routes: evals/runs/new for every Goal, evals/<setId>/run
// for one). The matrix, judges and the cost gate on one scrolling page, ending
// in the launch button; launching replaces this tab with the live report.
//
// The agent editor keeps `RunConfigDialog`: it grades UNSAVED edits, and
// leaving the editor for a page is exactly how that draft gets lost.

export type EvalRunConfigPageProps = {
  /** The Goal to run; null = every Goal. */
  setId: string | null
  className?: string
}

export function EvalRunConfigPage({ setId, className }: EvalRunConfigPageProps) {
  const { Button } = useWfComponents()
  const { navigate } = useWfNav()
  const setsQuery = useEvalSets()
  const sets = useMemo(() => setsQuery.data ?? [], [setsQuery.data])
  const setIds = useMemo(() => {
    return setId ? [setId] : sets.map((s) => s.id)
  }, [setId, sets])
  const targetName = setId
    ? (sets.find((s) => s.id === setId)?.name ?? 'Goal')
    : `all goals (${sets.length})`

  const matrix = useRunConfigMatrix({
    open: true,
    setIds,
    onClose: () => {},
    onLaunched: (evalRunId) => navigate(`evals/runs/${evalRunId}`),
  })

  return (
    <WfShell
      crumbs={[{ label: 'New run', icon: Target, iconClassName: 'text-rose-500' }]}
      scroll
      className={className}
      actions={
        <Button size="sm" disabled={!matrix.canRun} onClick={matrix.launch}>
          <Play className="size-4" />
          {matrix.launching ? 'Launching…' : 'Start run'}
        </Button>
      }
    >
      <div className="mx-auto max-w-3xl space-y-6 p-6">
        <p className="text-sm text-neutral-500">
          Run{' '}
          <span className="font-medium text-neutral-700">{targetName}</span> in
          simulation.
        </p>

        {!setsQuery.isLoading && setIds.length === 0 ? (
          <EmptyState message="Nothing to run yet — add a goal with samples first." />
        ) : null}

        <ModelAxis
          loading={matrix.loadingModels}
          groups={matrix.groups}
          requirements={matrix.requirements}
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

        <JudgeAxis
          types={matrix.judgeTypes}
          judgeModelId={matrix.judgeModelId}
          onJudge={matrix.setJudgeModelId}
          decisionJudgeModelId={matrix.decisionJudgeModelId}
          onDecisionJudge={matrix.setDecisionJudgeModelId}
        />

        <SimulationNotice />

        <ConfirmStep
          className="space-y-4 border-t border-neutral-200 pt-6"
          baselineLabel={matrix.baselineLabel}
          selectedModels={matrix.selectedModels}
          counts={matrix.counts}
          promptCount={matrix.prompts.length}
          totalTests={matrix.totalTests}
          judgeTypes={matrix.judgeTypes}
          judgeModelId={matrix.judgeModelId}
          decisionJudgeModelId={matrix.decisionJudgeModelId}
          concurrency={matrix.concurrency}
          onConcurrencyChange={matrix.setConcurrency}
          runError={matrix.runError}
        />

        <div className="flex justify-end">
          <Button disabled={!matrix.canRun} onClick={matrix.launch}>
            <Play className="size-4" />
            {matrix.launching ? 'Launching…' : 'Start run'}
          </Button>
        </div>
      </div>
    </WfShell>
  )
}
