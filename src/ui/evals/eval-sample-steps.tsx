import type { EvalSampleInput } from '../../server/protocol'

import { ChecksList } from './eval-sample-checks'
import { SampleContextEditor } from './eval-sample-context'
import { DecisionStateEditor } from './eval-sample-decision'
import { SampleInputEditor } from './eval-sample-input'
import { SampleToolsEditor } from './eval-sample-tools'
import { StepFlow, type Step } from './step-flow'
import type { Draft, useEvalSampleDraft } from './use-eval-sample-draft'

type SampleState = ReturnType<typeof useEvalSampleDraft>

// The Input card names the shape it is actually editing — which is also what
// says, without a second label, what kind of agent this goal targets.
const INPUT_TITLES: Record<EvalSampleInput['kind'], string> = {
  task: 'Input',
  conversation: 'Conversation',
  trigger: 'Trigger payload',
  decision: 'State',
}

/**
 * The three questions a sample answers, in order: what is the target invoked
 * with, how do its tools behave, and what has to be true of the run. The Tools
 * step is conditional — an agent with no tools has nothing to list there.
 */
export function SampleConfigSteps({
  state,
  draft,
}: {
  state: SampleState
  /** The loaded draft — narrowed by the caller's `QueryState`, so never null. */
  draft: Draft
}) {
  const { set, edit } = state
  const targetKind = set?.targetKind ?? 'agent'

  const steps: Step[] = [
    {
      key: 'input',
      title: INPUT_TITLES[draft.input.kind],
      content: (
        <div className="space-y-4">
          {draft.input.kind === 'decision' ? (
            <DecisionStateEditor
              value={draft.input}
              variableNames={state.decisionContract?.inputVariables ?? []}
              onChange={(input) => edit({ ...draft, input })}
            />
          ) : (
            <>
              <SampleInputEditor
                targetId={set?.targetId ?? ''}
                value={draft.input}
                onChange={(input) => edit({ ...draft, input })}
              />
              <SampleContextEditor
                targetId={set?.targetId ?? ''}
                targetKind={targetKind}
                tools={draft.tools}
                value={draft.input.context ?? {}}
                onChange={(context) => {
                  const { input } = draft
                  if (input.kind === 'decision') return
                  edit({ ...draft, input: { ...input, context } })
                }}
              />
            </>
          )}
        </div>
      ),
    },
  ]

  // Only when the target actually has tools. `null` = still resolving the
  // agent, so nothing renders yet rather than a card that flashes in and out.
  if (state.hasTools) {
    steps.push({
      key: 'tools',
      title: targetKind === 'workflow' ? 'Nodes' : 'Tools',
      content: (
        <SampleToolsEditor
          targetId={set?.targetId ?? ''}
          targetKind={targetKind}
          value={draft.tools}
          onChange={(tools) => edit({ ...draft, tools })}
        />
      ),
    })
  }

  steps.push({
    key: 'checks',
    title: 'Checks',
    content: (
      <ChecksList
        checks={draft.checks}
        targetKind={set?.targetKind}
        hasTools={state.hasTools}
        outputSchema={state.outputSchema}
        allowToolIds={state.allowToolIds}
        decisionContract={state.decisionContract}
        openIndex={state.openCheck}
        onOpenChange={state.setOpenCheck}
        onChange={(checks) => edit({ ...draft, checks })}
        onAdd={state.addCheck}
      />
    ),
  })

  return <StepFlow steps={steps} />
}

