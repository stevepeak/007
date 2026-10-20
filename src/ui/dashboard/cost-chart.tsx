import type { WfDashboardResult } from '../../server/protocol'
import { formatTokens, formatUsd } from '../cost'

import { ChartCard, ChartEmpty, StackedBarChart } from './chart-parts'

// Spend per bucket, stacked by model — part-to-whole over time. The stack answers
// both questions at once: how much did this cost, and what did the money go to.

function axisUsd(v: number) {
  return v >= 1 ? `$${v.toFixed(0)}` : v > 0 ? `$${v.toFixed(2)}` : '$0'
}

export function CostChart({ data }: { data: WfDashboardResult }) {
  const { series, totalUsd, totalTokens, unpricedTokens } = data.cost

  return (
    <ChartCard
      title="Inference cost"
      subtitle={
        totalTokens > 0 ? (
          <>
            <span className="font-medium text-neutral-900">
              {formatUsd(totalUsd)}
            </span>{' '}
            across {formatTokens(totalTokens)} tokens
          </>
        ) : (
          'No spend in this window'
        )
      }
      footnote={
        <>
          {/* The two paths mean genuinely different things, so the caveat can't
              be static: analytics figures were priced when the tokens were
              spent, while the D1 fallback re-prices history on every read. */}
          {data.cost.pricedAtRunTime ? (
            <>
              Cost was priced when each agent call ran, so it doesn&apos;t
              change when the model catalog does. Sampled from Analytics Engine
              — the newest bucket may still be filling in.
            </>
          ) : (
            <>
              Cost is derived from recorded token usage at the model
              catalog&apos;s current prices, so historical spend re-prices when
              the catalog changes.
            </>
          )}
          {unpricedTokens > 0 ? (
            <>
              {' '}
              {formatTokens(unpricedTokens)} tokens ran on models with no
              catalog price and are excluded from the total.
            </>
          ) : null}
        </>
      }
    >
      {series.length === 0 ? (
        <ChartEmpty
          message="No priced agent calls in this window"
          hint={
            unpricedTokens > 0
              ? `${formatTokens(unpricedTokens)} tokens ran on models with no catalog price.`
              : 'Cost appears once a workflow runs an agent on a priced model.'
          }
        />
      ) : (
        <StackedBarChart
          buckets={data.buckets}
          bucket={data.bucket}
          series={series}
          format={formatUsd}
          yTick={axisUsd}
        />
      )}
    </ChartCard>
  )
}
