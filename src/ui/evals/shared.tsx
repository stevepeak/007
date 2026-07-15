import { Bot, Workflow as WorkflowIcon } from 'lucide-react'

import { cn } from '../cn'
import type { MockRunHistoryRow, MockTargetKind } from './mock-data'

// Small presentational bits shared across the Evals catalog, set, sample, and
// test pages.

/** Badge for what a sample/test exercises — an agent or a workflow. */
export function KindBadge({ kind }: { kind: MockTargetKind }) {
  const Icon = kind === 'agent' ? Bot : WorkflowIcon
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
        kind === 'agent'
          ? 'bg-violet-50 text-violet-700'
          : 'bg-indigo-50 text-indigo-700',
      )}
    >
      <Icon className="size-3" />
      {kind === 'agent' ? 'Agent' : 'Workflow'}
    </span>
  )
}

export function PassRate({
  passed,
  total,
}: {
  passed: number
  total: number
}) {
  const ok = total > 0 && passed === total
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium tabular-nums',
        ok ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700',
      )}
    >
      {passed}/{total}
      <span className="ml-1">{ok ? '✓' : '✗'}</span>
    </span>
  )
}

/** Judge-only score, 0..1. Renders "—" when a set/sample/test has no scored checks. */
export function Score({ value }: { value: number | null }) {
  return (
    <span className="text-sm tabular-nums text-neutral-700">
      {value == null ? '—' : value.toFixed(2)}
    </span>
  )
}

export function StatusPill({ status }: { status: 'pass' | 'fail' }) {
  const pass = status === 'pass'
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium',
        pass ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700',
      )}
    >
      {pass ? 'pass ✓' : 'fail ✗'}
    </span>
  )
}

/** Tag for a test's family — binary (pass/fail) or scored (judged). */
export function FamilyTag({ scored }: { scored: boolean }) {
  return (
    <span
      className={cn(
        'rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide',
        scored
          ? 'bg-amber-50 text-amber-700'
          : 'bg-neutral-100 text-neutral-500',
      )}
    >
      {scored ? 'scored' : 'binary'}
    </span>
  )
}

export function EmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-dashed border-neutral-200 p-8 text-center text-sm text-neutral-500">
      {message}
    </div>
  )
}

// ── Tabs ─────────────────────────────────────────────────────────────────────

export type TabDef = { key: string; label: string; count?: number }

export function Tabs({
  tabs,
  active,
  onChange,
}: {
  tabs: TabDef[]
  active: string
  onChange: (key: string) => void
}) {
  return (
    <div className="flex items-center gap-1 border-b border-neutral-200">
      {tabs.map((t) => {
        const on = t.key === active
        return (
          <button
            key={t.key}
            type="button"
            onClick={() => onChange(t.key)}
            className={cn(
              '-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors',
              on
                ? 'border-neutral-900 text-neutral-900'
                : 'border-transparent text-neutral-500 hover:text-neutral-800',
            )}
          >
            {t.label}
            {t.count != null ? (
              <span
                className={cn(
                  'rounded-full px-1.5 py-0.5 text-[11px] font-medium',
                  on
                    ? 'bg-neutral-900 text-white'
                    : 'bg-neutral-100 text-neutral-500',
                )}
              >
                {t.count}
              </span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}

// ── Versions ─────────────────────────────────────────────────────────────────

export function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

/** Small "v3" badge for the current version, shown next to a title. */
export function VersionBadge({ version }: { version: number }) {
  return (
    <span className="rounded-md bg-neutral-100 px-1.5 py-0.5 text-xs font-medium tabular-nums text-neutral-500">
      v{version}
    </span>
  )
}

/** Immutable version history (newest first). Read-only. */
export function VersionsList({
  versions,
}: {
  versions: { version: number; createdAt: number }[]
}) {
  const rows = [...versions].sort((a, b) => b.version - a.version)
  return (
    <div className="overflow-hidden rounded-lg border border-neutral-200">
      {rows.map((v, i) => (
        <div
          key={v.version}
          className="flex items-center justify-between border-b border-neutral-100 px-4 py-2.5 last:border-b-0"
        >
          <span className="flex items-center gap-2 text-sm font-medium text-neutral-800">
            v{v.version}
            {i === 0 ? (
              <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
                current
              </span>
            ) : null}
          </span>
          <span className="text-xs text-neutral-400">
            {formatTimestamp(v.createdAt)}
          </span>
        </div>
      ))}
    </div>
  )
}

// ── Test runs (history) ──────────────────────────────────────────────────────

// A per-entity history of test runs — the "Test runs" tab shown on a set,
// sample, or single test. Rows are the runs that touched that entity.
export function TestRunsTable({ rows }: { rows: MockRunHistoryRow[] }) {
  if (rows.length === 0) {
    return <EmptyState message="No test runs yet." />
  }
  return (
    <div className="overflow-hidden rounded-lg border border-neutral-200">
      <div className="grid grid-cols-[1fr_auto_auto] items-center gap-4 border-b border-neutral-100 bg-neutral-50 px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-neutral-400">
        <span>When</span>
        <span className="text-right">Result</span>
        <span className="w-16 text-right">Score</span>
      </div>
      {rows.map((r) => (
        <div
          key={r.id}
          className="grid grid-cols-[1fr_auto_auto] items-center gap-4 border-b border-neutral-100 px-4 py-2.5 last:border-b-0 hover:bg-neutral-50"
        >
          <span className="text-sm text-neutral-700">{r.at}</span>
          <div className="text-right">
            <StatusPill status={r.status} />
          </div>
          <div className="w-16 text-right">
            <Score value={r.score} />
          </div>
        </div>
      ))}
    </div>
  )
}
