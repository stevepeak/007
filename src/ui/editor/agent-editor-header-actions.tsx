import { Archive, Check } from 'lucide-react'

import { useWfComponents } from '../context'
import { SaveStateBadge } from '../save-state-badge'
import { Tooltip } from '../tooltip'

import { HistoryMenu, VersionsMenu } from './editor-menus'
import type { useAgentDraft } from './use-agent-editor-state'

// The agent editor's header strip: save/publish, the version history menu, and
// the three transient notices that report what the draft is doing (unsaved,
// just published, failed to save).
//
// It takes the whole `useAgentDraft` return rather than a dozen props because
// every control here is a view of that one hook — spelling the fields out
// individually would be a second copy of its shape, kept in sync by hand.
export function AgentEditorHeaderActions({
  draft,
  onArchive,
}: {
  draft: ReturnType<typeof useAgentDraft>
  onArchive: () => void
}) {
  const { Button } = useWfComponents()

  return (
    <>
        <SaveStateBadge
          dirty={draft.dirty}
          dirtyTooltip="You have unsaved changes"
          savedTooltip="All configuration changes saved"
        />
        {draft.justPublished != null ? (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600">
            <Check className="size-3.5" />
            Published v{draft.justPublished}
          </span>
        ) : null}
        {draft.saveError ? (
          <span className="text-xs text-red-600">{draft.saveError}</span>
        ) : null}
        <Tooltip content="Archive" side="bottom">
          <button
            type="button"
            aria-label="Archive"
            onClick={onArchive}
            className="inline-flex size-8 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-800"
          >
            <Archive className="size-4" />
          </button>
        </Tooltip>
        <HistoryMenu
          open={draft.showHistory}
          onToggle={() => draft.setShowHistory((h) => !h)}
          snapshots={draft.snapshots}
          currentIndex={draft.historyIndex}
          changeCount={draft.snapshots.length - 1}
          onSelect={(index) => {
            draft.applySnapshot(index)
            draft.setShowHistory(false)
          }}
        />
        <VersionsMenu
          open={draft.showVersions}
          onToggle={() => draft.setShowVersions((v) => !v)}
          versions={draft.versions}
          onSelect={(id) => void draft.loadVersion(id)}
        />
        <Button
          variant="outline"
          size="sm"
          onClick={draft.onSaveDraft}
          disabled={draft.saving}
        >
          {draft.saving ? 'Saving…' : 'Save draft'}
        </Button>
        <Button
          size="sm"
          onClick={() => draft.setShowPublish(true)}
          disabled={draft.publishing}
        >
          Publish
        </Button>
    </>
  )
}
