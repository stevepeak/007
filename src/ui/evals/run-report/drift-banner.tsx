import { GitCompare } from 'lucide-react'

import type {
  WfEvalDriftChange,
  WfEvalResultDTO,
  WfEvalRunDrift,
} from '../../../server/protocol'
import { formatTimestamp } from '../shared'

import { agentVersionMoveFromPrevious, runAgentVersionSpan } from './drift-model'

// The sentence this whole feature exists to print.
//
// Comparing two runs of a Goal only means something if you know what held still,
// and an author reading a pass rate has no way to remember that they edited a
// check last week or republished the agent on Tuesday. Both facts are now on
// disk; this says them out loud, above the numbers they explain.
//
// It deliberately reports the two axes SEPARATELY rather than folding them into
// one "something changed" warning. "The agent moved v7 → v9" and "you edited two
// samples" lead to opposite conclusions about a dropped score.

/** One clause: "2 changes (checks, input)". */
function summarizeChanges(changes: WfEvalDriftChange[]): string | null {
  if (changes.length === 0) return null
  // `draft` is the label for an unpublished save. It says nothing about what a
  // run executed — only a published version can — so it is noise here.
  const fields = [...new Set(changes.flatMap((c) => c.fields))].filter(
    (f) => f !== 'draft',
  )
  const noun = changes.length === 1 ? 'change' : 'changes'
  return fields.length > 0
    ? `${changes.length} ${noun} (${fields.join(', ')})`
    : `${changes.length} ${noun}`
}

export function DriftBanner({
  drift,
  results,
}: {
  drift: WfEvalRunDrift | null
  results: WfEvalResultDTO[]
}) {
  if (!drift) return null

  const span = runAgentVersionSpan(results)
  const move = agentVersionMoveFromPrevious(results, drift.previousAgentVersion)
  const goal = summarizeChanges(drift.goalChanges)
  const target = summarizeChanges(drift.targetChanges)

  // Nothing moved on either axis, and no version drift — then the comparison is
  // clean, and saying so is worth as much as a warning would be.
  const quiet = !move && !goal && !target && !span.mixed
  if (quiet) return null

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-3 text-sm">
      <p className="flex items-start gap-2 text-amber-900">
        <GitCompare className="mt-0.5 size-4 shrink-0 text-amber-600" />
        <span>
          <span className="font-medium">
            Since the run on {formatTimestamp(drift.previousRunAt)}
          </span>
          {move ? (
            <>
              {' '}
              — the agent moved{' '}
              <span className="font-medium tabular-nums">
                v{move.from} → v{move.to}
              </span>
              {target ? `, with ${target}` : ''}.
            </>
          ) : target ? (
            <> — the agent under test recorded {target}.</>
          ) : null}
          {goal ? <> The goal recorded {goal}.</> : null}
          {/* A floating Goal keeps an identical snapshot hash across a
              republish, so a version move with no goal edits is precisely the
              case a hash comparison reports as "nothing changed". */}
          {move && !goal ? (
            <> The samples themselves are unchanged.</>
          ) : null}
        </span>
      </p>
      {span.mixed ? (
        <p className="mt-2 pl-6 text-xs text-amber-800">
          This run spanned agent versions {span.versions.join(', ')} — it was
          republished mid-run, so these cells aren&apos;t comparable with each
          other either.
        </p>
      ) : null}
    </div>
  )
}
