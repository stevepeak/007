import type { WorkflowGraph } from './graph'
import { ancestorIds } from './graph-traverse'

// The author-marked priority path.
//
// An edge flagged `fastTrack` says "this pipe matters most — get it done before
// anything unrelated starts". Where `answerCriticalIds` is derived and only
// orders dispatch, this set is chosen by the author and GATES it: the Scheduler
// holds every off-track ready node while track work is running or ready.
//
// The track is the marked edges' endpoints PLUS every ancestor of their targets.
// The ancestors are not optional: a track node that waits on an off-track
// producer would otherwise be held behind the very thing it needs.
//
// Structural, like the answer cone: taken over all edges before any branch has
// routed. A track node on an untaken decision arm simply never becomes ready, so
// it cannot hold anything back.

export function fastTrackIds(graph: WorkflowGraph): Set<string> {
  const track = new Set<string>()
  for (const edge of graph.edges) {
    if (!edge.fastTrack) continue
    track.add(edge.source)
    track.add(edge.target)
    for (const id of ancestorIds(graph, edge.target)) track.add(id)
  }
  return track
}
