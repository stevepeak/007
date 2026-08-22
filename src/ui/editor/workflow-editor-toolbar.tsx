import { Archive, Play, Redo2, Undo2, X } from 'lucide-react'

import { ArchiveButton } from '../archive-button'
import { useWfComponents } from '../context'
import { WorkflowRunProgress } from '../run-progress-view'
import { SaveStateBadge } from '../save-state-badge'
import { Tooltip } from '../tooltip'

import { HistoryMenu, VersionsMenu } from './editor-menus'
import type { useWorkflowEditorState } from './use-workflow-editor-state'

type EditorState = ReturnType<typeof useWorkflowEditorState>

// The workflow editor's header actions. Takes the state object whole rather
// than a dozen props: every control here is a view onto one of its fields, and
// enumerating them was most of the noise this extraction removes.
export function EditorToolbar({
  state,
  workflowId,
  archived,
  onArchived,
}: {
  state: EditorState
  workflowId: string
  archived: boolean
  onArchived?: () => void
}) {
  const { Button } = useWfComponents()
  const { history, sim } = state

  return (
    <>
      <ArchiveControl
        state={state}
        workflowId={workflowId}
        archived={archived}
        onArchived={onArchived}
      />

      <SaveStateBadge
        dirty={state.dirty}
        dirtyTooltip="You have unsaved changes (kept locally until you save)"
        savedTooltip="All changes saved"
      />

      <Tooltip
        side="bottom"
        content={history.canUndo ? `Undo "${history.undoLabel}"` : 'Nothing to undo'}
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
        content={history.canRedo ? `Redo "${history.redoLabel}"` : 'Nothing to redo'}
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

      {/* The two menus are mutually exclusive: opening either closes the other,
          since they occupy the same corner and would otherwise overlap. */}
      <HistoryMenu
        open={state.showHistory}
        onToggle={() => {
          state.setShowHistory((s) => !s)
          state.setShowVersions(false)
        }}
        snapshots={history.snapshots}
        currentIndex={history.index}
        changeCount={state.changeCount}
        onSelect={(idx) => {
          history.applySnapshot(idx)
          state.setShowHistory(false)
        }}
      />

      <VersionsMenu
        open={state.showVersions}
        onToggle={() => {
          state.setShowVersions((s) => !s)
          state.setShowHistory(false)
        }}
        versions={state.versions.data}
        onSelect={(id) => void state.loadVersion(id)}
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
        onClick={state.onSaveDraft}
        disabled={state.saving}
      >
        {state.saving ? 'Saving…' : 'Save draft'}
      </Button>
      <Button
        size="sm"
        onClick={() => state.setShowPublish(true)}
        disabled={state.publishing}
      >
        Publish
      </Button>
    </>
  )
}

/**
 * Archive / unarchive. An archived workflow shows a badge and an Unarchive
 * button outright; archiving an ACTIVE one is hidden behind the modifier hold,
 * because it stops the workflow running on its event and is not the thing
 * anyone is reaching for in the header.
 */
function ArchiveControl({
  state,
  workflowId,
  archived,
  onArchived,
}: {
  state: EditorState
  workflowId: string
  archived: boolean
  onArchived?: () => void
}) {
  const { Button } = useWfComponents()
  const { update } = state

  if (archived) {
    return (
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
          onClick={() => update.mutate({ workflowId, archived: false })}
          disabled={update.isPending}
        >
          Unarchive
        </Button>
      </>
    )
  }

  if (!state.modifierHeld) return null

  return (
    <ArchiveButton
      title="Archive workflow"
      confirmLabel="Hold to archive"
      description={
        <>
          Archive <strong>{state.name || 'this workflow'}</strong>? It will be
          removed from the Workflows list and will no longer run when its
          assigned event fires. Its versions and run history are kept, and you
          can unarchive it later.
        </>
      }
      onConfirm={() => {
        update.mutate({ workflowId, archived: true })
        onArchived?.()
      }}
    />
  )
}

/**
 * Floating, toast-like preview of the simulated progress — the same
 * `WorkflowRunProgress` component clients embed for real runs, so what the
 * author previews here is literally what a user sees.
 */
export function SimulationPreview({ sim }: { sim: EditorState['sim'] }) {
  if (!sim.active && sim.items.length === 0) return null
  return (
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
  )
}
