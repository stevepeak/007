import { Bot, Trophy, Workflow as WorkflowIcon, X } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'

import { cn } from '../cn'
import type {
  MockModelBrand,
  MockRunHistoryRow,
  MockRunModelResult,
  MockTargetKind,
} from './mock-data'
import { getProvider, ProviderLogo } from './provider-logos'

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

/**
 * Colored monogram fallback for vendors we don't ship a real logo for. Brands
 * with a logomark (openai, anthropic, venice, openrouter) are handled by
 * ProviderLogo in BrandMark below and never hit this table.
 */
const BRAND_MARK: Partial<
  Record<MockModelBrand, { label: string; className: string }>
> = {
  google: { label: 'G', className: 'bg-blue-100 text-blue-700' },
  meta: { label: 'M', className: 'bg-indigo-100 text-indigo-700' },
  mistral: { label: 'Mi', className: 'bg-rose-100 text-rose-700' },
  qwen: { label: 'Qw', className: 'bg-purple-100 text-purple-700' },
  deepseek: { label: 'Ds', className: 'bg-cyan-100 text-cyan-700' },
}

export function BrandMark({
  brand,
  fallback,
}: {
  brand?: MockModelBrand | null
  /** Text (e.g. the model name) to derive a neutral mark from when brand is unknown. */
  fallback?: string
}) {
  // Prefer the real vendor logomark when we have one.
  const provider = getProvider(brand)
  if (provider) return <ProviderLogo id={provider.id} />

  const b = brand ? BRAND_MARK[brand] : undefined
  const label = b?.label ?? (fallback?.trim()?.slice(0, 2) || '··')
  return (
    <span
      className={cn(
        'inline-flex size-5 shrink-0 items-center justify-center rounded text-[10px] font-bold',
        b?.className ?? 'bg-neutral-100 text-neutral-500',
      )}
    >
      {label}
    </span>
  )
}

/**
 * Best-effort vendor guess from a model id/name, so a bare `ModelOption`
 * (which carries no brand) still gets a colored mark. Returns undefined when
 * nothing matches — the caller then renders a neutral fallback.
 */
export function inferModelBrand(idOrLabel: string): MockModelBrand | undefined {
  const t = idOrLabel.toLowerCase()
  if (t.includes('claude') || t.includes('anthropic')) return 'anthropic'
  if (t.includes('gpt') || t.includes('openai') || /\bo[134]\b/.test(t)) return 'openai'
  if (t.includes('venice')) return 'venice'
  if (t.includes('openrouter')) return 'openrouter'
  if (t.includes('gemini') || t.includes('google')) return 'google'
  if (t.includes('llama') || t.includes('meta')) return 'meta'
  if (t.includes('qwen')) return 'qwen'
  if (t.includes('deepseek')) return 'deepseek'
  if (t.includes('mistral') || t.includes('mixtral')) return 'mistral'
  return undefined
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
// sample, or single test. Each row is a best-of-N competition across several
// models; the columns read like a sentence (ran best-of-N · N models · total $ ·
// x/y passed · best model · score). Click a row to open the full run report.
export function TestRunsTable({ rows }: { rows: MockRunHistoryRow[] }) {
  const [open, setOpen] = useState<MockRunHistoryRow | null>(null)
  if (rows.length === 0) {
    return <EmptyState message="No test runs yet." />
  }
  // Fixed/fr column widths (no `auto`) so the header grid and every row grid
  // resolve identical columns and stay aligned.
  const cols =
    'grid grid-cols-[minmax(7rem,1fr)_5.5rem_4rem_5.5rem_5rem_minmax(9rem,1.4fr)_3.5rem] items-center gap-4'
  return (
    <>
      <div className="overflow-x-auto rounded-lg border border-neutral-200">
        <div className="min-w-[720px]">
          <div
            className={cn(
              cols,
              'border-b border-neutral-100 bg-neutral-50 px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-neutral-400',
            )}
          >
            <span>When</span>
            <span>Best of N</span>
            <span className="text-right">Models</span>
            <span className="text-right">Total cost</span>
            <span className="text-right">Result</span>
            <span>Best model</span>
            <span className="w-14 text-right">Score</span>
          </div>
          {rows.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => setOpen(r)}
              className={cn(
                cols,
                'w-full border-b border-neutral-100 px-4 py-2.5 text-left last:border-b-0 hover:bg-neutral-50',
              )}
            >
              <span className="text-sm text-neutral-700">{r.at}</span>
              <div>
                <CountBadge>{r.bestOfN}</CountBadge>
              </div>
              <div className="text-right">
                <CountBadge>{r.modelsCount}</CountBadge>
              </div>
              <div className="text-right">
                <CostBadge cost={r.totalCost} />
              </div>
              <div className="flex justify-end">
                <PassRate passed={r.passed} total={r.total} />
              </div>
              <div className="flex min-w-0 items-center gap-1.5">
                <BrandMark brand={r.best.brand} />
                <span className="truncate text-sm text-neutral-700">
                  {r.best.model}
                </span>
              </div>
              <div className="w-14 text-right">
                <Score value={r.best.score} />
              </div>
            </button>
          ))}
        </div>
      </div>
      <RunReportDialog run={open} onClose={() => setOpen(null)} />
    </>
  )
}

