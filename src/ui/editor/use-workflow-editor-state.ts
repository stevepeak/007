import { useCallback, useMemo, useRef, useState } from 'react'

import type { WorkflowGraph } from '../../engine'
import { useWfClient } from '../context'
import {
  useSaveDraft,
  useSaveVersion,
  useTools,
  useUpdateWorkflow,
  useVersions,
} from '../hooks'
import { useModifierHold } from '../use-modifier-hold'

import { useCanvasHandles } from './use-canvas-handles'
import { useEditHistory } from './use-edit-history'
import { invalidNodeIdsOf, useGraphIssues } from './use-graph-issues'
import { useStoredEdit } from './use-stored-edit'
import { useWorkflowSimulation } from './use-workflow-simulation'
import type { NodeDefaults } from './workflow-canvas'

// Everything `EditorInner` knows that isn't markup. Split out for the same
// reason as `use-agent-editor-state`: a workflow has two halves with different
// lifecycles, and keeping them in one component is what lets them get confused.
//
//   • The DESCRIPTION is a plain server field. It is committed on blur, is not
//     part of the graph, and takes no place in the undo stack — renaming is
//     undoable, re-describing is not.
//   • The GRAPH is a draft. It is edited through an undo/redo history, kept in
//     localStorage while dirty, saved explicitly, and published deliberately.
//
// The canvas is imperative, so the editor talks to it through
// `useCanvasHandles` rather than props.

export type NodeSelection = {
  node: WorkflowGraph['nodes'][number]
  graph: WorkflowGraph
  /**
   * Element schema of the loop's list when the node is inside an iteration —
   * lets its inputs bind to the current `Item`'s fields.
   */
  itemSchema?: Record<string, unknown>
  insideIteration?: boolean
}

/**
 * Resolve the selected node — which may be a top-level node OR a node nested
 * inside an iteration container's subgraph (the canvas flattens those onto one
 * surface, but they live in `config.subgraph.nodes`). The returned `graph` is
 * the scope the inspector and data panel reason about: the main graph for a
 * top-level node, the iteration's subgraph for a child.
 *
 * A plain function rather than an inline `useMemo` body: the search has three
 * exits and React's compiler could not preserve the memoization around them, so
 * the whole component was dropped from optimization. Out here it is also
 * testable without a canvas.
 */
export function resolveSelection(
  graph: WorkflowGraph,
  selectedId: string | null,
): NodeSelection | null {
  if (!selectedId) return null
  const top = graph.nodes.find((n) => n.id === selectedId)
  if (top) return { node: top, graph }
  for (const n of graph.nodes) {
    if (n.kind !== 'iteration') continue
    const child = n.config.subgraph.nodes.find((c) => c.id === selectedId)
    if (child) {
      return {
        node: child,
        graph: n.config.subgraph,
        itemSchema: n.config.itemSchema,
        // Carried explicitly rather than inferred from `itemSchema` — that is
        // undefined until the author binds a list, which would read as
        // "top-level" for every child of an unbound iteration.
        insideIteration: true,
      }
    }
  }
  return null
}

export type WorkflowEditorStateOptions = {
  workflowId: string
  initialGraph: WorkflowGraph
  initialName: string
  initialDescription: string
  onPublished?: (result: { versionId: string; versionNumber: number }) => void
}

