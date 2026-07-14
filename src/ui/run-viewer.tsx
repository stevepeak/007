import { useWfComponents } from './context'
import { cn } from './cn'
import { DataView } from './data-view'
import { useRun } from './hooks'
import type { WfRunStepDTO } from '../server/protocol'

// Interface #1 — view a single run and its step logs. Reads the run via the
// injected data client; renders each node's status + input/output/branch trace.
// Framework-agnostic React: all styling is Tailwind, all chrome is injected
// primitives, so it drops into any host page.

const statusClass: Record<string, string> = {
  completed: 'bg-green-100 text-green-700 border-green-200',
  running: 'bg-blue-100 text-blue-700 border-blue-200',
  failed: 'bg-red-100 text-red-700 border-red-200',
  queued: 'bg-neutral-100 text-neutral-600 border-neutral-200',
  cancelled: 'bg-neutral-100 text-neutral-500 border-neutral-200',
  skipped: 'bg-neutral-100 text-neutral-500 border-neutral-200',
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
  const { data, isLoading, error } = useRun(runId)

  if (isLoading) {
    return (
      <div className={cn('p-4 text-sm text-neutral-500', className)}>
        Loading run…
      </div>
    )
  }
  if (error) {
    return (
      <div className={cn('p-4 text-sm text-red-600', className)}>
        {(error as Error).message}
      </div>
    )
  }
  if (!data) {
    return (
      <div className={cn('p-4 text-sm text-neutral-500', className)}>
        Run not found.
      </div>
    )
  }

  return (
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
      {data.run.error ? (
        <div className="rounded-md border border-red-200 bg-red-50 p-2 text-sm text-red-700">
          {data.run.error}
        </div>
      ) : null}
      <div className="space-y-1.5">
        {data.steps.map((step) => (
          <StepRow key={step.nodeId} step={step} />
        ))}
      </div>
    </div>
  )
}
