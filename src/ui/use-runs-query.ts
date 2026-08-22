import { useCallback, useEffect, useMemo, useState } from 'react'

import type { WfRunListInput } from '../server/protocol'

import { useRuns, useWorkflows } from './hooks'
import { useDebounced } from './use-debounced'
import { useModifierHold } from './use-modifier-hold'
import { usePickedAt } from './use-now'

// The runs explorer's filters, paging, and the query they add up to.
//
// The one thing here that is not bookkeeping: the `since` bound is anchored to
// the instant the TIMEFRAME WAS PICKED, not read per render. Paging through
// results otherwise slides the window out from under the offsets, so page 2
// would be computed against a different "last 7 days" than page 1 and rows
// would silently repeat or vanish.

/** The relative windows the Time filter offers. */
export const TIMEFRAMES = [
  { value: '1h', label: 'Last hour', ms: 60 * 60_000 },
  { value: '24h', label: 'Last 24 hours', ms: 24 * 60 * 60_000 },
  { value: '7d', label: 'Last 7 days', ms: 7 * 24 * 60 * 60_000 },
  { value: '30d', label: 'Last 30 days', ms: 30 * 24 * 60 * 60_000 },
] as const

export type RunsQueryOptions = {
  /** Locks the workflow scope; when set, the Workflow filter is not offered. */
  workflowId?: string
  initialWorkflowId?: string
  pageSize: number
}

export function useRunsQuery({
  workflowId,
  initialWorkflowId,
  pageSize,
}: RunsQueryOptions) {
  const [searchRaw, setSearchRaw] = useState('')
  const search = useDebounced(searchRaw, 300)
  const [status, setStatus] = useState('')
  const [workflowFilter, setWorkflowFilter] = useState(initialWorkflowId ?? '')
  const [timeframe, pickedAt, setTimeframe] = usePickedAt('')
  const [page, setPage] = useState(0)

  // Any filter change returns to the first page.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- return to page 1 when a filter changes
    setPage(0)
  }, [search, status, workflowFilter, timeframe])

  const workflows = useWorkflows()

  // Cmd + Option reveals the purge control. A different combo from the everyday
  // Cmd + Control reveals, so an irreversible action can't surface by muscle
  // memory. Once revealed it LATCHES for the life of the page: the button (and
  // its confirm dialog) must survive letting go of the keys to click it.
  // Leaving the runs explorer unmounts it and hides the control again.
  const purgeHeld = useModifierHold('meta+alt')
  const [purgeRevealed, setPurgeRevealed] = useState(false)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- latch on a transient external input (a held modifier)
    if (purgeHeld) setPurgeRevealed(true)
  }, [purgeHeld])

  const input = useMemo<WfRunListInput>(() => {
    const frame = TIMEFRAMES.find((t) => t.value === timeframe)
    return {
      workflowId: workflowId ?? (workflowFilter || undefined),
      status: status || undefined,
      search: search.trim() || undefined,
      since: frame ? pickedAt - frame.ms : undefined,
      limit: pageSize,
      offset: page * pageSize,
    }
  }, [
    pickedAt,
    workflowId,
    workflowFilter,
    status,
    search,
    timeframe,
    page,
    pageSize,
  ])

  const runsQuery = useRuns(input)
  const result = runsQuery.data
  const runs = result?.runs ?? []
  const total = result?.total ?? 0

  const resetFilters = useCallback(() => {
    setSearchRaw('')
    setStatus('')
    setWorkflowFilter('')
    setTimeframe('')
  }, [setTimeframe])

  return {
    // filters
    searchRaw,
    setSearchRaw,
    status,
    setStatus,
    workflowFilter,
    setWorkflowFilter,
    timeframe,
    setTimeframe,
    workflows,
    hasFilters: !!search.trim() || !!status || !!workflowFilter || !!timeframe,
    resetFilters,
    purgeRevealed,
    // results
    isLoading: runsQuery.isLoading,
    runs,
    total,
    // paging
    page,
    setPage,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
    from: total === 0 ? 0 : page * pageSize + 1,
    to: Math.min(total, page * pageSize + runs.length),
    hasNext: (page + 1) * pageSize < total,
    hasPrev: page > 0,
  }
}
