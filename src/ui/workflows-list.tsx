import { Activity, Clock, GitBranch, History, Pencil, Play, Plus } from 'lucide-react'
import { useState } from 'react'

import { cn } from './cn'
import { formatRelative, formatTimestamp, formatTokens } from './cost'
import { useWfComponents } from './context'
import { useWorkflows } from './hooks'
import { useWfNav, WfLink } from './nav'
import { NewWorkflowDialog } from './new-workflow-dialog'
import { Tooltip } from './tooltip'
import { useModifierHold } from './use-modifier-hold'

// The workflows (from the wf_* tables via the injected data client). Each
// row links into the editor and the workflow-scoped runs table. Reached from the
// hub's Workflows card.
export type WorkflowsListProps = {
  className?: string
}

export function WorkflowsList({ className }: WorkflowsListProps) {
  const { data, isLoading, error } = useWorkflows()
  const { Button } = useWfComponents()
  const { navigate } = useWfNav()
  const [creating, setCreating] = useState(false)
  const modifierHeld = useModifierHold()

  return (
    <div className={cn('mx-auto max-w-2xl space-y-4 p-6', className)}>
      <div className="flex items-center justify-between">
        <div className="text-sm text-neutral-500">
          Multi-step agent workflows, triggered manually, on a schedule, or by
          an event.
        </div>
        {modifierHeld ? (
          <Button
            size="sm"
            className="shrink-0 whitespace-nowrap"
            onClick={() => setCreating(true)}
          >
            <Plus className="size-4" />
            New workflow
          </Button>
        ) : null}
      </div>

      <NewWorkflowDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(workflowId) => {
          setCreating(false)
          navigate(`${workflowId}/edit`)
        }}
      />

      {isLoading ? (
        <div className="text-sm text-neutral-500">Loading…</div>
      ) : null}
      {error ? (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {(error as Error).message} — are you signed in?
        </div>
      ) : null}
      {data?.length === 0 ? (
        <div className="text-sm text-neutral-500">
          No workflows in the wf_* tables yet. Seed one first.
        </div>
      ) : null}
      <div className="space-y-2">
        {data?.map((w) => (
          <div
            key={w.id}
            className="flex items-center justify-between rounded-md border border-neutral-200 p-3"
          >
            <div className="min-w-0">
              <div className="truncate font-medium">{w.name}</div>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-400">
                <span className="flex items-center gap-1">
                  <GitBranch className="size-3.5" />
                  {w.latestVersionNumber != null
                    ? `v${w.latestVersionNumber}`
                    : '—'}
                </span>
                <Tooltip
                  content={
                    w.updatedAt
                      ? `Updated ${formatTimestamp(w.updatedAt)}`
                      : 'Never updated'
                  }
                >
                  <span className="flex items-center gap-1">
                    <History className="size-3.5" /> Updated{' '}
                    {formatRelative(w.updatedAt)}
                  </span>
                </Tooltip>
                <Tooltip
                  content={
                    w.lastRunAt
                      ? `Last run ${formatTimestamp(w.lastRunAt)}`
                      : 'Never run'
                  }
                >
                  <span className="flex items-center gap-1">
                    <Clock className="size-3.5" />
                    {w.lastRunAt ? formatRelative(w.lastRunAt) : 'No runs'}
                  </span>
                </Tooltip>
                <span className="flex items-center gap-1">
                  <Play className="size-3.5" /> {formatTokens(w.runCount)}{' '}
                  {w.runCount === 1 ? 'run' : 'runs'}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <Tooltip content="Edit workflow">
                <WfLink
                  to={`${w.id}/edit`}
                  aria-label="Edit workflow"
                  className="inline-flex size-8 items-center justify-center rounded-md border border-neutral-200 text-neutral-600 transition hover:bg-neutral-100 hover:text-neutral-900"
                >
                  <Pencil className="size-4" />
                </WfLink>
              </Tooltip>
              <Tooltip content="View runs">
                <WfLink
                  to={`runs?workflow=${w.id}`}
                  aria-label="View runs"
                  className="inline-flex size-8 items-center justify-center rounded-md border border-neutral-200 text-neutral-600 transition hover:bg-neutral-100 hover:text-neutral-900"
                >
                  <Activity className="size-4" />
                </WfLink>
              </Tooltip>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