/** Compact "12k" / "980" token label. */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens)
  return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`
}

/** Neutral count/config chip (e.g. "best of 3", "5"). */
function CountBadge({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-md bg-neutral-100 px-1.5 py-0.5 text-xs font-medium tabular-nums text-neutral-600">
      {children}
    </span>
  )
}

/** Badge for a USD cost. */
export function CostBadge({ cost }: { cost: number }) {
  return (
    <span className="inline-flex items-center rounded-md bg-neutral-100 px-1.5 py-0.5 text-xs font-medium tabular-nums text-neutral-600">
      ${cost.toFixed(2)}
    </span>
  )
}

/** Badge for a token count, formatted compactly (e.g. "12k"). */
export function TokensBadge({ tokens }: { tokens: number }) {
  return (
    <span className="inline-flex items-center rounded-md bg-neutral-100 px-1.5 py-0.5 text-xs font-medium tabular-nums text-neutral-600">
      {formatTokens(tokens)}
    </span>
  )
}

// ── Run report (a single competition: prose summary + model matrix) ──────────

function RunReportDialog({
  run,
  onClose,
}: {
  run: MockRunHistoryRow | null
  onClose: () => void
}) {
  useEffect(() => {
    if (!run) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [run, onClose])

  if (!run) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-lg border border-neutral-200 bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-neutral-200 px-5 py-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-neutral-900">
            Test run
            <span className="font-normal text-neutral-400">{run.at}</span>
          </h2>
          <button
            aria-label="Close"
            onClick={onClose}
            className="text-neutral-400 transition hover:text-neutral-700"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <RunSummaryProse run={run} />
          <RunModelMatrix models={run.models} />
        </div>
      </div>
    </div>
  )
}

/** The run as two lines — the broad run summary, then the winner. */
function RunSummaryProse({ run }: { run: MockRunHistoryRow }) {
  const b = run.best
  return (
    <div className="space-y-2 rounded-lg bg-neutral-50 px-4 py-3 text-sm leading-relaxed text-neutral-600">
      <p>
        Ran <B>best of {run.bestOfN}</B> across <B>{run.modelsCount} models</B> —
        total cost <B>${run.totalCost.toFixed(2)}</B>.{' '}
        <B>
          {run.passed} / {run.total}
        </B>{' '}
        tests passed.
      </p>
      <p className="border-t border-neutral-200 pt-2">
        <span className="mr-1">👑</span>The top performer was <B>{b.model}</B>,
        averaging <B>${b.avgCost.toFixed(2)}</B> over{' '}
        <B>{formatTokens(b.tokens)}</B> tokens per attempt at{' '}
        <B>{b.tokensPerSec} tok/s</B>
        {b.score != null ? (
          <>
            , scoring <B>{b.score.toFixed(2)}</B>
          </>
        ) : null}
        .
      </p>
    </div>
  )
}

function B({ children }: { children: ReactNode }) {
  return <span className="font-semibold text-neutral-900">{children}</span>
}

/** Model × metadata × test-results matrix — one row per competing model. */
function RunModelMatrix({ models }: { models: MockRunModelResult[] }) {
  // Fixed/fr widths (no `auto`) so header + rows share identical columns.
  const cols =
    'grid grid-cols-[minmax(8rem,1.4fr)_5rem_5rem_4.5rem_5rem_4.5rem_3.5rem] items-center gap-3'
  const ranked = [...models].sort((a, b) => Number(b.winner) - Number(a.winner))
  return (
    <div className="overflow-x-auto rounded-lg border border-neutral-200">
      <div className="min-w-[640px]">
        <div
          className={cn(
            cols,
            'border-b border-neutral-100 bg-neutral-50 px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-neutral-400',
          )}
        >
          <span>Model</span>
          <span className="text-right">Attempts</span>
          <span className="text-right">Avg cost</span>
          <span className="text-right">Tokens</span>
          <span className="text-right">Speed</span>
          <span className="text-right">Passed</span>
          <span className="w-12 text-right">Score</span>
        </div>
        {ranked.map((m) => (
          <div
            key={m.modelId}
            className={cn(
              cols,
              'border-b border-neutral-100 px-4 py-2.5 last:border-b-0',
              m.winner && 'bg-emerald-50/50',
            )}
          >
            <div className="flex min-w-0 items-center gap-1.5">
              <BrandMark brand={m.brand} />
              <span className="truncate text-sm font-medium text-neutral-800">
                {m.model}
              </span>
              {m.winner ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700">
                  <Trophy className="size-2.5" />
                  Best
                </span>
              ) : null}
            </div>
            <span className="text-right text-xs tabular-nums text-neutral-500">
              {m.attempts}
            </span>
            <span className="text-right text-xs tabular-nums text-neutral-500">
              ${m.avgCost.toFixed(2)}
            </span>
            <span className="text-right text-xs tabular-nums text-neutral-500">
              {formatTokens(m.tokens)}
            </span>
            <span className="text-right text-xs tabular-nums text-neutral-500">
              {m.tokensPerSec}
              <span className="text-neutral-400"> t/s</span>
            </span>
            <div className="flex justify-end">
              <PassRate passed={m.passed} total={m.total} />
            </div>
            <div className="w-12 text-right">
              <Score value={m.score} />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
