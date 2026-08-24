import type { WfEvalResultDTO } from '../../../server/protocol'

// "Did the score move because the agent changed, or because the test changed?"
//
// This module answers the second half, and only the second half. Each result
// carries the hash of the sample definition it was graded against plus the hash
// that sample carried the last time it ran, so a changed test is a comparison of
// two strings that are already on disk — no new tables, no new writes.
//
// Be precise about the blind spot, because it is the one that misleads.
// `hashEvalSnapshot` covers the sample's input, tools and checks plus the target
// IDENTITY — including `targetVersion`. When a Goal pins a version, republishing
// the agent moves the hash. When it floats (null, the default), republishing
// does not: same hash, different agent, different score. So an unchanged sample
// means "the test is the same", never "nothing changed".

export type SampleDrift = {
  /** The sample's definition differs from the last run that included it. */
  changed: boolean
  /** No earlier run to compare against — this sample's first appearance. */
  isNew: boolean
}

const UNCHANGED: SampleDrift = { changed: false, isNew: false }

/** Whether one result's sample definition moved since it last ran. */
export function resultDrift(result: {
  snapshotHash: string | null
  previousSnapshotHash: string | null
}): SampleDrift {
  // No baseline: either a brand-new sample or one whose last run predates
  // snapshots. Both are "nothing to compare", not "changed".
  if (!result.previousSnapshotHash) {
    return { changed: false, isNew: result.snapshotHash != null }
  }
  if (!result.snapshotHash) return UNCHANGED
  return {
    changed: result.snapshotHash !== result.previousSnapshotHash,
    isNew: false,
  }
}

/**
 * Drift for every sample in a run, keyed by row id.
 *
 * A run holds several results per sample when it sweeps models or prompts, and
 * they all graded the same definition — so this collapses to one verdict per
 * sample rather than per result.
 */
export function runDrift(results: WfEvalResultDTO[]): Map<string, SampleDrift> {
  const byRow = new Map<string, SampleDrift>()
  for (const r of results) {
    if (byRow.has(r.rowId)) continue
    byRow.set(r.rowId, resultDrift(r))
  }
  return byRow
}

/** How many distinct samples were edited since they last ran. */
export function changedSampleCount(results: WfEvalResultDTO[]): number {
  let count = 0
  for (const drift of runDrift(results).values()) {
    if (drift.changed) count++
  }
  return count
}
