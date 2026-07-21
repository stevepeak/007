import {
  Archive,
  Loader2,
  Sparkles,
  Workflow as WorkflowIcon,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import type { WorkflowGraph } from '../../engine'
import { ArchiveButton } from '../archive-button'
import { cn } from '../cn'
import { useWfClient, useWfComponents } from '../context'
import { SaveStateBadge } from '../save-state-badge'
import { Tooltip } from '../tooltip'
import {
  useSaveDraft,
  useSaveVersion,
  useSummarizeChanges,
  useTools,
  useUpdateWorkflow,
  useVersions,
  useWorkflow,
} from '../hooks'
import { WfShell } from '../shell'
import { BottomDock } from './bottom-dock'
import { HistoryMenu, VersionsMenu } from './editor-menus'
import { NodeInspector } from './node-inspector'
import { NodePalette } from './node-palette'
import { useEditHistory } from './use-edit-history'
import { useStoredEdit } from './use-stored-edit'
import { invalidNodeIdsOf, useGraphIssues } from './use-graph-issues'
import { WorkflowCanvas, type NodeDefaults } from './workflow-canvas'

// Interface #2 — the workflow editor. Loads a workflow's draft (or latest
// version) via the data client, renders the palette + xyflow canvas + per-node
// inspector, with rename, keyboard undo/redo, change history, version history,
// save-draft and an AI-summarized publish flow.

export type WorkflowEditorProps = {
  workflowId: string
  className?: string
  /** Called after a successful Publish, so the host can redirect to the version. */
  onPublished?: (result: { versionId: string; versionNumber: number }) => void
  /** Called after the workflow is archived, so the host can leave the editor. */
  onArchived?: () => void
}

export function WorkflowEditor({
  workflowId,
  className,
  onPublished,
  onArchived,
}: WorkflowEditorProps) {
  const { data, isLoading, error } = useWorkflow(workflowId)

  if (isLoading) {
    return (
      <div className={cn('p-4 text-sm text-neutral-500', className)}>
        Loading…
      </div>
    )
  }
  if (error) {
    return (
      <div className={cn('p-4 text-sm text-red-600', className)}>
        {(error as Error).message}
      </div>
    )
  }
  const initialGraph = data?.draft?.graph ?? data?.currentVersion?.graph
  if (!data || !initialGraph) {
    return (
      <div className={cn('p-4 text-sm text-neutral-500', className)}>
        Workflow has no graph yet.
      </div>
    )
  }

  return (
    <EditorInner
      workflowId={workflowId}
      initialGraph={initialGraph}
      initialName={data.workflow.name}
      initialDescription={data.workflow.description ?? ''}
      initialArchived={data.workflow.archived}
      className={className}
      onPublished={onPublished}
      onArchived={onArchived}
    />
  )
}

function EditorInner({
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
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // The workflow's description — a plain field, committed to the server on blur
  // (not part of the graph/undo history or the unsaved-draft dirty state).
  const [description, setDescription] = useState(initialDescription)
  const committedDesc = useRef(initialDescription)
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

  // Resolve the selected node — which may be a top-level node OR a node nested
  // inside an iteration container's subgraph (the canvas flattens those onto one
  // surface, but they live in `config.subgraph.nodes`). `graph` is the scope the
  // inspector/data-panel reason about: the main graph for top-level nodes, the
  // iteration's subgraph for a child.
  const selection = useMemo((): {
    node: WorkflowGraph['nodes'][number]
    graph: WorkflowGraph
    // Element schema of the loop's list when the node is inside an iteration —
    // lets its inputs bind to the current `Item`'s fields.
    itemSchema?: Record<string, unknown>
  } | null => {
    if (!selectedId) return null
    const top = graph.nodes.find((n) => n.id === selectedId)
    if (top) return { node: top, graph }
    for (const n of graph.nodes) {
      if (n.kind !== 'iteration') continue
      const child = n.config.subgraph.nodes.find((c) => c.id === selectedId)
      if (child)
        return {
          node: child,
          graph: n.config.subgraph,
          itemSchema: n.config.itemSchema,
        }
    }
    return null
  }, [selectedId, graph])
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
    if (next === committedDesc.current) return
    committedDesc.current = next
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
            ) : (
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
            )}

            <SaveStateBadge
              dirty={dirty}
              dirtyTooltip="You have unsaved changes (kept locally until you save)"
              savedTooltip="All changes saved"
            />

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
                currentWorkflowId={workflowId}
                onChange={(next) => patcherRef.current?.(next.id, next)}
              />
            ) : null}
          </div>
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
          error={(saveVersion.error as Error | null)?.message ?? null}
          onCancel={() => setShowPublish(false)}
          onConfirm={publishVersion}
        />
      ) : null}
    </>
  )
}

