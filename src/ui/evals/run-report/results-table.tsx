import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Crown,
} from 'lucide-react'
import { Fragment, useMemo, useState } from 'react'

import type { WfEvalResultDTO } from '../../../server/protocol'
import { cn } from '../../cn'
import { formatDurationMs, formatTokens, formatUsd } from '../../cost'
import { useModels } from '../../hooks'
import { PassRate, Score } from '../shared'

import { StatusDot } from './atoms'
import {
  buildResultRows,
  cellKey,
  groupRows,
  minBy,
  pickBest,
  sortRows,
  type GroupBy,
  type ResultRow,
  type SortKey,
  type SortState,
} from './model'
import { ResultDetail } from './result-detail'

// The results table: one row per test, with group-by, sort, filters, an
// expandable per-check detail, and crowns on the best / fastest / cheapest tests.
export function ResultsTable({
  results,
  highlightedCell,
}: {
  results: WfEvalResultDTO[]
  /** Matrix cell key to highlight — every row in that cell tints (from card hover). */
  highlightedCell?: string | null
}) {
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
  const goals = useMemo(() => [...new Set(rows.map((r) => r.goalName))].sort(), [rows])
  const modelNames = useMemo(
    () => [...new Set(rows.map((r) => r.modelLabel).filter(Boolean) as string[])].sort(),
    [rows],
  )
  const promptNames = useMemo(
    () => [...new Set(rows.map((r) => r.promptLabel).filter(Boolean) as string[])].sort(),
    [rows],
  )

  const [status, setStatus] = useState('all')
  const [model, setModel] = useState('all')
  const [prompt, setPrompt] = useState('all')
  const [goal, setGoal] = useState('all')
  const [groupBy, setGroupBy] = useState<GroupBy>('sample')
  const [sort, setSort] = useState<SortState>({ key: 'status', dir: 'asc' })
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())

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
  // test to rank: the best overall beside the test name, the fastest beside
  // Speed, the cheapest beside Cost.
  const multi = rows.length > 1
  const bestId = multi ? pickBest(rows) : null
  const fastestId = multi ? minBy(rows, (r) => r.durationMs) : null
  const cheapestId = multi ? minBy(rows, (r) => r.costUsd) : null

  const groups = groupBy === 'none' ? null : groupRows(sorted, groupBy)

  const cols = 3 + (isMatrix ? 2 : 0) + 4 // chevron+status+sample (+model+prompt) +score+dur+cost+tokens
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const toggleGroup = (key: string) =>
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const sortOptions: { value: SortKey; label: string }[] = [
    { value: 'status', label: 'Status' },
    { value: 'sample', label: 'Test' },
    ...(isMatrix
      ? ([
          { value: 'model', label: 'Model' },
          { value: 'prompt', label: 'Prompt' },
        ] as const)
      : []),
    { value: 'score', label: 'Score' },
    { value: 'duration', label: 'Speed' },
    { value: 'cost', label: 'Cost' },
    { value: 'tokens', label: 'Tokens' },
  ]

  // One test row + its expandable detail, shared by the flat and grouped views.
  const renderRow = (r: ResultRow) => {
    const open = expanded.has(r.result.id)
    // Does this row belong to the matrix cell a summary card is hovering?
    const lit =
      highlightedCell != null &&
      cellKey(r.result.modelId, r.result.promptLabel) === highlightedCell
    return (
      <Fragment key={r.result.id}>
        <tr
          onClick={() => toggle(r.result.id)}
          className={cn(
            'cursor-pointer align-middle transition hover:bg-neutral-50',
            open && 'bg-neutral-50',
            lit && 'bg-emerald-50 hover:bg-emerald-50',
          )}
        >
          <td className="pl-3 text-neutral-400">
            {open ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronRight className="size-3.5" />
            )}
          </td>
          <td className="py-2 pr-3">
            <StatusDot status={r.status} />
          </td>
          <td className="max-w-[16rem] py-2 pr-3 font-medium text-neutral-800">
            <span className="flex min-w-0 items-center gap-1.5">
              {r.result.id === bestId && (
                <Crown className="size-3.5 shrink-0 text-amber-500" aria-label="Best results" />
              )}
              <span className="truncate">{r.sampleName}</span>
            </span>
          </td>
          {isMatrix && (
            <td className="max-w-[10rem] truncate py-2 pr-3 text-neutral-600">
              {r.modelLabel ?? '—'}
            </td>
          )}
          {isMatrix && (
            <td className="max-w-[10rem] truncate py-2 pr-3 text-neutral-500">
              {r.promptLabel ?? '—'}
            </td>
          )}
          <td className="py-2 pr-3 text-right tabular-nums">
            <Score value={r.score} />
          </td>
          <td className="py-2 pr-3 text-right tabular-nums text-neutral-600">
            <span className="inline-flex items-center justify-end gap-1">
              {r.result.id === fastestId && (
                <Crown className="size-3 shrink-0 text-amber-500" aria-label="Fastest" />
              )}
              {r.durationMs != null ? formatDurationMs(r.durationMs) : '—'}
            </span>
          </td>
          <td className="py-2 pr-3 text-right tabular-nums text-neutral-600">
            <span className="inline-flex items-center justify-end gap-1">
              {r.result.id === cheapestId && (
                <Crown className="size-3 shrink-0 text-amber-500" aria-label="Cheapest" />
              )}
              {formatUsd(r.costUsd)}
            </span>
          </td>
          <td className="py-2 pr-4 text-right tabular-nums text-neutral-500">
            {r.tokens != null ? formatTokens(r.tokens) : '—'}
          </td>
        </tr>
        {open && (
          <tr className="bg-neutral-50/60">
            <td colSpan={cols} className="px-4 pb-3 pt-1">
              <ResultDetail row={r} />
            </td>
          </tr>
        )}
      </Fragment>
    )
  }

  const subtitle = `${filtered.length}${filtered.length !== rows.length ? ` of ${rows.length}` : ''} test${rows.length === 1 ? '' : 's'}`

  return (
    <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
      {/* Static header — the Results section no longer collapses. */}
      <div className="flex w-full items-center gap-2 px-4 py-2.5">
        <span className="text-sm font-semibold text-neutral-900">Results</span>
        <span className="text-xs text-neutral-400">{subtitle}</span>
      </div>
      {/* Group / sort / filter toolbar */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-neutral-100 px-4 py-2.5">
        <FilterSelect
          label="Group"
          value={groupBy}
          onChange={(v) => setGroupBy(v as GroupBy)}
          options={[
            { value: 'none', label: 'None' },
            { value: 'sample', label: 'Test name' },
            { value: 'status', label: 'Pass / fail' },
            ...(isMatrix
              ? [
                  { value: 'model', label: 'Model' },
                  { value: 'prompt', label: 'Prompt' },
                ]
              : []),
          ]}
        />
        <div className="flex items-center gap-1.5">
          <FilterSelect
            label="Sort"
            value={sort.key}
            onChange={(v) => setSort({ key: v as SortKey, dir: sort.dir })}
            options={sortOptions}
          />
          <button
            type="button"
            aria-label={sort.dir === 'asc' ? 'Ascending' : 'Descending'}
            onClick={() =>
              setSort({ key: sort.key, dir: sort.dir === 'asc' ? 'desc' : 'asc' })
            }
            className="inline-flex size-6 items-center justify-center rounded-md border border-neutral-200 bg-white text-neutral-500 transition hover:border-neutral-300 hover:text-neutral-800"
          >
            {sort.dir === 'asc' ? (
              <ArrowUp className="size-3.5" />
            ) : (
              <ArrowDown className="size-3.5" />
            )}
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <FilterSelect
            label="Status"
            value={status}
            onChange={setStatus}
            options={[
              { value: 'all', label: 'All' },
              { value: 'pass', label: 'Passed' },
              { value: 'fail', label: 'Failed' },
              { value: 'error', label: 'Errored' },
            ]}
          />
          {isMatrix && modelNames.length > 1 && (
            <FilterSelect
              label="Model"
              value={model}
              onChange={setModel}
              options={[
                { value: 'all', label: 'All' },
                ...modelNames.map((m) => ({ value: m, label: m })),
              ]}
            />
          )}
          {isMatrix && promptNames.length > 1 && (
            <FilterSelect
              label="Prompt"
              value={prompt}
              onChange={setPrompt}
              options={[
                { value: 'all', label: 'All' },
                ...promptNames.map((p) => ({ value: p, label: p })),
              ]}
            />
          )}
          {goals.length > 1 && (
            <FilterSelect
              label="Goal"
              value={goal}
              onChange={setGoal}
              options={[
                { value: 'all', label: 'All' },
                ...goals.map((g) => ({ value: g, label: g })),
              ]}
            />
          )}
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="px-4 py-6 text-sm text-neutral-400">No results yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-neutral-200 text-left text-[11px] uppercase tracking-wide text-neutral-400">
                <th className="w-6" />
                <Th label="Status" k="status" sort={sort} setSort={setSort} />
                <Th label="Test" k="sample" sort={sort} setSort={setSort} />
                {isMatrix && <Th label="Model" k="model" sort={sort} setSort={setSort} />}
                {isMatrix && <Th label="Prompt" k="prompt" sort={sort} setSort={setSort} />}
                <Th label="Score" k="score" sort={sort} setSort={setSort} align="right" />
                <Th label="Speed" k="duration" sort={sort} setSort={setSort} align="right" />
                <Th label="Cost" k="cost" sort={sort} setSort={setSort} align="right" />
                <Th label="Tokens" k="tokens" sort={sort} setSort={setSort} align="right" />
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {groups == null
                ? sorted.map(renderRow)
                : groups.map((g) => {
                    const collapsed = collapsedGroups.has(g.key)
                    const passed = g.rows.filter((r) => r.status === 'pass').length
                    return (
                      <Fragment key={g.key}>
                        <tr
                          onClick={() => toggleGroup(g.key)}
                          className="cursor-pointer bg-neutral-100/70 transition hover:bg-neutral-100"
                        >
                          <td colSpan={cols} className="px-3 py-1.5">
                            <div className="flex items-center gap-2 text-xs font-semibold text-neutral-600">
                              {collapsed ? (
                                <ChevronRight className="size-3.5 text-neutral-400" />
                              ) : (
                                <ChevronDown className="size-3.5 text-neutral-400" />
                              )}
                              {groupBy === 'status' ? (
                                <StatusDot status={g.key} />
                              ) : (
                                <span className="text-neutral-700">{g.label}</span>
                              )}
                              <PassRate passed={passed} total={g.rows.length} />
                            </div>
                          </td>
                        </tr>
                        {!collapsed && g.rows.map(renderRow)}
                      </Fragment>
                    )
                  })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// A sortable column header — clicking toggles/sets the sort, mirroring the Sort
// dropdown (both drive the same state).
function Th({
  label,
  k,
  sort,
  setSort,
  align,
}: {
  label: string
  k: SortKey
  sort: SortState
  setSort: (s: SortState) => void
  align?: 'right'
}) {
  const active = sort.key === k
  return (
    <th className={cn('py-1.5 pr-3 font-medium', align === 'right' && 'text-right')}>
      <button
        type="button"
        onClick={() =>
          setSort({ key: k, dir: active && sort.dir === 'asc' ? 'desc' : 'asc' })
        }
        className={cn(
          'inline-flex items-center gap-1 uppercase tracking-wide transition hover:text-neutral-700',
          align === 'right' && 'flex-row-reverse',
          active && 'text-neutral-700',
        )}
      >
        {label}
        {active &&
          (sort.dir === 'asc' ? (
            <ArrowUp className="size-3" />
          ) : (
            <ArrowDown className="size-3" />
          ))}
      </button>
    </th>
  )
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
}) {
  return (
    <label className="inline-flex items-center gap-1.5 text-xs text-neutral-400">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-neutral-200 bg-white px-2 py-1 text-xs text-neutral-700 outline-none transition focus:border-neutral-400"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}
