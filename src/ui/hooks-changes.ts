import { useQuery } from '@tanstack/react-query'

import type { WfChangeListInput } from '../server/protocol'

import { useWfClient } from './context'
import { keys } from './hooks-shared'

// The change feed. One hook, because "everything" and "this agent's history" are
// the same query with a different filter — and the global feed is just the
// unfiltered case rather than a separate endpoint.

export function useChanges(input: WfChangeListInput = {}) {
  const client = useWfClient()
  return useQuery({
    queryKey: keys.changes(input),
    queryFn: () => client.listChanges(input),
  })
}
