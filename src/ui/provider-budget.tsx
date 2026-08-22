import { AlertTriangle } from 'lucide-react'

import type { ProviderBudget } from '../server/protocol'

import { cn } from './cn'
import { BrandMark, inferModelBrand } from './evals/shared'
import { Tooltip } from './tooltip'

// How much money is left with each model provider, rendered two ways: a wide
// strip under a provider's header on the Models page, and a compact tile in the
// dashboard's Providers panel. Both read the SAME budget shape and share the
// formatting and the thresholds below, so the two surfaces can't drift into
// disagreeing about when a balance counts as "low".

/** USD, always two decimals — this is money, so `$5` reads as unfinished. */
export function formatUsd(amount: number): string {
  return `$${amount.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

/**
 * Fraction of the cap still available (0–1), or null when there's nothing to
 * measure against — an uncapped key has no "percent left".
 */
function remainingFraction(budget: ProviderBudget): number | null {
  if (budget.limit == null || budget.remaining == null || budget.limit <= 0) {
    return null
  }
  return Math.min(1, Math.max(0, budget.remaining / budget.limit))
}

/**
 * Spend charged against the CURRENT period, derived as `limit - remaining`.
 * Deliberately not `budget.usage`: that figure is all-time, so on a monthly key
 * it keeps climbing past a cap that resets underneath it (a real key here reads
 * $2.15 all-time against $0.56 of a $20 monthly cap). Using it for the bar would
 * show a key as nearly exhausted while it's almost untouched.
 */
function spentThisPeriod(budget: ProviderBudget): number | null {
  if (budget.limit == null || budget.remaining == null) return null
  return Math.max(0, budget.limit - budget.remaining)
}

/** Green until a quarter is left, amber below that, red in the last tenth. */
function tone(fraction: number | null): {
  bar: string
  text: string
} {
  if (fraction == null) return { bar: 'bg-neutral-300', text: 'text-neutral-900' }
  if (fraction <= 0.1) return { bar: 'bg-red-500', text: 'text-red-600' }
  if (fraction <= 0.25) return { bar: 'bg-amber-500', text: 'text-amber-600' }
  return { bar: 'bg-emerald-500', text: 'text-neutral-900' }
}

/** 'monthly' → 'resets monthly'; null → the key never resets. */
function resetLabel(interval: string | null): string | null {
  return interval == null ? null : `resets ${interval}`
}

function BudgetMeter({ budget }: { budget: ProviderBudget }) {
  const fraction = remainingFraction(budget)
  if (fraction == null) return null
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-100">
      <div
        className={cn('h-full rounded-full transition-[width]', tone(fraction).bar)}
        style={{ width: `${fraction * 100}%` }}
      />
    </div>
  )
}

/**
 * The non-`ok` states, shared by both renderers so an unreadable balance always
 * SAYS why rather than leaving a blank where a number should be. `budget`
 * missing means the request settled WITHOUT an entry for this provider (the
 * route is down, or it 401'd) — the one case with no per-provider message.
 */
function BudgetNotice({ budget }: { budget?: ProviderBudget }) {
  if (budget == null) {
    return <div className="text-xs text-neutral-400">Balance unavailable.</div>
  }
  if (budget.status === 'error') {
    return (
      <div className="flex items-start gap-1.5 text-xs text-red-600">
        <AlertTriangle className="mt-px size-3.5 shrink-0" />
        <span className="min-w-0">
          Couldn't read balance
          {budget.message ? `: ${budget.message}` : '.'}
        </span>
      </div>
    )
  }
  return (
    <div className="text-xs text-neutral-400">
      This provider doesn't report a balance.
    </div>
  )
}

/** Secondary line: all-time spend, key label, expiry — whatever is known. */
function budgetFootnotes(budget: ProviderBudget): string[] {
  const parts: string[] = []
  if (budget.usage != null) parts.push(`${formatUsd(budget.usage)} all time`)
  if (budget.isFreeTier) parts.push('free tier')
  if (budget.expiresAt != null) {
    parts.push(`expires ${new Date(budget.expiresAt).toLocaleDateString()}`)
  }
  return parts
}

/**
 * Wide strip for the Models page provider card. `loading` is passed explicitly
 * rather than inferred from a missing `budget` — a FAILED request also has no
 * budget, and inferring would leave it pulsing a skeleton forever. It holds its
 * own height either way so the models below don't jump when the figure lands.
 */
export function ProviderBudgetBar({
  budget,
  loading,
}: {
  budget?: ProviderBudget
  loading?: boolean
}) {
  if (loading) {
    return (
      <div className="border-b border-neutral-100 px-4 py-3">
        <div className="h-3 w-40 animate-pulse rounded bg-neutral-100" />
        <div className="mt-2 h-1.5 w-full animate-pulse rounded-full bg-neutral-100" />
      </div>
    )
  }

  if (budget == null || budget.status !== 'ok') {
    return (
      <div className="border-b border-neutral-100 px-4 py-3">
        <BudgetNotice budget={budget} />
      </div>
    )
  }

  const fraction = remainingFraction(budget)
  const spent = spentThisPeriod(budget)
  const reset = resetLabel(budget.resetInterval)
  const footnotes = budgetFootnotes(budget)

  return (
    <div className="border-b border-neutral-100 px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="text-sm tabular-nums">
          {budget.remaining != null ? (
            <>
              <span className={cn('font-medium', tone(fraction).text)}>
                {formatUsd(budget.remaining)}
              </span>
              <span className="text-neutral-500"> remaining</span>
            </>
          ) : (
            <span className="text-neutral-500">No spending cap on this key</span>
          )}
        </div>
        <div className="text-xs tabular-nums text-neutral-500">
          {budget.limit != null ? `of ${formatUsd(budget.limit)}` : null}
          {budget.limit != null && reset ? ' · ' : null}
          {reset}
        </div>
      </div>

      {fraction != null ? (
        <div className="mt-2">
          <BudgetMeter budget={budget} />
        </div>
      ) : null}

      {(spent != null || footnotes.length > 0) && (
        <div className="mt-1.5 text-[11px] tabular-nums text-neutral-400">
          {spent != null ? `${formatUsd(spent)} used this period` : null}
          {spent != null && footnotes.length > 0 ? ' · ' : null}
          {footnotes.join(' · ')}
        </div>
      )}
    </div>
  )
}

/**
 * Compact tile for the dashboard's Providers panel — the at-a-glance form: how
 * much is left, out of what, and how close to empty.
 */
export function ProviderBudgetCard({
  label,
  kind,
  budget,
  loading,
}: {
  label: string
  kind: string
  budget?: ProviderBudget
  /** Explicit, for the same reason as {@link ProviderBudgetBar}. */
  loading?: boolean
}) {
  const fraction = budget ? remainingFraction(budget) : null
  const reset = budget ? resetLabel(budget.resetInterval) : null

  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-lg border border-neutral-200 p-3">
      <div className="flex min-w-0 items-center gap-2">
        <BrandMark brand={inferModelBrand(label)} fallback={label} />
        <span className="truncate text-sm font-medium text-neutral-900">
          {label}
        </span>
        <span className="ml-auto shrink-0 rounded-md bg-neutral-100 px-1.5 py-0.5 text-[10px] font-medium text-neutral-500">
          {kind}
        </span>
      </div>

      {loading ? (
        <>
          <div className="h-6 w-24 animate-pulse rounded bg-neutral-100" />
          <div className="h-1.5 w-full animate-pulse rounded-full bg-neutral-100" />
        </>
      ) : budget == null || budget.status !== 'ok' ? (
        <BudgetNotice budget={budget} />
      ) : (
        <>
          <div className="flex items-baseline gap-1.5">
            <span
              className={cn(
                'text-xl font-semibold tabular-nums',
                tone(fraction).text,
              )}
            >
              {budget.remaining != null
                ? formatUsd(budget.remaining)
                : budget.usage != null
                  ? formatUsd(budget.usage)
                  : '—'}
            </span>
            <span className="truncate text-xs text-neutral-500">
              {budget.remaining != null ? 'remaining' : 'used, no cap'}
            </span>
          </div>
          <BudgetMeter budget={budget} />
          <div className="truncate text-[11px] tabular-nums text-neutral-400">
            {budget.limit != null ? `of ${formatUsd(budget.limit)}` : 'No cap set'}
            {reset ? ` · ${reset}` : null}
          </div>
          {budget.keyLabel ? (
            <Tooltip content={`Key ${budget.keyLabel}`} side="top">
              <div className="truncate text-[11px] text-neutral-300">
                {budget.keyLabel}
              </div>
            </Tooltip>
          ) : null}
        </>
      )}
    </div>
  )
}
