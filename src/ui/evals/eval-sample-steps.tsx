import { Plus } from 'lucide-react'

import type { EvalSampleInput } from '../../server/protocol'
import { useWfComponents } from '../context'

import { ChecksList } from './eval-sample-checks'
import { emptyInputFor, SampleInputEditor } from './eval-sample-input'
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
}

/**
 * The three questions a sample answers, in order: what is the target invoked
 * with, how do its tools behave, and what has to be true of the run. The Tools
 * step is conditional — an agent with no tools behaves identically under all
 * three modes, so the card would be asking a question with no answer.
 */
export function SampleConfigSteps({
  state,
  draft,
  addMockOpen,
  onAddMockOpenChange,
}: {
  state: SampleState
  /** The loaded draft — narrowed by the caller's `QueryState`, so never null. */
  draft: Draft
  addMockOpen: boolean
  onAddMockOpenChange: (open: boolean) => void
}) {
  const { Button } = useWfComponents()
  const { set, edit } = state
  const targetKind = set?.targetKind ?? 'agent'

  const steps: Step[] = [
    {
      key: 'input',
      title: INPUT_TITLES[draft.input.kind],
      content: (
        <div className="space-y-3">
          {state.kindMismatch ? (
            <KindMismatchNotice state={state} draft={draft} />
          ) : null}
          <SampleInputEditor
            targetId={set?.targetId ?? ''}
            value={draft.input}
            onChange={(input) => edit({ ...draft, input })}
          />
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
      aside:
        draft.tools.mode === 'mocked' && targetKind === 'agent' ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onAddMockOpenChange(!addMockOpen)}
          >
            <Plus className="size-4" />
            Add mock
          </Button>
        ) : undefined,
      content: (
        <SampleToolsEditor
          targetId={set?.targetId ?? ''}
          targetKind={targetKind}
          value={draft.tools}
          onChange={(tools) => edit({ ...draft, tools })}
          addOpen={addMockOpen}
          onAddOpenChange={onAddMockOpenChange}
          stagedToolResults={state.stagedToolResults}
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
        tools={draft.tools}
        targetKind={set?.targetKind}
        hasTools={state.hasTools}
        outputSchema={state.outputSchema}
        allowToolIds={state.allowToolIds}
        openIndex={state.openCheck}
        onOpenChange={state.setOpenCheck}
        onChange={(checks) => edit({ ...draft, checks })}
        onAdd={state.addCheck}
      />
    ),
  })

  return <StepFlow steps={steps} />
}

/**
 * A sample authored before its goal's target changed input kind still holds the
 * old variant. Offer the swap rather than silently rewriting an author's work —
 * the old input's values are what they'd have to retype.
 */
function KindMismatchNotice({
  state,
  draft,
}: {
  state: SampleState
  draft: Draft
}) {
  return (
    <div className="flex items-start gap-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2">
      <p className="text-[11px] text-amber-700">
        This sample holds a <strong>{draft.input.kind}</strong> input, but{' '}
        {state.targetAgent?.name ?? 'the target agent'} now takes a{' '}
        <strong>{state.expectedKind}</strong> one — the run will ignore
        what&apos;s below.
      </p>
      <button
        type="button"
        onClick={() =>
          state.edit({
            ...draft,
            input: emptyInputFor(
              state.expectedKind === 'conversation' ? 'conversation' : 'task',
            ),
          })
        }
        className="ml-auto shrink-0 text-[11px] font-medium text-amber-800 underline"
      >
        Switch to {state.expectedKind}
      </button>
    </div>
  )
}
