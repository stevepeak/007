import { useDecisionModels } from '../hooks'

// The JUDGE of the run: the decision model behind every judge check in the
// sweep. Checks can't name their own, so one report is graded by one
// instrument. Shown only when the Goals' Samples carry a judge check; it starts
// on the first calibrated decider (`defaultDecisionJudge`).
export function JudgeAxis({
  needed,
  decisionJudgeModelId,
  onDecisionJudge,
}: {
  /** Whether these Goals' Samples carry a judge check. */
  needed: boolean
  decisionJudgeModelId: string
  onDecisionJudge: (modelId: string) => void
}) {
  const deciders = useDecisionModels()
  if (!needed) return null
  const chosen = deciders.data?.find((m) => m.id === decisionJudgeModelId)
  const none = !deciders.isLoading && (deciders.data ?? []).length === 0

  return (
    <div>
      <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-neutral-500 uppercase">
        Judge
      </h3>
      {none ? (
        <p className="text-xs text-amber-600">
          This deployment has no decision model, so its judge checks cannot be
          graded. Wire <code>WfSdkConfig.getDecider</code> first.
        </p>
      ) : (
        <div className="space-y-1">
          <p className="text-xs text-neutral-500">
            Grades every <strong>Judge</strong> check in this run. A sample’s
            judge questions are asked together, in one call per answer.
          </p>
          <select
            aria-label="Decision judge"
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
          {chosen?.calibrated === false ? (
            <p className="text-xs text-neutral-400">
              Emulated on a chat model — treat thresholds as rough.
            </p>
          ) : null}
        </div>
      )}
      <p className="mt-1.5 text-xs text-neutral-400">
        Keep the judge the same across runs you want to compare — a different
        judge re-grades the same answers.
      </p>
    </div>
  )
}
