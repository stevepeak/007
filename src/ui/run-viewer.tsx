import { deriveRunProgress } from '../engine/run-progress'
import type { WfRunStepDTO } from '../server/protocol'

import { cn } from './cn'
import { useWfComponents } from './context'
import { DataView } from './data-view'
import { useRun } from './hooks'
import { QueryState } from './query-state'
import { runStatusClass } from './run-status'

// Coarse progress bar for the run header: the currently-active node's label plus
// a completed/total node count. Derived from the graph + step trace, so it moves
// as steps land during a poll refresh (and, later, live).
function RunProgress({
  status,
  graph,
  steps,
}: {
  status: string
  graph: Parameters<typeof deriveRunProgress>[0]['graph']
  steps: WfRunStepDTO[]
}) {
  const progress = deriveRunProgress({ status, graph, steps })
  if (progress.total === 0) return null
  const active = status === 'running' || status === 'queued'
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs text-neutral-500">
        <span className="truncate">
          {progress.activeLabel ?? (active ? 'Starting…' : '')}
        </span>
        <span className="shrink-0 tabular-nums">
          {progress.completed}/{progress.total}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-100">
        <div
          className={cn(
            'h-full rounded-full transition-all duration-500',
            status === 'failed' ? 'bg-rose-500' : 'bg-blue-500',
          )}
          style={{ width: `${progress.percent}%` }}
        />
      </div>
    </div>
  )
}

// Interface #1 — view a single run and its step logs. Reads the run via the
// injected data client; renders each node's status + input/output/branch trace.
// Framework-agnostic React: all styling is Tailwind, all chrome is injected
// primitives, so it drops into any host page.

// Same palette as the shared runStatusClass, except this surface renders
// `queued` in neutral (not amber) — preserved as a local override.
const statusClass: Record<string, string> = {
  ...runStatusClass,
  queued: 'bg-neutral-100 text-neutral-600 border-neutral-200',
}

export function StepRow({ step }: { step: WfRunStepDTO }) {
  const { Badge } = useWfComponents()
  const branch = step.branchResult as {
    result?: string
    reasoning?: string
  } | null
  return (
    <details className="rounded-md border border-neutral-200">
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm">
        <span className="font-mono text-xs text-neutral-500">
          {step.sequence}
        </span>
        <span className="font-medium">{step.nodeKind}</span>
        <span className="ml-auto">
          <Badge className={cn('border', statusClass[step.status])}>
            {step.status}
          </Badge>
        </span>
      </summary>
      <div className="space-y-2 border-t border-neutral-100 px-3 py-2">
        {branch?.result ? (
          <div className="text-sm">
            <span className="font-medium">Decision:</span> {branch.result}
            {branch.reasoning ? (
              <span className="text-neutral-500"> — {branch.reasoning}</span>
            ) : null}
          </div>
        ) : null}
        <div>
          <div className="mb-1 text-xs font-medium text-neutral-500">Input</div>
          <DataView value={step.input} />
        </div>
        <div>
          <div className="mb-1 text-xs font-medium text-neutral-500">
            Output
          </div>
          <DataView value={step.output} />
        </div>
        {step.error ? (
          <div className="text-xs text-red-600">{step.error}</div>
        ) : null}
      </div>
    </details>
  )
}

export type RunViewerProps = {
  runId: string
  className?: string
}

export function RunViewer({ runId, className }: RunViewerProps) {
  const { Badge } = useWfComponents()
  const query = useRun(runId)

  return (
    <QueryState
      query={query}
      loading={
        <div className={cn('p-4 text-sm text-neutral-500', className)}>
          Loading run…
        </div>
      }
      error={(error) => (
        <div className={cn('p-4 text-sm text-red-600', className)}>
          {error.message}
        </div>
      )}
      empty={
        <div className={cn('p-4 text-sm text-neutral-500', className)}>
          Run not found.
        </div>
      }
    >
      {(data) => (
        <div className={cn('space-y-3', className)}>
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{data.run.triggerKind}</span>
            <Badge className={cn('border', statusClass[data.run.status])}>
              {data.run.status}
            </Badge>
            {data.versionNumber != null ? (
              <span className="text-xs text-neutral-400">
                v{data.versionNumber}
              </span>
            ) : null}
          </div>
          <RunProgress
            status={data.run.status}
            graph={data.graph}
            steps={data.steps}
          />
          {data.run.error ? (
            <div className="rounded-md border border-red-200 bg-red-50 p-2 text-sm text-red-700">
              {data.run.error}
            </div>
          ) : null}
          <div className="space-y-1.5">
            {data.steps
              .filter((step) => !step.parentNodeId)
              .map((step) => (
                <StepRow key={step.nodeId} step={step} />
              ))}
          </div>
        </div>
      )}
    </QueryState>
  )
}
