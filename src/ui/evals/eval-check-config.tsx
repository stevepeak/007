import type { JsonSchema } from '../../engine'
import type { EvalCheck, WfEvalTargetKind } from '../../server/protocol'
import { BinaryConfig } from './eval-check-config-binary'
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
  return check.type === 'llm_judge' ? (
    <JudgeConfig check={check} persist={persist} outputSchema={outputSchema} />
  ) : (
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
