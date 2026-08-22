import type { WfRunLogDTO, WfRunStepDTO } from '../server/protocol'

// Indexing a run's raw steps and logs into the lookups the tree builder walks.
// Split out because it is the one part of `buildActivityTree` that answers
// "what happened?" rather than "how should it read?" — and because both of its
// inputs arrive as flat, unordered arrays that every other phase would
// otherwise have to re-scan.

/** Log levels that mark a node's boundaries rather than saying anything. */
const BOOKEND_LEVELS = new Set(['node-start', 'node-end'])

export type RunActivityIndex = {
  /** nodeId → its latest top-level step (highest sequence wins). */
  topSteps: Map<string, WfRunStepDTO>
  /** containerNodeId → every step recorded beneath it (iteration items, sub-agents). */
  childSteps: Map<string, WfRunStepDTO[]>
  /** nodeId → its feed lines, oldest first. Bookends are excluded. */
  logsByNode: Map<string, WfRunLogDTO[]>
  /** A node's wall-clock window, or undefined if it never closed. */
  timingFor: (nodeId: string) => { start: number; end: number } | undefined
}

export function indexRunActivity(
  steps: WfRunStepDTO[],
  logs: WfRunLogDTO[],
): RunActivityIndex {
  // Latest top-level step per node + children by container.
  const topSteps = new Map<string, WfRunStepDTO>()
  const childSteps = new Map<string, WfRunStepDTO[]>()
  for (const s of steps) {
    if (s.parentNodeId == null) {
      const prev = topSteps.get(s.nodeId)
      if (!prev || s.sequence >= prev.sequence) topSteps.set(s.nodeId, s)
    } else {
      const arr = childSteps.get(s.parentNodeId) ?? []
      arr.push(s)
      childSteps.set(s.parentNodeId, arr)
    }
  }

  // Logs by node: the bookends carry TIMING, everything else is a leaf line.
  const logsByNode = new Map<string, WfRunLogDTO[]>()
  const rawTiming = new Map<string, { start?: number; end?: number }>()
  for (const l of logs) {
    if (l.nodeId == null) continue
    if (BOOKEND_LEVELS.has(l.level)) {
      const t = rawTiming.get(l.nodeId) ?? {}
      if (l.level === 'node-start') t.start = l.ts
      else t.end = l.ts
      rawTiming.set(l.nodeId, t)
      continue
    }
    const arr = logsByNode.get(l.nodeId) ?? []
    arr.push(l)
    logsByNode.set(l.nodeId, arr)
  }
  for (const arr of logsByNode.values()) {
    arr.sort((a, b) => a.ts - b.ts || (a.sequence ?? 0) - (b.sequence ?? 0))
  }

  return {
    topSteps,
    childSteps,
    logsByNode,
    // Only a CLOSED window counts: a node that started and never finished has
    // no duration to report, and pairing a start with `now` would make every
    // in-flight node look like it had completed instantly at render time.
    timingFor: (nodeId) => {
      const t = rawTiming.get(nodeId)
      return t?.start != null && t?.end != null
        ? { start: t.start, end: t.end }
        : undefined
    },
  }
}
