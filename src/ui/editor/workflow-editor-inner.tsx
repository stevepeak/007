import {
  Archive,
  Play,
  Redo2,
  Undo2,
  Workflow as WorkflowIcon,
  X,
} from 'lucide-react'
import { useMemo, useRef, useState } from 'react'

import type { WorkflowGraph } from '../../engine'
import { ArchiveButton } from '../archive-button'
import { useWfClient, useWfComponents } from '../context'
import {
  useSaveDraft,
  useSaveVersion,
  useTools,
  useUpdateWorkflow,
  useVersions,
} from '../hooks'
import { WorkflowRunProgress } from '../run-progress-view'
import { SaveStateBadge } from '../save-state-badge'
import { WfShell } from '../shell'
import { Tooltip } from '../tooltip'
import { useModifierHold } from '../use-modifier-hold'

import { BottomDock } from './bottom-dock'
import { HistoryMenu, VersionsMenu } from './editor-menus'
import { NodeInspector } from './node-inspector'
import { NodePalette } from './node-palette'
import { HoverHighlightProvider } from './node-renderers-shared'
import { useEditHistory } from './use-edit-history'
import { invalidNodeIdsOf, useGraphIssues } from './use-graph-issues'
import { useStoredEdit } from './use-stored-edit'
import { useWorkflowSimulation } from './use-workflow-simulation'
import { WorkflowCanvas, type NodeDefaults } from './workflow-canvas'
import { PublishDialog } from './workflow-editor-publish'

