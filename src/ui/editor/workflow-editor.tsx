import { useWorkflow } from '../hooks'
import { PageQueryState } from '../query-state'

import { EditorInner } from './workflow-editor-inner'

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
  const query = useWorkflow(workflowId)

  return (
    <PageQueryState
      query={query}
      className={className}
      isEmpty={(data) => !(data?.draft?.graph ?? data?.currentVersion?.graph)}
      emptyText="Workflow has no graph yet."
    >
      {(data) => {
        const initialGraph = data.draft?.graph ?? data.currentVersion?.graph
        return initialGraph ? (
          <EditorInner
            workflowId={workflowId}
            initialGraph={initialGraph}
            initialName={data.workflow.name}
            initialDescription={data.workflow.description ?? ''}
            initialArchived={data.workflow.archived}
            initialBaseVersionNumber={data.currentVersion?.versionNumber ?? 0}
            className={className}
            onPublished={onPublished}
            onArchived={onArchived}
          />
        ) : null
      }}
    </PageQueryState>
  )
}
