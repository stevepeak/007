import type { WfEvalResultDTO } from '../../../server/protocol'

// "Did the score move because the agent changed, or because the test changed?"
//
// Two independent axes, and reporting either one alone is misleading.
//
// The TEST axis is a comparison of two strings already on disk: each result
// carries the hash of the sample definition it was graded against, plus the hash
// that sample carried the last time it ran.
//
// The AGENT axis exists because the hash structurally cannot see it.
// `hashEvalSnapshot` covers the sample's input, tools and checks plus the target
// IDENTITY, including `targetVersion`. A Goal that PINS a version moves its hash
// when the agent is republished. A Goal that FLOATS — null, the default — does
// not: same hash, different agent, different score. So the version each result
// actually ran, read off the frozen run manifest, is the other half of the
// answer.

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


/** Which agent version a result ran, or null when it wasn't recorded. */
function agentVersionOf(result: WfEvalResultDTO): number | null {
  return result.runStats?.agentVersion ?? null
}

export type AgentVersionSpan = {
  /** Every distinct version this run executed, ascending. */
  versions: number[]
  /** True when one run spanned more than one version — results aren't comparable. */
  mixed: boolean
}

/**
 * The agent version(s) a run executed.
 *
 * Usually one. More than one means the agent was republished WHILE the run was
 * fanning out, which makes the cells incomparable with each other, not just with
 * a previous run — worth saying out loud.
 */
export function runAgentVersionSpan(
  results: WfEvalResultDTO[],
): AgentVersionSpan {
  const versions = [
    ...new Set(results.map(agentVersionOf).filter((v): v is number => v != null)),
  ].sort((a, b) => a - b)
  return { versions, mixed: versions.length > 1 }
}

export type VersionMove = { from: number; to: number }

/**
 * How the agent version moved since the previous run, or null when it didn't
 * move (or when either side never recorded one).
 *
 * This is the comparison a floating Goal cannot make any other way: its samples'
 * snapshot hashes are identical across a republish, so nothing else in the
 * report would show that the thing under test is not the thing that ran before.
 */
export function agentVersionMoveFromPrevious(
  current: WfEvalResultDTO[],
  previousAgentVersion: number | null,
): VersionMove | null {
  const to = runAgentVersionSpan(current).versions.at(-1)
  if (to == null || previousAgentVersion == null || to === previousAgentVersion) {
    return null
  }
  return { from: previousAgentVersion, to }
}
