import {
  Check,
  NotebookPen,
  RotateCcw,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
} from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'

import type { WfFeedbackRow } from '../server/protocol'

import { cn } from './cn'
import { useWfComponents } from './context'
import { formatTimestamp } from './cost'
import { useFeedback, useSetFeedbackAck } from './hooks-feedback'
import { useWfNav } from './nav'

// Firm/staff-side triage of thumbs feedback: every rated answer across the
// platform, newest-first, with filters (status/ack, thumbs, client, user,
// search) and group-by. Fully self-contained — renders off `wf_feedback`'s
// denormalized snapshots, so no host join is needed. Mounted as a WfApp section.

type GroupBy = 'none' | 'sentiment' | 'client' | 'user'
type AckState = 'all' | 'unacknowledged' | 'acknowledged'

const GROUP_OPTIONS: { value: GroupBy; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'sentiment', label: 'Thumbs' },
  { value: 'client', label: 'Client' },
  { value: 'user', label: 'User' },
]

const ACK_OPTIONS: { value: AckState; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'unacknowledged', label: 'Unacknowledged' },
  { value: 'acknowledged', label: 'Acknowledged' },
]

const RATING_OPTIONS = [
  { value: 'up', label: '👍 Thumbs up' },
  { value: 'down', label: '👎 Thumbs down' },
]

function raterLabel(row: WfFeedbackRow): string {
  return row.raterLabel || 'Unknown user'
}

export type FeedbackListProps = { className?: string }

