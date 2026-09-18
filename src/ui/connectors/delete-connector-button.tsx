import { Trash2 } from 'lucide-react'

import type { ConnectorSummary } from '../../server/protocol'
import { ArchiveButton } from '../archive-button'
import { useDeleteConnector } from '../hooks-connectors'

// Deleting a connector is a hold-to-confirm, not a click: it takes the
// credential, the catalog, and every tool id an agent may be pointed at with
// it, and there is no archive to bring any of that back from.

export function DeleteConnectorButton({
  connector,
  onDeleted,
  className,
}: {
  connector: Pick<
    ConnectorSummary,
    'id' | 'label' | 'enabledToolCount' | 'connection'
  >
  /** Fired once the delete lands — a detail page uses it to leave. */
  onDeleted?: () => void
  className?: string
}) {
  const remove = useDeleteConnector()
  return (
    <ArchiveButton
      icon={Trash2}
      title="Delete connector"
      confirmLabel="Hold to delete"
      className={className}
      description={
        <>
          <p>
            Delete <strong>{connector.label}</strong>? This removes its tool
            catalog
            {connector.connection ? ' and the stored credential' : ''}, and
            can’t be undone.
          </p>
          {connector.enabledToolCount > 0 ? (
            <p className="mt-2">
              {connector.enabledToolCount} enabled tool
              {connector.enabledToolCount === 1 ? '' : 's'} will disappear from
              every agent and Tool node that uses{' '}
              {connector.enabledToolCount === 1 ? 'it' : 'them'} — those will
              fail until they’re re-pointed.
            </p>
          ) : null}
        </>
      }
      onConfirm={() => {
        remove.mutate({ connectorId: connector.id }, { onSuccess: onDeleted })
      }}
    />
  )
}
