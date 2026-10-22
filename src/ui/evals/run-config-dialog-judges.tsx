import type { JudgeCheckType } from '../../engine/eval-schema'
import { JUDGE_REQUIREMENTS } from '../../eval/judge'
import { ModelSelect } from '../editor/model-select'
import { useDecisionModels } from '../hooks'

// The JUDGES of the run. One per judge kind, for every check in the sweep —
// checks can't name their own, so one report is graded by one instrument. Only
// the kinds the Goals' Samples actually use are shown. The judge starts on the
// cheapest model that can do the job (`defaultJudgeModel`); models that can't
// are listed greyed out with the reason rather than hidden.
export function JudgeAxis({
  types,
  judgeModelId,
  onJudge,
  decisionJudgeModelId,
  onDecisionJudge,
}: {
  /** The judge kinds these Goals' Samples carry. */
  types: Set<JudgeCheckType>
  judgeModelId: string
  onJudge: (modelId: string) => void
  decisionJudgeModelId: string
  onDecisionJudge: (modelId: string) => void
}) {
  const deciders = useDecisionModels()
  if (types.size === 0) return null
  const chosenDecider = deciders.data?.find(
    (m) => m.id === decisionJudgeModelId,
  )

  return (
    <div>
      <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-neutral-500 uppercase">
        Judge
      </h3>
      <div className="space-y-2">
        {types.has('llm_judge') ? (
          <div className="space-y-1">
            <p className="text-xs text-neutral-500">
              Grades every <strong>Judge</strong> check in this run.
            </p>
            <ModelSelect
              value={judgeModelId}
              onChange={onJudge}
              requirements={JUDGE_REQUIREMENTS}
            />
          </div>
        ) : null}
        {types.has('decision_judge') ? (
          <div className="space-y-1">
            <p className="text-xs text-neutral-500">
              Grades every <strong>calibrated</strong> check in this run.
            </p>
            <select
              value={decisionJudgeModelId}
              onChange={(e) => onDecisionJudge(e.target.value)}
              className="h-9 w-full rounded-md border border-neutral-300 bg-transparent px-2 text-sm outline-none focus:border-neutral-500"
            >
              {(deciders.data ?? []).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                  {m.calibrated === false ? ' (emulated)' : ''}
                </option>
              ))}
            </select>
            {chosenDecider?.calibrated === false ? (
              <p className="text-xs text-neutral-400">
                Emulated on a chat model — treat thresholds as rough.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
      <p className="mt-1.5 text-xs text-neutral-400">
        Keep the judge the same across runs you want to compare — a different
        judge re-grades the same answers.
      </p>
    </div>
  )
}
