import type { JsonSchema } from '../../engine'
import {
  isJudgeCheck,
  type EvalCheck,
  type WfEvalTargetKind,
} from '../../server/protocol'
import { cn } from '../cn'
import { useDecisionModels } from '../hooks-models'

import { BinaryConfig } from './eval-check-config-binary'
import { DecisionJudgeConfig } from './eval-check-config-decision'
import { JudgeConfig } from './eval-check-config-judge'

export {
  defaultCheck,
  familyOf,
  type CheckFamily,
} from './eval-check-config-shared'

// The body of an expanded Check row — the fields for whichever family the check
// is in. The family itself is chosen by the toggle in the row's header, and the
// row is the card, so there's no picker and no step chrome here: this is only
// the switch between the two editors.
export function CheckConfigBody({
  check,
  persist,
  targetKind,
  hasTools,
  outputSchema,
  allowToolIds,
}: {
  check: EvalCheck
  persist: (next: EvalCheck) => void
  targetKind?: WfEvalTargetKind
  /** Whether the target has any tools at all (null = still resolving). */
  hasTools?: boolean | null
  outputSchema?: JsonSchema | null
  /** Scope the tool pickers to the target agent's wired tools (undefined = all). */
  allowToolIds?: string[]
}) {
  if (isJudgeCheck(check)) {
    // The two judges are the same assertion reached two ways, so switching
    // between them is a toggle inside the scored family rather than a different
    // kind of check to add — and the rubric and output field carry across, since
    // re-typing them would make trying the other one cost more than it's worth.
    return (
      <div className="space-y-3">
        <JudgeKindToggle check={check} persist={persist} />
        {check.type === 'decision_judge' ? (
          <DecisionJudgeConfig
            check={check}
            persist={persist}
            outputSchema={outputSchema}
          />
        ) : (
          <JudgeConfig
            check={check}
            persist={persist}
            outputSchema={outputSchema}
          />
        )}
      </div>
    )
  }
  return (
    <BinaryConfig
      check={check}
      persist={persist}
      targetKind={targetKind}
      hasTools={hasTools}
      outputSchema={outputSchema}
      allowToolIds={allowToolIds}
    />
  )
}

/**
 * Which kind of judge grades this check. Hidden entirely when the deployment has
 * no decision provider — offering a choice with one real option is noise, and a
 * disabled row would imply something is misconfigured when nothing is.
 */
function JudgeKindToggle({
  check,
  persist,
}: {
  check: Extract<EvalCheck, { type: 'llm_judge' | 'decision_judge' }>
  persist: (next: EvalCheck) => void
}) {
  const deciders = useDecisionModels()
  if ((deciders.data ?? []).length === 0) return null

  const pick = (type: 'llm_judge' | 'decision_judge') => {
    if (type === check.type) return
    // `modelId` is deliberately NOT carried across: the two catalogs are
    // different namespaces, and a chat model id in a decision check would
    // resolve to nothing. Each panel seeds its own default on first render.
    const shared = { rubric: check.rubric, path: check.path }
    persist(
      type === 'decision_judge'
        ? { type, ...shared }
        : { type, ...shared },
    )
  }

  return (
    <div className="flex items-center gap-2 text-xs text-neutral-500">
      <span>Graded by</span>
      <div className="inline-flex overflow-hidden rounded-md border border-neutral-300">
        {(
          [
            ['llm_judge', 'A model reading it'],
            ['decision_judge', 'A calibrated decider'],
          ] as const
        ).map(([type, label]) => (
          <button
            key={type}
            type="button"
            aria-pressed={check.type === type}
            className={cn(
              'px-2 py-1',
              check.type === type
                ? 'bg-amber-100 text-amber-700'
                : 'hover:bg-neutral-100',
            )}
            onClick={() => pick(type)}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  )
}