export function useWorkflowEditorState({
  workflowId,
  initialGraph,
  initialName,
  initialDescription,
  onPublished,
}: WorkflowEditorStateOptions) {
  const client = useWfClient()
  const modifierHeld = useModifierHold()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // The workflow's description — a plain field, committed to the server on blur
  // (not part of the graph/undo history or the unsaved-draft dirty state).
  const [description, setDescription] = useState(initialDescription)
  const committedDescRef = useRef(initialDescription)
  const [showVersions, setShowVersions] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [showPublish, setShowPublish] = useState(false)
  const canvas = useCanvasHandles()

  // Undo/redo history: owns the `graph`/`name` under edit, the snapshot stack,
  // dirty tracking, and keyboard undo/redo. Snapshots re-apply to the xyflow
  // canvas via its imperative ref.
  const history = useEditHistory(initialGraph, initialName, canvas.applyGraph)
  const { graph, name } = history

  // Offline preview of the user-facing progress UX (no run, no model spend).
  const sim = useWorkflowSimulation(graph)
  const dirty = history.dirty

  const tools = useTools()
  const versions = useVersions(workflowId)
  const saveDraft = useSaveDraft()
  const saveVersion = useSaveVersion()
  const update = useUpdateWorkflow()

  const defaults: NodeDefaults = useMemo(
    () => ({
      toolId:
        tools.data?.find((t) => t.kind === 'ai-tool')?.id ??
        tools.data?.[0]?.id ??
        '',
    }),
    [tools.data],
  )

  const selection = useMemo(
    () => resolveSelection(graph, selectedId),
    [graph, selectedId],
  )

  // Author-time issues (misconfigured nodes, missing data links, bad joins).
  // Non-blocking: they drive the Issues panel + node highlighting, not saving.
  const issues = useGraphIssues(graph)
  const invalidNodeIds = useMemo(() => invalidNodeIdsOf(issues), [issues])

  const loadVersion = useCallback(
    async (versionId: string) => {
      const v = await client.getVersion(versionId)
      setShowVersions(false)
      if (!v) return
      // Load as a fresh edit so it's recorded in history (undoable).
      history.loadSnapshot({
        graph: v.graph,
        label: `Loaded v${v.versionNumber}`,
      })
    },
    [client, history],
  )

  // Blurring the title commits the rename and records it as an undoable change.
  const commitRename = useCallback(() => {
    const trimmed = name.trim()
    const current = history.snapshots[history.index]?.name ?? initialName
    if (!trimmed || trimmed === current) {
      // Nothing meaningful changed — snap the field back to the committed name.
      history.setName(current)
      return
    }
    history.setName(trimmed)
    history.push({ graph, name: trimmed, label: `Renamed to "${trimmed}"` })
    update.mutate({ workflowId, name: trimmed })
  }, [name, history, initialName, graph, update, workflowId])

  // Blurring the description commits it to the server (no undo history entry).
  const commitDescription = useCallback(() => {
    const next = description.trim()
    if (next === committedDescRef.current) return
    committedDescRef.current = next
    setDescription(next)
    update.mutate({ workflowId, description: next || null })
  }, [description, update, workflowId])

  // Persist the in-flight edit to localStorage while dirty, and restore it on a
  // later visit — replayed through history so the restore itself is undoable.
  useStoredEdit(workflowId, {
    initialGraph,
    initialName,
    graph,
    name,
    dirty,
    onRestore: (stored) =>
      history.loadSnapshot({
        graph: stored.graph,
        name: stored.name,
        label: 'Restored unsaved edit',
      }),
  })

  const publishVersion = useCallback(
    (input: {
      changeNote: string
      aiSummary: { short: string; long: string } | null
    }) => {
      saveVersion.mutate(
        {
          workflowId,
          graph,
          changeNote: input.changeNote.trim() || undefined,
          // If the dialog already has the AI summary, store it with the version;
          // otherwise the server generates it in the background after publish.
          aiSummary: input.aiSummary ?? undefined,
        },
        {
          onSuccess: (result) => {
            history.markSaved()
            setShowPublish(false)
            onPublished?.(result)
          },
        },
      )
    },
    [saveVersion, workflowId, graph, history, onPublished],
  )

  const onSaveDraft = useCallback(() => {
    saveDraft.mutate(
      { workflowId, graph },
      { onSuccess: () => history.markSaved() },
    )
  }, [saveDraft, workflowId, graph, history])

  return {
    // graph draft
    history,
    graph,
    name,
    dirty,
    defaults,
    issues,
    invalidNodeIds,
    changeCount: history.snapshots.length - 1,
    // metadata
    description,
    setDescription,
    commitRename,
    commitDescription,
    // selection + imperative canvas handles
    selection,
    setSelectedId,
    ...canvas,
    // versions + publish
    versions,
    loadVersion,
    publishVersion,
    onSaveDraft,
    saving: saveDraft.isPending,
    publishing: saveVersion.isPending,
    publishError: saveVersion.error?.message ?? null,
    // chrome
    modifierHeld,
    update,
    sim,
    showVersions,
    setShowVersions,
    showHistory,
    setShowHistory,
    showPublish,
    setShowPublish,
  }
}
