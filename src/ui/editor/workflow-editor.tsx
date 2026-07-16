import {
  GitBranch,
  History,
  Loader2,
  Sparkles,
  Workflow as WorkflowIcon,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import type { WorkflowGraph } from '../../engine'
import { cn } from '../cn'
import { useWfClient, useWfComponents } from '../context'
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
import { NodeInspector } from './node-inspector'
import { NodePalette } from './node-palette'
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
}

export function WorkflowEditor({
  workflowId,
  className,
  onPublished,
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
      className={className}
      onPublished={onPublished}
    />
  )
}

// One entry in the undo/redo change history. The workflow name lives here too
// (not in the graph), so renaming the title is undoable alongside graph edits.
// `label` is a short human description of what the change did.
type EditSnapshot = { graph: WorkflowGraph; name: string; label: string }

// Best-effort short description of a graph edit, for the change-history log.
function describeChange(prev: WorkflowGraph, next: WorkflowGraph): string {
  const prevNodes = new Map(prev.nodes.map((n) => [n.id, n]))
  const nextNodes = new Map(next.nodes.map((n) => [n.id, n]))
  for (const [id, n] of nextNodes) {
    if (!prevNodes.has(id)) return `Added ${n.kind} node`
  }
  for (const [id, n] of prevNodes) {
    if (!nextNodes.has(id)) return `Removed ${n.kind} node`
  }
  if (next.edges.length > prev.edges.length) return 'Connected nodes'
  if (next.edges.length < prev.edges.length) return 'Removed connection'
  let movedKind: string | null = null
  for (const [id, nn] of nextNodes) {
    const pn = prevNodes.get(id)
    if (!pn) continue
    const dataChanged =
      JSON.stringify({ label: pn.label, config: pn.config }) !==
      JSON.stringify({ label: nn.label, config: nn.config })
    if (dataChanged) return `Edited ${nn.kind} node`
    if (pn.position.x !== nn.position.x || pn.position.y !== nn.position.y) {
      movedKind = nn.kind
    }
  }
  if (movedKind) return `Moved ${movedKind} node`
  return 'Edited workflow'
}

// Unsaved edits are persisted to localStorage so navigating away and back
// doesn't lose work. Keyed per workflow; cleared once the edit is saved.
const EDIT_STORAGE_PREFIX = 'wf-sdk:edit:'
type StoredEdit = { graph: WorkflowGraph; name: string }

function readStoredEdit(workflowId: string): StoredEdit | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(EDIT_STORAGE_PREFIX + workflowId)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<StoredEdit>
    if (parsed && parsed.graph && typeof parsed.name === 'string') {
      return { graph: parsed.graph, name: parsed.name }
    }
    return null
  } catch {
    return null
  }
}

function writeStoredEdit(workflowId: string, edit: StoredEdit): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(
      EDIT_STORAGE_PREFIX + workflowId,
      JSON.stringify(edit),
    )
  } catch {
    // storage full / unavailable — best-effort only
  }
}

function clearStoredEdit(workflowId: string): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(EDIT_STORAGE_PREFIX + workflowId)
  } catch {
    // ignore
  }
}

// Commit-graph node for a change-history row: a dot on a connecting rail. The
// newest change is dark; older ones are a single muted grey tone.
function HistoryDot({ muted }: { muted?: boolean }) {
  return (
    <span className="relative flex w-3 shrink-0 justify-center self-stretch">
      <span className="absolute inset-y-0 w-px bg-neutral-200" />
      <span
        className={cn(
          'relative mt-2 size-2 rounded-full',
          muted ? 'bg-neutral-300' : 'bg-neutral-800',
        )}
      />
    </span>
  )
}

function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  return (
    !!el &&
    (el.tagName === 'INPUT' ||
      el.tagName === 'TEXTAREA' ||
      el.isContentEditable)
  )
}