type NodeSelection = {
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
function resolveSelection(
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

export function EditorInner({
  workflowId,
  initialGraph,
  initialName,
  initialDescription,
  initialArchived,
  className,
  onPublished,
  onArchived,
}: {
  workflowId: string
  initialGraph: WorkflowGraph
  initialName: string
  initialDescription: string
  initialArchived: boolean
  className?: string
  onPublished?: (result: { versionId: string; versionNumber: number }) => void
  onArchived?: () => void
}) {
  const { Button } = useWfComponents()
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
  const patcherRef = useRef<
    ((nodeId: string, next: WorkflowGraph['nodes'][number]) => void) | null
  >(null)
  const applyGraphRef = useRef<((g: WorkflowGraph) => void) | null>(null)
  const selectNodeRef = useRef<((nodeId: string) => void) | null>(null)

  // Undo/redo history: owns the `graph`/`name` under edit, the snapshot stack,
  // dirty tracking, and keyboard undo/redo. Snapshots re-apply to the xyflow
  // canvas via its imperative ref.
  const history = useEditHistory(initialGraph, initialName, (g) =>
    applyGraphRef.current?.(g),
  )
  const { graph, name } = history

  // Offline preview of the user-facing progress UX (no run, no model spend).
  const sim = useWorkflowSimulation(graph)
  const dirty = history.dirty

  const tools = useTools()
  const versions = useVersions(workflowId)
  const saveDraft = useSaveDraft()
  const saveVersion = useSaveVersion()
  const update = useUpdateWorkflow()

  const defaults: NodeDefaults = {
    toolId:
      tools.data?.find((t) => t.kind === 'ai-tool')?.id ??
      tools.data?.[0]?.id ??
      '',
  }

  const selection = useMemo(
    () => resolveSelection(graph, selectedId),
    [graph, selectedId],
  )
  const selected = selection?.node ?? null

  // Author-time issues (misconfigured nodes, missing data links, bad joins).
  // Non-blocking: they drive the Issues panel + node highlighting, not saving.
  const issues = useGraphIssues(graph)
  const invalidNodeIds = useMemo(() => invalidNodeIdsOf(issues), [issues])

  async function loadVersion(versionId: string) {
    const v = await client.getVersion(versionId)
    setShowVersions(false)
    if (!v) return
    // Load as a fresh edit so it's recorded in history (undoable).
    history.loadSnapshot({ graph: v.graph, label: `Loaded v${v.versionNumber}` })
  }

  // Blurring the title commits the rename and records it as an undoable change.
  function commitRename() {
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
  }

  // Blurring the description commits it to the server (no undo history entry).
  function commitDescription() {
    const next = description.trim()
    if (next === committedDescRef.current) return
    committedDescRef.current = next
    setDescription(next)
    update.mutate({ workflowId, description: next || null })
  }

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

  function publishVersion(input: {
    changeNote: string
    aiSummary: { short: string; long: string } | null
  }) {
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
  }

  const changeCount = history.snapshots.length - 1

  return (
    <>
      <WfShell
        className={className}
        titleIcon={<WorkflowIcon className="size-5 shrink-0 text-indigo-500" />}
        assetLabel="Workflow"
        crumbs={[
          {
            editable: {
              value: name,
              onChange: history.setName,
              onCommit: commitRename,
              ariaLabel: 'Workflow name',
            },
          },
        ]}
        descriptionEditable={{
          value: description,
          onChange: setDescription,
          onCommit: commitDescription,
          ariaLabel: 'Workflow description',
        }}
        actions={
          <>
            {initialArchived ? (
              <>
                <Tooltip
                  side="bottom"
                  content="This workflow is archived — it won't run when its event fires."
                >
                  <span className="flex items-center gap-1.5 rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-500">
                    <Archive className="size-3" />
                    Archived
                  </span>
                </Tooltip>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    update.mutate({ workflowId, archived: false })
                  }
                  disabled={update.isPending}
                >
                  Unarchive
                </Button>
              </>
            ) : modifierHeld ? (
              <ArchiveButton
                title="Archive workflow"
                confirmLabel="Hold to archive"
                description={
                  <>
                    Archive <strong>{name || 'this workflow'}</strong>? It will
                    be removed from the Workflows list and will no longer run
                    when its assigned event fires. Its versions and run history
                    are kept, and you can unarchive it later.
                  </>
                }
                onConfirm={() => {
                  update.mutate({ workflowId, archived: true })
                  onArchived?.()
                }}
              />
            ) : null}

            <SaveStateBadge
              dirty={dirty}
              dirtyTooltip="You have unsaved changes (kept locally until you save)"
              savedTooltip="All changes saved"
            />

            <Tooltip
              side="bottom"
              content={
                history.canUndo
                  ? `Undo "${history.undoLabel}"`
                  : 'Nothing to undo'
              }
            >
              <Button
                variant="outline"
                size="sm"
                disabled={!history.canUndo}
                onClick={() => history.undo()}
                aria-label="Undo"
              >
                <Undo2 className="size-4" />
              </Button>
            </Tooltip>
            <Tooltip
              side="bottom"
              content={
                history.canRedo
                  ? `Redo "${history.redoLabel}"`
                  : 'Nothing to redo'
              }
            >
              <Button
                variant="outline"
                size="sm"
                disabled={!history.canRedo}
                onClick={() => history.redo()}
                aria-label="Redo"
              >
                <Redo2 className="size-4" />
              </Button>
            </Tooltip>

            <HistoryMenu
              open={showHistory}
              onToggle={() => {
                setShowHistory((s) => !s)
                setShowVersions(false)
              }}
              snapshots={history.snapshots}
              currentIndex={history.index}
              changeCount={changeCount}
              onSelect={(idx) => {
                history.applySnapshot(idx)
                setShowHistory(false)
              }}
            />

            <VersionsMenu
              open={showVersions}
              onToggle={() => {
                setShowVersions((s) => !s)
                setShowHistory(false)
              }}
              versions={versions.data}
              onSelect={(id) => void loadVersion(id)}
            />

            <Tooltip
              side="bottom"
              content="Preview the progress your users will see as this workflow runs — no run, no cost."
            >
              <Button
                variant="outline"
                size="sm"
                onClick={sim.start}
                aria-label="Simulate progress"
              >
                <Play className="size-4" />
                Simulate
              </Button>
            </Tooltip>

            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                saveDraft.mutate(
                  { workflowId, graph },
                  { onSuccess: () => history.markSaved() },
                )
              }
              disabled={saveDraft.isPending}
            >
              {saveDraft.isPending ? 'Saving…' : 'Save draft'}
            </Button>
            <Button
              size="sm"
              onClick={() => setShowPublish(true)}
              disabled={saveVersion.isPending}
            >
              Publish
            </Button>
          </>
        }
      >
        <div className="flex h-full min-h-0 flex-col">
          {/* One hover-highlight scope over both canvas and inspector: hovering a
              binding's source in the inspector illuminates that node on the canvas. */}
          <HoverHighlightProvider>
          <div className="flex min-h-0 flex-1">
            <NodePalette />
            <div className="relative flex-1">
              <WorkflowCanvas
                graph={initialGraph}
                defaults={defaults}
                invalidNodeIds={invalidNodeIds}
                onChange={history.recordCanvasChange}
                onSelectionChange={setSelectedId}
                registerNodePatcher={(patch) => {
                  patcherRef.current = patch
                }}
                registerApplyGraph={(apply) => {
                  applyGraphRef.current = apply
                }}
                registerSelectNode={(select) => {
                  selectNodeRef.current = select
                }}
              />
            </div>
            {selection ? (
              <NodeInspector
                node={selection.node}
                graph={selection.graph}
                itemSchema={selection.itemSchema}
                insideIteration={selection.insideIteration}
                currentWorkflowId={workflowId}
                onChange={(next) => patcherRef.current?.(next.id, next)}
              />
            ) : null}
          </div>
          </HoverHighlightProvider>
          <BottomDock
            node={selected}
            graph={selection?.graph ?? graph}
            issues={issues}
            itemSchema={selection?.itemSchema}
            onSelectNode={(nodeId) => selectNodeRef.current?.(nodeId)}
          />
        </div>
      </WfShell>

      {showPublish ? (
        <PublishDialog
          workflowId={workflowId}
          graph={graph}
          publishing={saveVersion.isPending}
          error={(saveVersion.error)?.message ?? null}
          onCancel={() => setShowPublish(false)}
          onConfirm={publishVersion}
        />
      ) : null}

      {/* Floating, toast-like preview of the simulated progress — this is the
          same WorkflowRunProgress component clients embed for real runs. */}
      {sim.active || sim.items.length > 0 ? (
        <div className="fixed bottom-4 right-4 z-50 w-80 rounded-lg border border-border bg-background shadow-lg">
          <div className="flex items-center justify-between px-3 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            <span>Progress preview</span>
            <button
              type="button"
              aria-label="Close preview"
              onClick={sim.dismiss}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          </div>
          <div className="p-2">
            <WorkflowRunProgress
              items={sim.items}
              progress={sim.progress}
              status={sim.status}
            />
          </div>
        </div>
      ) : null}
    </>
  )
}
