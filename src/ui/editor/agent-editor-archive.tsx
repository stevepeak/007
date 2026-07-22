import { AlertTriangle, Archive, Loader2 } from 'lucide-react'

import { useWfComponents } from '../context'
import { HoldButton } from '../hold-button'
import { Modal } from '../modal'
import { useAgentReferences, useArchiveAgent } from '../hooks'
import { useOpenAsset } from '../nav'

// Archive flow — before letting the user retire an agent, check whether any
// workflow still references it (in its draft or latest published version). If so
// we BLOCK archiving and list those workflows so the user can go disconnect the
// agent first; only a truly unreferenced agent can be hold-to-archived.
export function ArchiveAgentDialog({
  agentId,
  agentName,
  onClose,
  onArchived,
}: {
  agentId: string
  agentName: string
  onClose: () => void
  onArchived: () => void
}) {
  const { Button } = useWfComponents()
  const openAsset = useOpenAsset()
  const refs = useAgentReferences(agentId, true)
  const archive = useArchiveAgent()

  const workflows = refs.data?.workflows ?? []
  const blocked = workflows.length > 0
  const archiveError = (archive.error as Error | null)?.message ?? null

  return (
    <Modal
      open
      onClose={onClose}
      title={
        <span className="flex items-center gap-1.5">
          <Archive className="size-4 text-neutral-500" />
          Archive agent
        </span>
      }
      panelClassName="w-full max-w-md rounded-lg border border-neutral-200 bg-white shadow-xl"
    >
      <div className="px-5 py-4 text-sm leading-relaxed text-neutral-600">
        {refs.isLoading ? (
          <span className="flex items-center gap-2 text-neutral-500">
            <Loader2 className="size-4 animate-spin" />
            Checking for workflows using this agent…
          </span>
        ) : refs.error ? (
          <span className="text-red-600">
            {(refs.error as Error).message}
          </span>
        ) : blocked ? (
          <div className="space-y-3">
            <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-amber-800">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>
                <strong>{agentName || 'This agent'}</strong> is used by{' '}
                <strong>
                  {workflows.length} workflow
                  {workflows.length === 1 ? '' : 's'}
                </strong>
                . Disconnect it from each before archiving.
              </span>
            </div>
            <ul className="divide-y divide-neutral-100 rounded-md border border-neutral-200">
              {workflows.map((wf) => (
                <li key={wf.id}>
                  <button
                    type="button"
                    onClick={() => openAsset(`${wf.id}/edit`)}
                    className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition hover:bg-neutral-50"
                  >
                    <span className="min-w-0 truncate text-neutral-800">
                      {wf.name || 'Untitled workflow'}
                    </span>
                    <span className="shrink-0 text-xs text-neutral-400">
                      Open →
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <span>
            Archive <strong>{agentName || 'this agent'}</strong>? It'll be
            removed from your agents list and can no longer be added to
            workflows. Existing runs are unaffected.
          </span>
        )}
        {archiveError ? (
          <p className="mt-2 text-xs text-red-600">{archiveError}</p>
        ) : null}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-neutral-200 px-5 py-3">
        <Button variant="outline" size="sm" onClick={onClose}>
          {blocked ? 'Close' : 'Cancel'}
        </Button>
        {!refs.isLoading && !refs.error && !blocked ? (
          <HoldButton
            size="md"
            tone="danger"
            title="Hold to archive"
            onHold={() => archive.mutate(agentId, { onSuccess: onArchived })}
          >
            <Archive className="size-4" />
            Hold to archive
          </HoldButton>
        ) : null}
      </div>
    </Modal>
  )
}
