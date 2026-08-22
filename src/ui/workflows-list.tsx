import { Clock, GitBranch, History, Play, Plus } from 'lucide-react'
import { useState } from 'react'

import type { WfWorkflowAgentRef } from '../server/protocol'

import { agentColor, agentIcon } from './agent-appearance'
import { cn } from './cn'
import { useWfComponents } from './context'
import { formatRelative, formatTimestamp, formatTokens } from './cost'
import { useWorkflows } from './hooks'
import { useWfNav, WfLink } from './nav'
import { NewWorkflowDialog } from './new-workflow-dialog'
import { QueryState } from './query-state'
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

      <QueryState
        query={{ isLoading, error, data }}
        error={(error) => (
          <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {error.message} — are you signed in?
          </div>
        )}
        isEmpty={(workflows) => workflows?.length === 0}
        empty={
          <div className="text-sm text-neutral-500">
            No workflows in the wf_* tables yet. Seed one first.
          </div>
        }
      />
      <div className="space-y-3">
        {data?.map((w) => (
          <div
            key={w.id}
            role="button"
            tabIndex={0}
            onClick={() => navigate(`${w.id}/edit`)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                navigate(`${w.id}/edit`)
              }
            }}
            className="group cursor-pointer rounded-xl border border-neutral-200 bg-white p-4 transition duration-200 hover:border-neutral-300 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-300"
          >
            <div className="truncate text-base font-medium text-neutral-900">
              {w.name}
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-400">
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
              <Tooltip content="View runs">
                <WfLink
                  to={`runs?workflow=${w.id}`}
                  onClick={(e) => e.stopPropagation()}
                  className="flex items-center gap-1 rounded transition hover:text-neutral-700 hover:underline"
                >
                  <Play className="size-3.5" /> {formatTokens(w.runCount)}{' '}
                  {w.runCount === 1 ? 'run' : 'runs'}
                </WfLink>
              </Tooltip>
            </div>

            <div className="mt-3 border-t border-neutral-100 pt-3">
              {w.agents.length > 0 ? (
                <AgentIcons agents={w.agents} />
              ) : (
                <span className="text-xs text-neutral-300">No agents used</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// The distinct agents a workflow uses, drawn as overlapping icon chips (their
// own icon + color, native-title tooltip). Every agent gets its own icon.
function AgentIcons({ agents }: { agents: WfWorkflowAgentRef[] }) {
  return (
    <div className="flex items-center">
      {agents.map((a) => {
        const Icon = agentIcon(a.icon)
        const color = agentColor(a.color)
        return (
          <span
            key={a.id}
            title={a.name}
            className={cn(
              '-ml-1.5 flex size-6 items-center justify-center rounded-md ring-2 ring-white first:ml-0',
              color.chip,
            )}
          >
            <Icon className="size-3.5" />
          </span>
        )
      })}
    </div>
  )
}
