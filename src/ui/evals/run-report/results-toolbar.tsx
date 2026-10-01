import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  XCircle,
} from 'lucide-react'

import { cn } from '../../cn'
import { FilterPill, FilterSelect } from '../../filters'

import type { GroupBy, SortKey, SortState } from './model'
import type { useResultsView } from './use-results-view'

type ResultsView = ReturnType<typeof useResultsView>

// Group / sort / filter controls for the results table. The matrix-only
// dimensions (model, prompt) are hidden entirely on a single-cell run, and each
// filter appears only once there is more than one value to choose between —
// a dropdown with one option is a control that can't do anything.
export function ResultsToolbar({ view }: { view: ResultsView }) {
  const { isMatrix, sort, setSort } = view

  const sortOptions: { value: SortKey; label: string }[] = [
    { value: 'status', label: 'Status' },
    { value: 'sample', label: 'Sample' },
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

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-neutral-100 px-4 py-2.5">
      <FilterSelect
        label="Group"
        value={view.groupBy}
        onChange={(v) => view.setGroupBy(v as GroupBy)}
        options={[
          { value: 'none', label: 'None' },
          { value: 'sample', label: 'Sample name' },
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
          onClick={() => {
            return setSort({
              key: sort.key,
              dir: sort.dir === 'asc' ? 'desc' : 'asc',
            })
          }}
          className="inline-flex size-6 items-center justify-center rounded-md border border-neutral-200 bg-white text-neutral-500 transition hover:border-neutral-300 hover:text-neutral-800"
        >
          {sort.dir === 'asc' ? (
            <ArrowUp className="size-3.5" />
          ) : (
            <ArrowDown className="size-3.5" />
          )}
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <FilterPill
          label="Status"
          value={view.status === 'all' ? '' : view.status}
          onChange={(v) => view.setStatus(v || 'all')}
          options={STATUS_OPTIONS}
        />
        {isMatrix && view.modelNames.length > 1 && (
          <FilterPill
            label="Model"
            value={view.model === 'all' ? '' : view.model}
            onChange={(v) => view.setModel(v || 'all')}
            options={plain(view.modelNames)}
          />
        )}
        {isMatrix && view.promptNames.length > 1 && (
          <FilterPill
            label="Prompt"
            value={view.prompt === 'all' ? '' : view.prompt}
            onChange={(v) => view.setPrompt(v || 'all')}
            options={plain(view.promptNames)}
          />
        )}
        {view.goals.length > 1 && (
          <FilterPill
            label="Goal"
            value={view.goal === 'all' ? '' : view.goal}
            onChange={(v) => view.setGoal(v || 'all')}
            options={plain(view.goals)}
          />
        )}
      </div>
    </div>
  )
}

const STATUS_OPTIONS = [
  { value: 'pass', label: 'Passed', Icon: CheckCircle2, tone: 'text-emerald-600' },
  { value: 'fail', label: 'Failed', Icon: XCircle, tone: 'text-red-600' },
  { value: 'error', label: 'Errored', Icon: AlertTriangle, tone: 'text-amber-600' },
].map(({ value, label, Icon, tone }) => ({
  value,
  label,
  node: (
    <span className="inline-flex items-center gap-1.5">
      <Icon className={cn('size-3.5', tone)} />
      {label}
    </span>
  ),
}))

/** Every distinct value as a pill option — "no filter" is the pill's unset state. */
function plain(values: string[]) {
  return values.map((v) => ({ value: v, label: v }))
}

// A sortable column header — clicking toggles/sets the sort, mirroring the Sort
// dropdown (both drive the same state).
export function Th({
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
    <th
      className={cn(
        'py-1.5 pr-3 font-medium',
        align === 'right' && 'text-right',
      )}
    >
      <button
        type="button"
        onClick={() => {
          return setSort({
            key: k,
            dir: active && sort.dir === 'asc' ? 'desc' : 'asc',
          })
        }}
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
