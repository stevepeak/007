import { useReactFlow } from '@xyflow/react'
import { useEffect, useRef } from 'react'

import type { WorkflowGraph, WorkflowNode } from '../../engine'

import {
  engineToFlow,
  extractEditorData,
  flowToEngine,
  type EditorEdge,
  type EditorNode,
} from './workflow-canvas-graph'

// Keeping xyflow's node/edge state and the engine graph in agreement, in both
// directions. This is the whole of the canvas's plumbing and none of its rules
// or its markup.
//
// Both directions are FINGERPRINT-GUARDED, and for the same reason from
// opposite ends: xyflow re-emits on cosmetic changes (selection, hover,
// mid-drag) and the parent re-renders far more often than the graph actually
// changes. Comparing serialized content rather than object identity is what
// stops an inbound re-seed from clobbering local edits, and an outbound emit
// from reporting a structural change that didn't happen.

export type CanvasSyncOptions = {
  /** The upstream engine graph. A CONTENT change re-seeds the canvas. */
  graph: WorkflowGraph
  nodes: EditorNode[]
  edges: EditorEdge[]
  setNodes: React.Dispatch<React.SetStateAction<EditorNode[]>>
  setEdges: React.Dispatch<React.SetStateAction<EditorEdge[]>>
  /** Notified after each structural change with the current engine graph. */
  onChange?: (next: WorkflowGraph) => void
  registerNodePatcher?: (
    patch: (nodeId: string, next: WorkflowNode) => void,
  ) => void
  registerApplyGraph?: (apply: (graph: WorkflowGraph) => void) => void
  registerSelectNode?: (select: (nodeId: string) => void) => void
}

export function useCanvasSync({
  graph,
  nodes,
  edges,
  setNodes,
  setEdges,
  onChange,
  registerNodePatcher,
  registerApplyGraph,
  registerSelectNode,
}: CanvasSyncOptions) {
  const { fitView } = useReactFlow()
  const lastEmittedFingerprintRef = useRef<string | null>(null)

  // Re-seed when the upstream graph CONTENT changes (discard draft, sibling tab
  // published). Fingerprint compare avoids clobbering local edits on every
  // parent re-render.
  const lastSeededFingerprintRef = useRef(JSON.stringify(graph))
  useEffect(() => {
    const fingerprint = JSON.stringify(graph)
    if (lastSeededFingerprintRef.current === fingerprint) return
    lastSeededFingerprintRef.current = fingerprint
    const next = engineToFlow(graph)
    lastEmittedFingerprintRef.current = JSON.stringify(
      flowToEngine(next.nodes, next.edges),
    )
    setNodes(next.nodes)
    setEdges(next.edges)
  }, [graph, setNodes, setEdges])

  useEffect(() => {
    if (!registerNodePatcher) return
    registerNodePatcher((nodeId, next) => {
      setNodes((ns) =>
        ns.map((n) =>
          n.id === nodeId ? { ...n, data: extractEditorData(next) } : n,
        ),
      )
    })
  }, [registerNodePatcher, setNodes])

  useEffect(() => {
    if (!registerApplyGraph) return
    registerApplyGraph((next) => {
      const flow = engineToFlow(next)
      setNodes(flow.nodes)
      setEdges(flow.edges)
    })
  }, [registerApplyGraph, setNodes, setEdges])

  useEffect(() => {
    if (!registerSelectNode) return
    registerSelectNode((nodeId) => {
      setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === nodeId })))
      void fitView({ nodes: [{ id: nodeId }], duration: 400, maxZoom: 1.2 })
    })
  }, [registerSelectNode, setNodes, fitView])

  // onChange is a notification, not a save. Held in a ref so a caller passing a
  // fresh closure each render doesn't re-run the emit effect below.
  const onChangeRef = useRef(onChange)
  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])
  useEffect(() => {
    const fingerprint = JSON.stringify(flowToEngine(nodes, edges))
    if (lastEmittedFingerprintRef.current === null) {
      lastEmittedFingerprintRef.current = fingerprint
      return
    }
    if (lastEmittedFingerprintRef.current === fingerprint) return
    lastEmittedFingerprintRef.current = fingerprint
    onChangeRef.current?.(flowToEngine(nodes, edges))
  }, [nodes, edges])
}
