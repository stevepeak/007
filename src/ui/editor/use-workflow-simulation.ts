import { useCallback, useEffect, useRef, useState } from 'react'

import {
  isBookendKind,
  nodeProgressMessage,
  type WfRunManifestEntry,
  type WorkflowGraph,
  type WorkflowNode,
} from '../../engine'
import type { RunSurfaceItem, RunSurfaceStatus } from '../run-progress-view'

// Client-side SIMULATION of a run's user-facing progress, so an author can
// preview the exact `WorkflowRunProgress` UX end users will see — no backend, no
// model spend, deterministic. It topologically walks the graph and emits one
// synthetic progress line per executable node (the same `nodeProgressMessage`
// the real engine emits), plus a couple of sample `item i of n` ticks for an
// iteration. It is a fidelity aid for authoring the per-node progress notes, not
// a real run.

const STEP_MS = 700
const SAMPLE_ITERATION_ITEMS = 3

// Topological order of executable nodes (bookends excluded), following edges
// from the trigger. Falls back to declaration order if the graph has a cycle
// (the editor blocks running those anyway; the preview just stays best-effort).
function orderedExecutableNodes(graph: WorkflowGraph): WorkflowNode[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const indegree = new Map<string, number>()
  for (const n of graph.nodes) indegree.set(n.id, 0)
  for (const e of graph.edges) {
    indegree.set(e.target, (indegree.get(e.target) ?? 0) + 1)
  }
  const queue = graph.nodes.filter((n) => (indegree.get(n.id) ?? 0) === 0)
  const order: WorkflowNode[] = []
  const seen = new Set<string>()
  while (queue.length > 0) {
    const n = queue.shift()!
    if (seen.has(n.id)) continue
    seen.add(n.id)
    order.push(n)
    for (const e of graph.edges.filter((e) => e.source === n.id)) {
      const d = (indegree.get(e.target) ?? 0) - 1
      indegree.set(e.target, d)
      const target = byId.get(e.target)
      if (target && d <= 0 && !seen.has(e.target)) queue.push(target)
    }
  }
  // Any node the walk missed (cycle) appended in declaration order.
  for (const n of graph.nodes) if (!seen.has(n.id)) order.push(n)
  return order.filter((n) => !isBookendKind(n))
}

// The full synthetic item list a simulated run would produce, in order.
export function buildSimulatedItems(
  graph: WorkflowGraph,
  manifest: readonly WfRunManifestEntry[],
): RunSurfaceItem[] {
  const items: RunSurfaceItem[] = []
  for (const node of orderedExecutableNodes(graph)) {
    const message = nodeProgressMessage(node, undefined, manifest)
    if (message) items.push({ kind: 'progress', message, nodeId: node.id })
    if (node.kind === 'iteration') {
      for (let i = 1; i <= SAMPLE_ITERATION_ITEMS; i++) {
        items.push({
          kind: 'progress',
          message: `Processing item ${i} of ${SAMPLE_ITERATION_ITEMS}`,
          nodeId: node.id,
        })
      }
    }
  }
  return items
}

export type WorkflowSimulation = {
  items: RunSurfaceItem[]
  progress: { completed: number; total: number }
  status: RunSurfaceStatus
  active: boolean
  start: () => void
  stop: () => void
  /** Stop and clear the preview entirely (hides the panel). */
  dismiss: () => void
}

/**
 * Drive a timed reveal of the simulated progress items. `start()` replays the
 * walk from the top; the component re-renders as each item appears.
 */
export function useWorkflowSimulation(
  graph: WorkflowGraph,
  manifest: readonly WfRunManifestEntry[] = [],
): WorkflowSimulation {
  const [items, setItems] = useState<RunSurfaceItem[]>([])
  const [status, setStatus] = useState<RunSurfaceStatus>('completed')
  const [active, setActive] = useState(false)
  const [total, setTotal] = useState(0)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  const stop = useCallback(() => {
    if (timer.current) {
      clearInterval(timer.current)
      timer.current = null
    }
    setActive(false)
  }, [])

  const start = useCallback(() => {
    stop()
    const all = buildSimulatedItems(graph, manifest)
    setItems([])
    setTotal(all.length)
    setStatus('running')
    setActive(true)
    if (all.length === 0) {
      setStatus('completed')
      setActive(false)
      return
    }
    let i = 0
    timer.current = setInterval(() => {
      i += 1
      setItems(all.slice(0, i))
      if (i >= all.length) {
        stop()
        setStatus('completed')
      }
    }, STEP_MS)
  }, [graph, manifest, stop])

  const dismiss = useCallback(() => {
    stop()
    setItems([])
    setTotal(0)
    setStatus('completed')
  }, [stop])

  // Clear the timer if the editor unmounts mid-preview.
  useEffect(() => stop, [stop])

  return {
    items,
    progress: { completed: items.length, total },
    status,
    active,
    start,
    stop,
    dismiss,
  }
}
