import type { WfChangeListInput } from '../../server/protocol'
import { EmptyState } from '../evals/shared'
import { useChanges } from '../hooks'
import { QueryState } from '../query-state'

import { ChangeRow } from './change-row'

// The change feed. The same component serves the global view and an asset's own
// history — they differ only by filter, which is the point of the log being one
// table rather than a history column on each entity.

export function ActivityList({
  filter = {},
  emptyMessage = 'No changes recorded yet.',
  className,
}: {
  filter?: WfChangeListInput
  emptyMessage?: string
  className?: string
}) {
  const query = useChanges(filter)
  return (
    <div className={className}>
      <QueryState
        query={query}
        loading={<EmptyState message="Loading activity…" />}
        empty={<EmptyState message={emptyMessage} />}
        isEmpty={(rows) => (rows?.length ?? 0) === 0}
      >
        {(rows) => (
          <div>
            {rows.map((change, i) => (
              <ChangeRow key={change.id} change={change} muted={i > 0} />
            ))}
          </div>
        )}
      </QueryState>
    </div>
  )
}
