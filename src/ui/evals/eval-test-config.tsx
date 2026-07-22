import { Binary, Gauge } from 'lucide-react'

import type { JsonSchema } from '../../engine'
import type { EvalCheck, WfEvalTargetKind } from '../../server/protocol'
import { BinaryConfig } from './eval-test-config-binary'
import { JudgeConfig } from './eval-test-config-judge'
import { familyOf, type TestFamily } from './eval-test-config-shared'
import { PickerCards, StepFlow, type Step } from './step-flow'

export {
  defaultCheck,
  familyOf,
  type TestFamily,
  withMeta,
} from './eval-test-config-shared'

export function ConfigForm({
  draft,
  persist,
  setFamily,
  targetKind,
  outputSchema,
  allowToolIds,
}: {
  draft: EvalCheck
  persist: (next: EvalCheck) => void
  setFamily: (family: TestFamily) => void
  targetKind?: WfEvalTargetKind
  outputSchema?: JsonSchema | null
  /** Scope the tool pickers to the target agent's wired tools (undefined = all). */
  allowToolIds?: string[]
}) {
  const family = familyOf(draft)
  const steps: Step[] = [
    {
      key: 'config',
      title: 'Configuration',
      content:
        draft.type === 'llm_judge' ? (
          <JudgeConfig check={draft} persist={persist} />
        ) : (
          <BinaryConfig
            check={draft}
            persist={persist}
            targetKind={targetKind}
            outputSchema={outputSchema}
            allowToolIds={allowToolIds}
          />
        ),
    },
  ]
  return (
    <div className="space-y-3">
      <PickerCards
        value={family}
        onSelect={(f) => setFamily(f)}
        options={[
          {
            value: 'binary',
            icon: Binary,
            label: 'Binary',
            desc: 'A deterministic pass/fail check.',
            accent: 'sky',
          },
          {
            value: 'scored',
            icon: Gauge,
            label: 'Scored',
            desc: 'An LLM judge grades the output against a rubric.',
            accent: 'amber',
          },
        ]}
      />
      <StepFlow steps={steps} />
    </div>
  )
}
