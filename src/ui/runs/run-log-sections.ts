import type { WfRunStepDTO } from '../../server/protocol'

// A step row exists from the moment its node starts: `meta` and `output` are
// written as `{}` (the column defaults) and filled in when the node finishes.
// So an empty value on a live step means "not yet", never "nothing".

/** `null`, `undefined`, `''`, `[]` and `{}` carry no data worth a section. */
export function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return true
  if (Array.isArray(value)) return value.length === 0
  if (typeof value === 'object') return Object.keys(value).length === 0
  return false
}

/** The step's node has started but not settled. */
export function isStepInFlight(status: string): boolean {
  return status === 'running' || status === 'queued'
}

/**
 * How the timeline ends: the real output, a pending row while the node is
 * still working, or an explicit "No output" for a settled step that produced
 * nothing.
 */
export type RunLogTail = 'output' | 'pending' | 'empty'

export function runLogSections(args: {
  step: Pick<WfRunStepDTO, 'status' | 'meta' | 'output'>
  /** `meta` already has a bespoke view (agent turns, iteration grid). */
  hasBespokeMeta: boolean
}): { details: boolean; tail: RunLogTail } {
  const { step, hasBespokeMeta } = args
  const details = !hasBespokeMeta && !isEmptyValue(step.meta)
  if (!isEmptyValue(step.output)) return { details, tail: 'output' }
  return { details, tail: isStepInFlight(step.status) ? 'pending' : 'empty' }
}