// Publish flow — the human writes their own note; an AI summary of the changes
// is generated alongside (shown when ready) but NEVER blocks publishing. If the
// user publishes before it lands, the server fills it in afterward.
function PublishDialog({
  workflowId,
  graph,
  publishing,
  error,
  onCancel,
  onConfirm,
}: {
  workflowId: string
  graph: WorkflowGraph
  publishing: boolean
  error: string | null
  onCancel: () => void
  onConfirm: (input: {
    changeNote: string
    aiSummary: { short: string; long: string } | null
  }) => void
}) {
  const { Button, Textarea } = useWfComponents()
  const summarize = useSummarizeChanges()
  const [note, setNote] = useState('')
  const [aiSummary, setAiSummary] = useState<{
    short: string
    long: string
  } | null>(null)

  // Kick off the AI summary once when the dialog opens. It populates the panel
  // below when it lands; it never gates the Publish button.
  const ranRef = useRef(false)
  useEffect(() => {
    if (ranRef.current) return
    ranRef.current = true
    summarize.mutate({ workflowId, graph }, { onSuccess: (r) => setAiSummary(r) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-lg border border-neutral-200 bg-white p-5 shadow-xl">
        <div className="mb-1 flex items-center gap-2">
          <Sparkles className="size-4 text-indigo-600" />
          <h2 className="text-base font-semibold text-neutral-900">
            Publish new version
          </h2>
        </div>
        <p className="mb-3 text-sm text-neutral-500">
          Add a note about what changed. We'll also summarize the changes with
          AI — you can publish without waiting for it.
        </p>

        {/* AI summary — fixed height so the dialog never resizes; content
            scrolls/crops when it's long. */}
        <div className="mb-3">
          <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-neutral-500">
            <Sparkles className="size-3 text-indigo-500" />
            AI summary of changes
          </div>
          <div className="h-24 overflow-y-auto rounded-md border border-neutral-200 bg-neutral-50 p-2 text-sm">
            {summarize.isPending ? (
              <div className="flex items-center gap-1.5 text-neutral-400">
                <Loader2 className="size-3.5 animate-spin" />
                Generating summary of changes…
              </div>
            ) : summarize.error ? (
              <span className="text-amber-600">
                Couldn't generate a summary (
                {(summarize.error as Error).message}). It'll be generated after
                you publish.
              </span>
            ) : aiSummary ? (
              <div className="space-y-1">
                <p className="font-medium text-neutral-800">
                  {aiSummary.short}
                </p>
                {aiSummary.long ? (
                  <p className="whitespace-pre-wrap text-neutral-500">
                    {aiSummary.long}
                  </p>
                ) : null}
              </div>
            ) : (
              <span className="text-neutral-400">No summary.</span>
            )}
          </div>
        </div>

        <label className="mb-1 block text-xs font-medium text-neutral-500">
          Your note (optional)
        </label>
        <Textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          placeholder="Describe the changes in this version…"
          className="w-full"
        />

        {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}

        <div className="mt-4 flex justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={onCancel}
            disabled={publishing}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => onConfirm({ changeNote: note, aiSummary })}
            disabled={publishing}
          >
            {publishing ? 'Publishing…' : 'Publish version'}
          </Button>
        </div>
      </div>
    </div>
  )
}
