import { cn } from '../cn'
import { QueryState } from '../query-state'
import { useWorkflow } from '../hooks'
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
    <QueryState
      query={query}
      loading={
        <div className={cn('p-4 text-sm text-neutral-500', className)}>
          Loading…
        </div>
      }
      error={(error) => (
        <div className={cn('p-4 text-sm text-red-600', className)}>
          {error.message}
        </div>
      )}
      isEmpty={(data) => !(data?.draft?.graph ?? data?.currentVersion?.graph)}
      empty={
        <div className={cn('p-4 text-sm text-neutral-500', className)}>
          Workflow has no graph yet.
        </div>
      }
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
            className={className}
            onPublished={onPublished}
            onArchived={onArchived}
          />
        ) : null
      }}
    </QueryState>
  )
}
