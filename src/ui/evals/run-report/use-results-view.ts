import { useCallback, useMemo, useState } from 'react'

import type { WfEvalResultDTO } from '../../../server/protocol'
import { useModels } from '../../hooks'

import {
  buildResultRows,
  groupRows,
  minBy,
  pickBest,
  sortRows,
  type GroupBy,
  type SortState,
} from './model'

// What the results table is currently SHOWING: which rows, in what order,
// grouped how, with which ones expanded.
//
// The filter/sort/group state is view-only — none of it is persisted, and none
// of it changes the data. The one thing to keep straight is that the CROWNS are
// not view state: best / fastest / cheapest are computed over every row in the
// run, not the current filter, so filtering down to the failures doesn't crown
// the best of a bad lot.

export function useResultsView(results: WfEvalResultDTO[]) {
  const models = useModels()
  const modelById = useMemo(
    () => new Map((models.data ?? []).map((m) => [m.id, m])),
    [models.data],
  )

  const rows = useMemo(
    () => buildResultRows(results, (id) => modelById.get(id)?.label),
    [results, modelById],
  )

  const isMatrix = rows.some((r) => r.modelLabel != null || r.promptLabel != null)
  const goals = useMemo(
    () => [...new Set(rows.map((r) => r.goalName))].sort(),
    [rows],
  )
  const modelNames = useMemo(
    () =>
      [...new Set(rows.map((r) => r.modelLabel).filter(Boolean) as string[])].sort(),
    [rows],
  )
  const promptNames = useMemo(
    () =>
      [...new Set(rows.map((r) => r.promptLabel).filter(Boolean) as string[])].sort(),
    [rows],
  )

  const [status, setStatus] = useState('all')
  const [model, setModel] = useState('all')
  const [prompt, setPrompt] = useState('all')
  const [goal, setGoal] = useState('all')
  const [groupBy, setGroupBy] = useState<GroupBy>('sample')
  const [sort, setSort] = useState<SortState>({ key: 'status', dir: 'asc' })
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    () => new Set(),
  )

  const filtered = rows.filter(
    (r) =>
      (status === 'all' || r.status === status) &&
      (model === 'all' || r.modelLabel === model) &&
      (prompt === 'all' || r.promptLabel === prompt) &&
      (goal === 'all' || r.goalName === goal),
  )
  const sorted = sortRows(filtered, sort)

  // Crown markers, each a stable property of the whole run (computed over every
  // result, not the current filter) and shown only when there's more than one
  // row to rank: the best overall beside the sample name, the fastest beside
  // Speed, the cheapest beside Cost.
  const multi = rows.length > 1

  const toggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])
  const toggleGroup = useCallback((key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  return {
    rows,
    filtered,
    sorted,
    groups: groupBy === 'none' ? null : groupRows(sorted, groupBy),
    isMatrix,
    // chevron + status + sample (+ model + prompt) + score + duration + cost + tokens
    cols: 3 + (isMatrix ? 2 : 0) + 4,
    crowns: {
      bestId: multi ? pickBest(rows) : null,
      fastestId: multi ? minBy(rows, (r) => r.durationMs) : null,
      cheapestId: multi ? minBy(rows, (r) => r.costUsd) : null,
    },
    // filter options
    goals,
    modelNames,
    promptNames,
    // filter state
    status,
    setStatus,
    model,
    setModel,
    prompt,
    setPrompt,
    goal,
    setGoal,
    groupBy,
    setGroupBy,
    sort,
    setSort,
    // expansion
    expanded,
    toggle,
    collapsedGroups,
    toggleGroup,
  }
}