function EditorInner({
  workflowId,
  initialGraph,
  initialName,
  initialDescription,
  className,
  onPublished,
}: {
  workflowId: string
  initialGraph: WorkflowGraph
  initialName: string
  initialDescription: string
  className?: string
  onPublished?: (result: { versionId: string; versionNumber: number }) => void
}) {
  const { Button } = useWfComponents()
  const client = useWfClient()
  const [graph, setGraph] = useState<WorkflowGraph>(initialGraph)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [name, setName] = useState(initialName)
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

  // Undo/redo history. `applyingRef` suppresses recording the change the canvas
  // re-emits when we programmatically apply a snapshot (undo/redo/version load).
  const historyRef = useRef<EditSnapshot[]>([
    { graph: initialGraph, name: initialName, label: 'Opened' },
  ])
  const indexRef = useRef(0)
  const applyingRef = useRef(false)
  // Which history index reflects the last-saved state (drives the dirty flag).
  const [savedIndex, setSavedIndex] = useState(0)
  // Bumped on any history mutation so the toolbar re-renders (refs alone don't).
  const [, forceRender] = useState(0)
  const bump = () => forceRender((n) => n + 1)

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

  // Push a new snapshot onto the history stack, truncating any redo tail.
  function pushSnapshot(snap: EditSnapshot) {
    const trimmed = historyRef.current.slice(0, indexRef.current + 1)
    trimmed.push(snap)
    historyRef.current = trimmed
    indexRef.current = trimmed.length - 1
    bump()
  }

  function onCanvasChange(next: WorkflowGraph) {
    setGraph(next)
    if (applyingRef.current) {
      applyingRef.current = false
      return
    }
    const prev = historyRef.current[indexRef.current]
    const label = prev ? describeChange(prev.graph, next) : 'Edited workflow'
    // Coalesce a run of drag emissions into a single "Moved" entry so the
    // change log stays readable (xyflow emits a change per drag tick).
    const atTip = indexRef.current === historyRef.current.length - 1
    if (atTip && label.startsWith('Moved') && prev?.label.startsWith('Moved')) {
      const copy = historyRef.current.slice()
      copy[indexRef.current] = { graph: next, name, label }
      historyRef.current = copy
      return
    }
    pushSnapshot({ graph: next, name, label })
  }

  function applySnapshot(index: number) {
    const snap = historyRef.current[index]
    if (!snap) return
    indexRef.current = index
    applyingRef.current = true
    applyGraphRef.current?.(snap.graph)
    setGraph(snap.graph)
    setName(snap.name)
    bump()
  }

  async function loadVersion(versionId: string) {
    const v = await client.getVersion(versionId)
    setShowVersions(false)
    if (!v) return
    // Load as a fresh edit so it's recorded in history (undoable).
    applyingRef.current = true
    applyGraphRef.current?.(v.graph)
    setGraph(v.graph)
    pushSnapshot({ graph: v.graph, name, label: `Loaded v${v.versionNumber}` })
  }

  // Blurring the title commits the rename and records it as an undoable change.
  function commitRename() {
    const trimmed = name.trim()
    const current = historyRef.current[indexRef.current]?.name ?? initialName
    if (!trimmed || trimmed === current) {
      // Nothing meaningful changed — snap the field back to the committed name.
      setName(current)
      return
    }
    setName(trimmed)
    pushSnapshot({ graph, name: trimmed, label: `Renamed to "${trimmed}"` })
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

  function undo() {
    if (indexRef.current > 0) applySnapshot(indexRef.current - 1)
  }
  function redo() {
    if (indexRef.current < historyRef.current.length - 1) {
      applySnapshot(indexRef.current + 1)
    }
  }

  const dirty = indexRef.current !== savedIndex

  // Keyboard undo/redo (the toolbar buttons were removed). Ignore when typing in
  // a field. Cmd/Ctrl+Z = undo, Cmd/Ctrl+Shift+Z or Ctrl+Y = redo.
  const undoRef = useRef(undo)
  const redoRef = useRef(redo)
  undoRef.current = undo
  redoRef.current = redo
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || isEditableTarget(e.target)) return
      const key = e.key.toLowerCase()
      if (key === 'z') {
        e.preventDefault()
        if (e.shiftKey) redoRef.current()
        else undoRef.current()
      } else if (key === 'y') {
        e.preventDefault()
        redoRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Restore an unsaved edit persisted from a previous visit (once, on mount).
  const restoredRef = useRef(false)
  useEffect(() => {
    if (restoredRef.current) return
    restoredRef.current = true
    const stored = readStoredEdit(workflowId)
    if (!stored) return
    if (
      JSON.stringify(stored.graph) === JSON.stringify(initialGraph) &&
      stored.name === initialName
    ) {
      return
    }
    applyingRef.current = true
    applyGraphRef.current?.(stored.graph)
    setGraph(stored.graph)
    setName(stored.name)
    pushSnapshot({
      graph: stored.graph,
      name: stored.name,
      label: 'Restored unsaved edit',
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflowId])

  // Persist the current edit while dirty; clear it once saved (or reverted).
  useEffect(() => {
    if (dirty) writeStoredEdit(workflowId, { graph, name })
    else clearStoredEdit(workflowId)
  }, [dirty, graph, name, workflowId])

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
          setSavedIndex(indexRef.current)
          setShowPublish(false)
          onPublished?.(result)
        },
      },
    )
  }

  const changeCount = historyRef.current.length - 1

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
              onChange: setName,
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
            <Tooltip
              side="bottom"
              content={
                dirty
                  ? 'You have unsaved changes (kept locally until you save)'
                  : 'All changes saved'
              }
            >
              <span
                className={cn(
                  'flex items-center gap-1.5 text-xs',
                  dirty ? 'text-amber-600' : 'text-neutral-400',
                )}
              >
                <span
                  className={cn(
                    'size-1.5 rounded-full',
                    dirty ? 'bg-amber-500' : 'bg-neutral-300',
                  )}
                />
                {dirty ? 'Unsaved' : 'Saved'}
              </span>
            </Tooltip>

            <div className="relative">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setShowHistory((s) => !s)
                  setShowVersions(false)
                }}
              >
                <History className="size-4" />
                History
                {changeCount > 0 ? (
                  <span className="ml-1 rounded-full bg-indigo-100 px-1.5 py-0.5 text-[11px] font-semibold text-indigo-700">
                    {changeCount}
                  </span>
                ) : null}
              </Button>
              {showHistory ? (
                <div className="absolute right-0 z-20 mt-1 max-h-80 w-72 overflow-y-auto rounded-md border border-neutral-200 bg-white shadow-lg">
                  {historyRef.current
                    .map((snap, idx) => ({ snap, idx }))
                    .reverse()
                    .map(({ snap, idx }, i) => (
                      <button
                        key={idx}
                        onClick={() => {
                          applySnapshot(idx)
                          setShowHistory(false)
                        }}
                        className={cn(
                          'flex w-full items-stretch gap-2 px-3 py-2 text-left text-sm hover:bg-neutral-50',
                          idx === indexRef.current && 'bg-indigo-50',
                        )}
                      >
                        <HistoryDot muted={i > 0} />
                        <span className="flex-1 truncate self-center">
                          {snap.label}
                        </span>
                        {idx === indexRef.current ? (
                          <span className="self-center text-xs text-indigo-600">
                            current
                          </span>
                        ) : null}
                      </button>
                    ))}
                </div>
              ) : null}
            </div>

            <div className="relative">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setShowVersions((s) => !s)
                  setShowHistory(false)
                }}
              >
                <GitBranch className="size-4" />
                Versions ({versions.data?.length ?? 0})
              </Button>
              {showVersions ? (
                <div className="absolute right-0 z-20 mt-1 max-h-72 w-72 overflow-y-auto rounded-md border border-neutral-200 bg-white shadow-lg">
                  {versions.data?.length === 0 ? (
                    <div className="p-3 text-sm text-neutral-500">
                      No versions yet.
                    </div>
                  ) : null}
                  {versions.data?.map((v) => (
                    <button
                      key={v.id}
                      onClick={() => void loadVersion(v.id)}
                      className="block w-full border-b border-neutral-100 px-3 py-2 text-left text-sm hover:bg-neutral-50"
                    >
                      <span className="font-medium">v{v.versionNumber}</span>
                      {v.changeNote ? (
                        <span className="text-neutral-600"> — {v.changeNote}</span>
                      ) : null}
                      {v.aiSummaryShort ? (
                        <span className="mt-0.5 flex items-start gap-1 text-xs text-neutral-500">
                          <Sparkles className="mt-0.5 size-3 shrink-0 text-indigo-500" />
                          <span className="line-clamp-2">
                            {v.aiSummaryShort}
                          </span>
                        </span>
                      ) : null}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                saveDraft.mutate(
                  { workflowId, graph },
                  { onSuccess: () => setSavedIndex(indexRef.current) },
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
                onChange={onCanvasChange}
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
