import { keepPreviousData, useQuery } from '@tanstack/react-query'

import type { WfDashboardInput } from '../server/protocol'

import { useWfClient } from './context'
import { keys } from './hooks-shared'

/**
 * The home dashboard's rollup. `placeholderData` holds the previous window's
 * render while a new one loads, so switching timeframe dims the charts instead
 * of collapsing the layout to a skeleton.
 */
export function useDashboard(input: WfDashboardInput = {}) {
  const client = useWfClient()
  return useQuery({
    queryKey: keys.dashboard(input),
    queryFn: () => client.getDashboard(input),
    placeholderData: keepPreviousData,
    // Every figure is derived per request; a half-minute of staleness is
    // invisible to a human reading a trend and saves re-running six aggregates
    // on every tab focus.
    staleTime: 30_000,
  })
}