export function FeedbackList({ className }: FeedbackListProps) {
  const [groupBy, setGroupBy] = useState<GroupBy>('sentiment')
  const [ackState, setAckState] = useState<AckState>('unacknowledged')
  const [ratings, setRatings] = useState<string[]>([])
  const [correlationIds, setCorrelationIds] = useState<string[]>([])
  const [raterIds, setRaterIds] = useState<string[]>([])
  const [search, setSearch] = useState('')

  const query = useFeedback({
    ackState: ackState === 'all' ? undefined : ackState,
    ratings: ratings.length > 0 ? (ratings as ('up' | 'down')[]) : undefined,
    correlationIds: correlationIds.length > 0 ? correlationIds : undefined,
    raterIds: raterIds.length > 0 ? raterIds : undefined,
    search: search.trim() || undefined,
  })

  const clientOptions = useMemo(
    () =>
      (query.data?.correlations ?? []).map((c) => ({
        value: c.id,
        label: c.label || c.id,
      })),
    [query.data?.correlations],
  )
  const raterOptions = useMemo(
    () =>
      (query.data?.raters ?? []).map((r) => ({
        value: r.id,
        label: r.label || 'Unknown user',
      })),
    [query.data?.raters],
  )

  const rows = useMemo(() => query.data?.rows ?? [], [query.data?.rows])
  const groups = useMemo(() => groupRows(rows, groupBy), [rows, groupBy])

  const hasActiveFilters =
    ackState !== 'all' ||
    ratings.length > 0 ||
    correlationIds.length > 0 ||
    raterIds.length > 0 ||
    search.trim().length > 0

  const reset = () => {
    setAckState('all')
    setRatings([])
    setCorrelationIds([])
    setRaterIds([])
    setSearch('')
  }

  const unacknowledgedCount = rows.filter((r) => !r.acknowledgedAt).length

  return (
    <div className={cn('mx-auto max-w-5xl space-y-4 p-6', className)}>
      <div>
        <h1 className="text-lg font-semibold text-neutral-900">Feedback</h1>
        <p className="text-sm text-neutral-500">
          What people thought of the AI&apos;s answers — thumbs up and down, with
          their comments. Acknowledge each once your team has acted on it.
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            label="Status"
            options={ACK_OPTIONS}
            value={ackState}
            onChange={setAckState}
          />
          <MultiFilter
            label="Thumbs"
            options={RATING_OPTIONS}
            value={ratings}
            onChange={setRatings}
          />
          <MultiFilter
            label="Client"
            options={clientOptions}
            value={correlationIds}
            onChange={setCorrelationIds}
          />
          <MultiFilter
            label="User"
            options={raterOptions}
            value={raterIds}
            onChange={setRaterIds}
          />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search comments…"
            className="h-8 w-56 rounded-md border border-neutral-300 bg-transparent px-3 text-sm outline-none focus:border-neutral-500"
          />
          {hasActiveFilters ? (
            <button
              type="button"
              onClick={reset}
              className="px-2 text-sm text-neutral-500 hover:text-neutral-900"
            >
              Reset
            </button>
          ) : null}
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs uppercase tracking-wide text-neutral-500">
            Group by
          </span>
          <Segmented
            label="Group by"
            options={GROUP_OPTIONS}
            value={groupBy}
            onChange={setGroupBy}
          />
        </div>
      </div>

      {!query.isPending && rows.length > 0 ? (
        <p className="text-sm text-neutral-500">
          {rows.length} item{rows.length === 1 ? '' : 's'}
          {unacknowledgedCount > 0 ? (
            <>
              {' · '}
              <span className="font-medium text-neutral-900">
                {unacknowledgedCount} unacknowledged
              </span>
            </>
          ) : null}
        </p>
      ) : null}

      {query.isPending ? (
        <p className="py-10 text-center text-sm text-neutral-500">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="rounded-lg border py-16 text-center text-sm text-neutral-500">
          {hasActiveFilters
            ? 'No feedback matches the current filters.'
            : 'No feedback yet.'}
        </p>
      ) : (
        <div className="space-y-6">
          {groups.map((group) => (
            <section key={group.key} className="space-y-2">
              {groupBy !== 'none' ? (
                <div className="flex items-center gap-2 px-1">
                  {group.icon}
                  <h2 className="text-sm font-semibold">{group.label}</h2>
                  <span className="text-xs text-neutral-500">
                    {group.rows.length}
                  </span>
                </div>
              ) : null}
              <div className="divide-y overflow-hidden rounded-lg border">
                {group.rows.map((row) => (
                  <FeedbackItem key={row.subjectId} row={row} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}

function FeedbackItem({ row }: { row: WfFeedbackRow }) {
  const { Button, Badge } = useWfComponents()
  const { navigate } = useWfNav()
  const ack = useSetFeedbackAck()
  const acknowledged = !!row.acknowledgedAt

  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <div className="pt-0.5">
        {row.rating === 'up' ? (
          <ThumbsUp className="h-4 w-4 fill-current text-emerald-600" />
        ) : (
          <ThumbsDown className="h-4 w-4 fill-current text-rose-600" />
        )}
      </div>

      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span className="font-medium text-neutral-900">
            {raterLabel(row)}
          </span>
          {row.correlationLabel ? (
            <>
              <span className="text-neutral-400">@</span>
              <span className="font-medium text-neutral-600">
                {row.correlationLabel}
              </span>
            </>
          ) : null}
          <span className="text-neutral-300">·</span>
          <span className="text-xs text-neutral-500">
            {formatTimestamp(row.createdAt)}
          </span>
        </div>

        {row.note ? (
          <p className="text-sm text-neutral-900">“{row.note}”</p>
        ) : (
          <p className="text-sm italic text-neutral-500">No comment left.</p>
        )}

        {row.body ? (
          <SubjectLine body={row.body} url={row.subjectUrl} />
        ) : null}

        {acknowledged ? (
          <p className="pt-0.5 text-xs text-neutral-500">
            Acknowledged
            {row.ackByLabel ? ` by ${row.ackByLabel}` : ''}
            {row.acknowledgedAt
              ? ` · ${formatTimestamp(row.acknowledgedAt)}`
              : ''}
          </p>
        ) : null}

        {row.internalNote ? (
          <p
            className="flex items-start gap-1.5 pt-0.5 text-xs text-amber-700"
            title={row.internalNote}
          >
            <NotebookPen className="mt-0.5 h-3 w-3 shrink-0" />
            <span className="truncate">{row.internalNote}</span>
          </p>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <Badge className="gap-1.5 whitespace-nowrap font-normal">
          {acknowledged ? null : (
            <span
              className="size-1.5 rounded-full bg-amber-500"
              aria-hidden
            />
          )}
          {acknowledged ? 'Acknowledged' : 'Unacknowledged'}
        </Badge>
        <Button
          variant="outline"
          size="sm"
          onClick={() => navigate(`feedback/${row.subjectId}`)}
          title="Open this item to review it and ask the AI how to improve the output"
        >
          <Sparkles className="mr-1.5 h-3.5 w-3.5 text-violet-500" />
          Review
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={ack.isPending}
          onClick={() =>
            ack.mutate({ subjectId: row.subjectId, acknowledged: !acknowledged })
          }
        >
          {acknowledged ? (
            <>
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
              Reopen
            </>
          ) : (
            <>
              <Check className="mr-1.5 h-3.5 w-3.5" />
              Acknowledge
            </>
          )}
        </Button>
      </div>
    </div>
  )
}

// "On: <answer excerpt>" — a link to the host's deep-link when one was captured,
// plain text otherwise (the SDK owns no routing).
function SubjectLine({ body, url }: { body: string; url: string | null }) {
  const cls =
    'block max-w-2xl truncate text-xs text-neutral-500 hover:text-neutral-900'
  if (url) {
    return (
      <a href={url} className={cn(cls, 'hover:underline')} title={body}>
        On: {body}
      </a>
    )
  }
  return (
    <p className={cls} title={body}>
      On: {body}
    </p>
  )
}

interface Group {
  key: string
  label: string
  icon: ReactNode
  rows: WfFeedbackRow[]
}

function groupRows(rows: WfFeedbackRow[], groupBy: GroupBy): Group[] {
  if (groupBy === 'none') {
    return [{ key: 'all', label: 'All feedback', icon: null, rows }]
  }

  const map = new Map<string, Group>()
  for (const row of rows) {
    let key: string
    let label: string
    let icon: ReactNode = null

    if (groupBy === 'sentiment') {
      key = row.rating
      label = row.rating === 'up' ? 'Thumbs up' : 'Thumbs down'
      icon =
        row.rating === 'up' ? (
          <ThumbsUp className="h-4 w-4 fill-current text-emerald-600" />
        ) : (
          <ThumbsDown className="h-4 w-4 fill-current text-rose-600" />
        )
    } else if (groupBy === 'client') {
      key = row.correlationId ?? '__none__'
      label = row.correlationLabel ?? 'No client'
    } else {
      key = row.raterUserId ?? '__unknown__'
      label = raterLabel(row)
    }

    const existing = map.get(key)
    if (existing) existing.rows.push(row)
    else map.set(key, { key, label, icon, rows: [row] })
  }

  const groups = [...map.values()]
  // Thumbs: down first (the actionable signal). Otherwise by size desc.
  if (groupBy === 'sentiment') {
    groups.sort((a, b) => (a.key === 'down' ? -1 : b.key === 'down' ? 1 : 0))
  } else {
    groups.sort((a, b) => b.rows.length - a.rows.length)
  }
  return groups
}

function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: { value: T; label: string }[]
  value: T
  onChange: (value: T) => void
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-flex items-center rounded-md bg-neutral-100 p-0.5"
    >
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          aria-pressed={value === opt.value}
          onClick={() => onChange(opt.value)}
          className={cn(
            'rounded px-2.5 py-1 text-xs font-medium transition-colors',
            value === opt.value
              ? 'bg-white text-neutral-900 shadow-sm'
              : 'text-neutral-500 hover:text-neutral-900',
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

// Lightweight multi-select filter — a native <details> disclosure holding a
// checkbox list. No popover primitive needed; closes on outside interaction via
// the browser's default <details> behavior when another opens is not automatic,
// so a plain summary toggle is fine for a filter bar.
function MultiFilter({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: { value: string; label: string }[]
  value: string[]
  onChange: (next: string[]) => void
}) {
  const count = value.length
  const toggle = (v: string) =>
    onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v])

  return (
    <details className="relative">
      <summary
        className={cn(
          'flex h-8 cursor-pointer list-none items-center gap-1.5 rounded-md border border-neutral-300 px-2.5 text-sm text-neutral-700 hover:bg-neutral-100',
          count > 0 && 'border-neutral-500',
        )}
      >
        {label}
        {count > 0 ? (
          <span className="rounded bg-neutral-900 px-1.5 text-xs text-white">
            {count}
          </span>
        ) : null}
      </summary>
      <div className="absolute z-10 mt-1 max-h-72 min-w-52 overflow-y-auto rounded-md border border-neutral-200 bg-white p-1 shadow-lg">
        {options.length === 0 ? (
          <p className="px-2 py-1.5 text-xs text-neutral-500">No options</p>
        ) : (
          options.map((opt) => (
            <label
              key={opt.value}
              className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-neutral-100"
            >
              <input
                type="checkbox"
                checked={value.includes(opt.value)}
                onChange={() => toggle(opt.value)}
                className="size-4 rounded border-neutral-300"
              />
              <span className="truncate">{opt.label}</span>
            </label>
          ))
        )}
      </div>
    </details>
  )
}
