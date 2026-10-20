import type { WfRunSummary } from '../../server/protocol'
import { formatDurationMs, formatUsd } from '../cost'

/**
 * The tooltip behind a run's cost figure, shared by the runs table row and the
 * run page header so both explain a tree total the same way. Lines join with
 * ` · `; an empty string means there is nothing to add.
 *
 * `where` only changes how the tree's size is worded. `hasChildren` matters for
 * a row whose children are listed beside it: without a tree total, its figure is
 * its own and the tooltip says so.
 */
export function runCostTitle(args: {
  run: WfRunSummary
  where: 'row' | 'header'
  hasChildren?: boolean
}): string {
  const { run, where, hasChildren = false } = args
  const tree = run.tree
  const tokens = tree?.totalTokens ?? run.totalTokens
  return [
    tokens != null ? `${tokens.toLocaleString()} tokens` : null,
    tree
      ? where === 'row'
        ? `${tree.runCount} runs in this tree`
        : `Across ${tree.runCount} runs, including everything this one spawned`
      : null,
    tree?.computeMs != null
      ? `${formatDurationMs(tree.computeMs)} of compute, run concurrently`
      : null,
    tree
      ? `This run itself: ${run.costUsd != null ? formatUsd(run.costUsd) : 'no priced agent calls'}`
      : null,
    // A tree with runs still going is a floor, not a total. Said in words as
    // well as marked with a `+` beside the figure, since a bare `+` is easy to
    // miss.
    tree && tree.pending > 0
      ? `${tree.pending} still running — this is the total so far`
      : null,
    !tree && hasChildren
      ? "This run's own cost — its child runs are listed separately, each with theirs."
      : null,
  ]
    .filter(Boolean)
    .join(' · ')
}
