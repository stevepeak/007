import type { WfDashboardResult } from '../../server/protocol'

import { ChartCard, ChartEmpty, StackedBarChart } from './chart-parts'
import { formatCount } from './chart-theme'

// Cloudflare Workflows bills per STEP, and a graph's step count is not
// proportional to its size: every node costs enter/run/record, an iteration
// spends one step per ITEM, and a called workflow adds two more. This is the only
// place that relationship is visible — which graph is expensive, and why.
//
// Stacked by workflow rather than lined: the question is "where did the steps
// go", a part-to-whole reading, and the total height is itself the bill.

export function StepsChart({ data }: { data: WfDashboardResult }) {
  const steps = data.steps
  // Unconfigured analytics is ABSENT, not empty: D1 records no step counts, so
  // rendering a zeroed chart would assert something we never measured.
  if (!steps) return null

  const perRun = steps.runs > 0 ? steps.total / steps.runs : 0

  return (
    <ChartCard
      title="Workflow steps"
      subtitle={
        steps.total > 0 ? (
          <>
            <span className="font-medium text-neutral-900">
              {formatCount(steps.total)}
            </span>{' '}
            billable steps across {formatCount(steps.runs)} durable runs (
            {perRun.toFixed(1)} per run)
          </>
        ) : (
          'No durable runs in this window'
        )
      }
      footnote={
        <>
          Each node costs three steps (enter, run, record); an iteration spends
          one per item instead of one per node, and a durable sub-workflow adds
          two. {formatCount(steps.nodes)} nodes and{' '}
          {formatCount(steps.iterationItems)} iteration items produced these.
          Runs on the inline engine bill no steps and are excluded. Sampled from
          Analytics Engine, so figures are estimates.
        </>
      }
    >
      {steps.total === 0 ? (
        <ChartEmpty
          message="No billable steps in this window"
          hint="Steps appear once a workflow runs on the durable engine."
        />
      ) : (
        <StackedBarChart
          buckets={data.buckets}
          bucket={data.bucket}
          series={steps.series}
          format={formatCount}
          yTick={formatCount}
        />
      )}
    </ChartCard>
  )
}
