import { ChevronLeft, ChevronRight, SquareArrowOutUpRight } from 'lucide-react'
import { useEffect, useState } from 'react'

import type { WfAgentCall } from '../../server/protocol'
import { cn } from '../cn'
import { useWfComponents } from '../context'
import { useRun } from '../hooks'
import { WfLink } from '../nav'
import { QueryState } from '../query-state'
import { RunLog } from '../run-log'
import { runStatusClass } from '../run-status'

import { BottomTray, type TrayTab } from './bottom-dock'

// The agent editor's bottom dock: the ONE call site selected in "Recent calls",
// shown as the same Input → thinking → tool call → Output timeline the run page
// renders. Clicking a row here used to navigate away to that run; inspecting in
// place means you can read what the agent actually did without losing the
// prompt you were editing above.
//
// A row can stand for several executions (an iteration fan-out), so the strip
// carries a `‹ item k/N ›` stepper — the same shape as the run viewer's — and
// the run link stays, deep-linking to this node already selected over there.

export function AgentCallInspect({
  call,
  onClose,
}: {
  /** The selected call site. */
  call: WfAgentCall
  /** Dismiss the dock, clearing the selection in the list above. */
  onClose: () => void
}) {
  const { Badge } = useWfComponents()
  const run = useRun(call.runId)

  // Which execution of the fan-out is shown. An index INTO `itemIndexes`, not
  // the item index itself: a partly-recorded fan-out is sparse, and the stepper
  // should walk what exists rather than dead-end on the gaps.
  const [position, setPosition] = useState(0)
  // A different call site starts at its first execution rather than inheriting
  // the previous row's position, which the new one may not even have.
  // eslint-disable-next-line react-hooks/set-state-in-effect -- reset position when the inspected call changes identity
  useEffect(() => setPosition(0), [call.runId, call.nodeId])

  const itemIndexes = call.itemIndexes
  const hasItems = itemIndexes.length > 0
  const at = Math.min(position, Math.max(0, itemIndexes.length - 1))
  const itemIndex = hasItems ? itemIndexes[at] : null

  const step =
    run.data?.steps.find(
      (s) =>
        s.nodeId === call.nodeId &&
        (itemIndex == null || s.itemIndex === itemIndex),
    ) ?? null

  const tabs: TrayTab[] = [
    {
      id: 'inspect',
      label: 'Inspect',
      accessory: (
        <span className="flex min-w-0 items-center gap-2">
          {hasItems && itemIndexes.length > 1 ? (
            <span className="flex shrink-0 items-center gap-0.5 rounded border border-neutral-200 bg-neutral-50 px-0.5 py-px">
              <button
                type="button"
                aria-label="Previous call"
                disabled={at <= 0}
                onClick={() => setPosition(at - 1)}
                className="rounded p-0.5 text-neutral-500 hover:bg-neutral-200 hover:text-neutral-700 disabled:opacity-30 disabled:hover:bg-transparent"
              >
                <ChevronLeft className="size-3.5" />
              </button>
              <span className="px-1 text-[11px] font-medium tabular-nums text-neutral-600">
                item {itemIndex! + 1}/{call.callCount}
              </span>
              <button
                type="button"
                aria-label="Next call"
                disabled={at >= itemIndexes.length - 1}
                onClick={() => setPosition(at + 1)}
                className="rounded p-0.5 text-neutral-500 hover:bg-neutral-200 hover:text-neutral-700 disabled:opacity-30 disabled:hover:bg-transparent"
              >
                <ChevronRight className="size-3.5" />
              </button>
            </span>
          ) : null}
          <span className="truncate text-[11px] text-neutral-400">
            {call.workflowName ?? '(unknown workflow)'}
          </span>
          {step ? (
            <Badge className={cn('border', runStatusClass[step.status])}>
              {step.status}
            </Badge>
          ) : null}
          <WfLink
            to={runLinkFor(call, itemIndex)}
            className="inline-flex shrink-0 items-center gap-1 rounded border border-neutral-200 px-1.5 py-0.5 text-[11px] font-medium text-neutral-600 hover:border-neutral-300 hover:bg-neutral-50 hover:text-neutral-800"
            title="Open the whole run, with this agent selected"
          >
            <SquareArrowOutUpRight className="size-3" />
            Open run
          </WfLink>
        </span>
      ),
      // Keyed on the RESOLVED step, not the run: a loaded run whose steps have
      // been pruned is the empty state, which is what `empty` renders.
      body: (
        <QueryState
          query={{ isLoading: run.isLoading, error: run.error, data: step }}
          loading={<p className="text-xs text-neutral-500">Loading run…</p>}
          error={(error) => (
            <p className="text-xs text-red-600">{error.message}</p>
          )}
          empty={
            <p className="text-xs text-neutral-500">
              This call&rsquo;s step is no longer recorded — the run&rsquo;s
              steps may have been pruned.
            </p>
          }
        >
          {(step) => <RunLog step={step} />}
        </QueryState>
      ),
    },
  ]

  return <BottomTray tabs={tabs} onClose={onClose} />
}

/**
 * The run page, deep-linked to this call: `?node=` selects the agent on the run
 * graph (and opens its Inspect view) instead of dropping you on a run you then
 * have to find it in, `?item=` picks the execution out of a fan-out.
 */
export function runLinkFor(
  call: WfAgentCall,
  itemIndex: number | null,
): string {
  const params = new URLSearchParams({ node: call.nodeId })
  if (itemIndex != null) params.set('item', String(itemIndex))
  return `runs/${call.runId}?${params.toString()}`
}
