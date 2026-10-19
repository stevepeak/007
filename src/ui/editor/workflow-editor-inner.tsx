import { Workflow as WorkflowIcon } from 'lucide-react'

import type { WorkflowGraph } from '../../engine'
import { WfShell } from '../shell'

import { BottomDock } from './bottom-dock'
import { NodeInspector } from './node-inspector'
import { NodePalette } from './node-palette'
import { HoverHighlightProvider } from './node-renderers-shared'
import { useWorkflowEditorState } from './use-workflow-editor-state'
import { WorkflowCanvas } from './workflow-canvas'
import { PublishDialog } from './workflow-editor-publish'
import { EditorToolbar, SimulationPreview } from './workflow-editor-toolbar'

// The workflow editor's LAYOUT: palette on the left, canvas in the middle,
// inspector on the right when something is selected, issues docked below.
// Everything it knows lives in `useWorkflowEditorState`; the header controls
// live in `workflow-editor-toolbar`.

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
  const state = useWorkflowEditorState({
    workflowId,
    initialGraph,
    initialName,
    initialDescription,
    onPublished,
  })
  const { selection } = state

  return (
    <>
      <WfShell
        className={className}
        titleIcon={<WorkflowIcon className="size-5 shrink-0 text-indigo-500" />}
        assetLabel="Workflow"
        crumbs={[
          {
            editable: {
              value: state.name,
              onChange: state.history.setName,
              onCommit: state.commitRename,
              ariaLabel: 'Workflow name',
            },
          },
        ]}
        descriptionEditable={{
          value: state.description,
          onChange: state.setDescription,
          onCommit: state.commitDescription,
          ariaLabel: 'Workflow description',
        }}
        actions={
          <EditorToolbar
            state={state}
            workflowId={workflowId}
            archived={initialArchived}
            onArchived={onArchived}
          />
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
                  defaults={state.defaults}
                  invalidNodeIds={state.invalidNodeIds}
                  onChange={state.history.recordCanvasChange}
                  onSelectionChange={state.setSelectedId}
                  registerNodePatcher={state.registerNodePatcher}
                  registerApplyGraph={state.registerApplyGraph}
                  registerSelectNode={state.registerSelectNode}
                />
              </div>
              {selection ? (
                <NodeInspector
                  node={selection.node}
                  graph={selection.graph}
                  itemSchema={selection.itemSchema}
                  insideIteration={selection.insideIteration}
                  currentWorkflowId={workflowId}
                  onChange={state.patchNode}
                />
              ) : null}
            </div>
          </HoverHighlightProvider>
          <BottomDock
            node={selection?.node ?? null}
            graph={selection?.graph ?? state.graph}
            issues={state.issues}
            itemSchema={selection?.itemSchema}
            onSelectNode={state.selectNode}
          />
        </div>
      </WfShell>

      {state.showPublish ? (
        <PublishDialog
          workflowId={workflowId}
          graph={state.graph}
          publishing={state.publishing}
          error={state.publishError}
          onCancel={() => state.setShowPublish(false)}
          onConfirm={state.publishVersion}
        />
      ) : null}

      <SimulationPreview sim={state.sim} />
    </>
  )
}
