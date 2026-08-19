import { ArrowUpRight, Scissors, Users } from 'lucide-react'

import type { ToolOption, WfAgentCall } from '../../server/protocol'
import { cn } from '../cn'
import {
  formatDurationMs,
  formatRelative,
  formatTimestamp,
  formatTokens,
  formatUsd,
} from '../cost'
import { useAgentCalls, useTools } from '../hooks'
import { runLinkFor } from './agent-editor-call-inspect'
import { WfLink } from '../nav'
import { runStatusDotClass } from '../run-status'
import { toolChip } from '../tool-appearance'
import { ToolIcon } from '../tool-icon'
import { Tooltip } from '../tooltip'

// This agent's last real executions, as METRICS only: how many turns it took,
// what it spent, and which tools it reached for. Deliberately no inputs/outputs
// — the question answered here is "how hard is this agent working, and what does
// it cost"; selecting a row opens the data itself in the editor's bottom dock.
//
// Split in two because the editor shows them in different places: the averages
// (`AgentCallMetrics`) are a page-level strip above the tabs — the numbers you
// tune budgets against, visible whichever tab you're on — while the rows
// (`AgentCallsList`) own the full page width inside the "Recent calls" tab. Both
// read the same query, so mounting both costs one fetch.
//
// A row is a CALL SITE — one agent node in one run — with every execution that
// happened there folded in, so an agent that fans out over 40 items is one row
// saying "Ran 40 times" and not 40 rows of the same run. The tile strip above
// still speaks in per-call averages, since that's the unit a turn cap or a token
// budget is set in. Eval runs are excluded server-side: they're simulated, and
// at eval volume they'd drown out real traffic.

const CALL_LIMIT = 20

/**
 * The averages across the listed calls — the shape of a typical run of this
 * agent, which is what an author is actually tuning when they change max turns
 * or a budget. Averaged over the calls that reported each figure, so one
 * unpriced model doesn't silently drag the cost average toward zero.
 */
export function AgentCallMetrics({ agentId }: { agentId: string }) {
  const calls = useAgentCalls(agentId, { limit: CALL_LIMIT })
  const rows = calls.data ?? []

  // Every figure is PER CALL, not per row: a row can fold a 40-item fan-out, and
  // "avg turns" has to stay the number you compare a turn cap against. So each
  // total is divided by the executions that actually contributed it — rows with
  // no recorded duration, or an unpriced model, are left out of that divisor
  // rather than dragging their average toward zero.
  const totalOf = (pick: (r: (typeof rows)[number]) => number) =>
    rows.reduce((sum, r) => sum + pick(r), 0)
  const callsWhere = (has: (r: (typeof rows)[number]) => boolean) =>
    rows.filter(has).reduce((sum, r) => sum + r.callCount, 0)

  const totalCalls = callsWhere(() => true)
  const per = (total: number, over: number) => (over > 0 ? total / over : null)
  const avgTurns = per(
    totalOf((r) => r.turns),
    totalCalls,
  )
  const avgTokens = per(
    totalOf((r) => r.inputTokens + r.outputTokens),
    totalCalls,
  )
  const pricedCalls = callsWhere((r) => r.costUsd != null)
  const avgCost = per(
    totalOf((r) => r.costUsd ?? 0),
    pricedCalls,
  )
  const timedCalls = callsWhere((r) => r.durationMs != null)
  const avgDuration = per(
    totalOf((r) => r.durationMs ?? 0),
    timedCalls,
  )
  const avgToolCalls = per(
    totalOf((r) => r.toolCalls.reduce((sum, t) => sum + t.count, 0)),
    totalCalls,
  )

  // No calls yet (or still loading): keep the strip in place with em dashes
  // rather than reflowing the page once the numbers land.
  const over =
    totalCalls > 0
      ? `Averaged over the last ${totalCalls} call${totalCalls === 1 ? '' : 's'}`
      : 'No real calls recorded yet'

  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-neutral-200 bg-neutral-200 sm:grid-cols-3 lg:grid-cols-5">
      <SummaryTile
        label="Avg turns"
        value={avgTurns != null ? avgTurns.toFixed(1) : '—'}
        hint={`Rounds of tool-calling. ${over}`}
      />
      <SummaryTile
        label="Avg tools"
        value={avgToolCalls != null ? avgToolCalls.toFixed(1) : '—'}
        hint={`Tool calls per run of this agent. ${over}`}
      />
      <SummaryTile
        label="Avg tokens"
        value={formatTokens(avgTokens != null ? Math.round(avgTokens) : null)}
        hint={`Prompt + completion tokens per run. ${over}`}
      />
      <SummaryTile
        label="Avg cost"
        value={formatUsd(avgCost)}
        hint={
          pricedCalls < totalCalls
            ? `Tokens × the model’s catalog price — ${totalCalls - pricedCalls} call(s) ran on an unpriced model and are excluded`
            : `Tokens × the model’s catalog price. ${over}`
        }
      />
      <SummaryTile
        label="Avg elapsed"
        value={formatDurationMs(
          avgDuration != null ? Math.round(avgDuration) : null,
        )}
        hint={`Wall-clock of one agent call. ${over}`}
      />
    </div>
  )
}

// The white cell must be the GRID child, not the tooltip: `Tooltip` renders an
// `inline-flex` wrapper, so wrapping the cell in one shrinks it to its text and
// leaves the grid's hairline background showing across the rest of the column.
function SummaryTile({
  label,
  value,
  hint,
}: {
  label: string
  value: string
  hint?: string
}) {
  return (
    <div className="bg-white px-3 py-2">
      <Tooltip content={hint} side="top">
        <span>
          <span className="block text-[11px] font-medium text-neutral-400">
            {label}
          </span>
          <span className="block text-sm font-semibold tabular-nums text-neutral-800">
            {value}
          </span>
        </span>
      </Tooltip>
    </div>
  )
}

// One shared column template for the header and every row, so the numbers line
// up into real columns instead of the stacked card the narrow rail needed.
const ROW_COLS =
  'grid grid-cols-[minmax(12rem,1fr)_4.5rem_5.5rem_5rem_5.5rem_minmax(7rem,16rem)_6rem] items-center gap-x-4'

/** Stable identity of one call site — the key, and what "selected" compares. */
export function callKey(call: Pick<WfAgentCall, 'runId' | 'nodeId'>): string {
  return `${call.runId}:${call.nodeId}`
}

export function AgentCallsList({
  agentId,
  selectedKey,
  onSelect,
}: {
  agentId: string
  /** {@link callKey} of the row currently open in the dock, if any. */
  selectedKey?: string | null
  /** Open a row in the editor's bottom dock. */
  onSelect?: (call: WfAgentCall) => void
}) {
  const calls = useAgentCalls(agentId, { limit: CALL_LIMIT })
  const tools = useTools()
  const rows = calls.data ?? []

  if (calls.isLoading) {
    return <p className="text-sm text-neutral-500">Loading…</p>
  }

  if (calls.error) {
    return (
      <p className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
        {(calls.error as Error).message}
      </p>
    )
  }

  if (rows.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-neutral-200 p-8 text-center text-sm text-neutral-500">
        No runs yet. Playground and eval runs aren&rsquo;t counted — put this
        agent in a workflow and its real calls land here.
      </p>
    )
  }

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto">
        <div className="min-w-[56rem] space-y-1">
          <div
            className={cn(
              ROW_COLS,
              'px-3 pb-1 text-[11px] font-medium text-neutral-400',
            )}
          >
            <span>Run</span>
            <span className="text-right">Turns</span>
            <span className="text-right">Tokens</span>
            <span className="text-right">Cost</span>
            <span className="text-right">Elapsed</span>
            <span>Tools</span>
            <span className="text-right">When</span>
          </div>
          {rows.map((call) => (
            <CallRow
              key={callKey(call)}
              call={call}
              tools={tools.data ?? []}
              selected={selectedKey === callKey(call)}
              onSelect={onSelect}
            />
          ))}
        </div>
      </div>
      {rows.length === CALL_LIMIT ? (
        <p className="text-[11px] text-neutral-400">
          The {CALL_LIMIT} most recent calls.
        </p>
      ) : null}
    </div>
  )
}

/**
 * What this row IS, in one line under the workflow name: how many times the
 * agent ran at this call site, in which published version, and — when it's not
 * a plain graph node — that it was a spawned sub-agent. "Ran once" rather than
 * "1 time" because the common row is the single call, and it should read as a
 * sentence, not a table cell.
 */
function callSubtitle(call: WfAgentCall): string {
  const times = call.callCount === 1 ? 'once' : `${call.callCount} times`
  const where =
    call.versionNumber != null ? ` in workflow v${call.versionNumber}` : ''
  const parts = [`Ran ${times}${where}`]
  if (call.failedCount > 0 && call.callCount > 1) {
    parts.push(`${call.failedCount} failed`)
  }
  if (call.subAgentName) parts.push(`sub-agent of ${call.subAgentName}`)
  return parts.join(' · ')
}

/**
 * One call site. Activating the row opens it in the editor's bottom dock rather
 * than navigating: reading what the agent did shouldn't cost you the prompt you
 * were editing above. The run itself is still one click away through the arrow,
 * which stays a real link (so cmd-click and middle-click behave) and carries the
 * node along so the run page lands with this agent already selected.
 */
function CallRow({
  call,
  tools,
  selected,
  onSelect,
}: {
  call: WfAgentCall
  tools: ToolOption[]
  selected?: boolean
  onSelect?: (call: WfAgentCall) => void
}) {
  const tokens = call.inputTokens + call.outputTokens
  // Every number in the row is a total, so say so once a row folds more than
  // one execution — otherwise "10 turns" reads as one very long call.
  const across = call.callCount > 1 ? ` across ${call.callCount} calls` : ''

  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      title="Inspect these calls below"
      onClick={() => onSelect?.(call)}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        e.preventDefault()
        onSelect?.(call)
      }}
      className={cn(
        ROW_COLS,
        'group cursor-pointer rounded-md border px-3 py-2 transition-colors',
        selected
          ? 'border-neutral-400 bg-neutral-50'
          : 'border-neutral-200 hover:border-neutral-300 hover:bg-neutral-50/60',
      )}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <Tooltip content={call.status}>
          <span
            className={cn(
              'block size-2 shrink-0 rounded-full',
              runStatusDotClass[call.status] ?? 'bg-neutral-300',
            )}
          />
        </Tooltip>
        <span className="min-w-0">
          <span className="flex items-center gap-1.5">
            <span className="min-w-0 truncate text-sm font-medium text-neutral-800 group-hover:text-neutral-900">
              {call.workflowName ?? '(unknown workflow)'}
            </span>
            <WfLink
              to={runLinkFor(call, call.itemIndexes[0] ?? null)}
              title="Open this run, with this agent selected"
              aria-label="Open this run"
              // The row's own activation is inspection, so the link must not
              // also fire it on the way out.
              onClick={(e) => e.stopPropagation()}
              className="shrink-0 rounded text-neutral-300 hover:text-neutral-700"
            >
              <ArrowUpRight className="size-3.5" />
            </WfLink>
          </span>
          <span className="block truncate text-[11px] text-neutral-400">
            {callSubtitle(call)}
          </span>
          {call.error ? (
            <span className="block truncate text-xs text-red-600">
              {call.error}
            </span>
          ) : null}
        </span>
      </span>

      <Cell
        value={String(call.turns)}
        hint={`${call.turns} round(s) of the tool loop${across}${call.model ? ` on ${call.model}` : ''}`}
      />
      <Cell
        value={formatTokens(tokens)}
        hint={`${call.inputTokens.toLocaleString()} in · ${call.outputTokens.toLocaleString()} out${across}`}
      />
      <Cell
        value={formatUsd(call.costUsd)}
        hint={
          call.costUsd == null
            ? 'No catalog price for the model this ran on'
            : `Tokens × the model’s catalog price${across}`
        }
      />
      <Cell
        value={formatDurationMs(call.durationMs)}
        hint={`Wall-clock of this agent call${across}, summed — not the span it ran over`}
      />

      <span className="flex min-w-0 flex-wrap items-center gap-1">
        {call.toolCalls.map((t) => (
          <ToolCallChip key={t.toolId} call={t} tools={tools} />
        ))}
        {call.stoppedOnTokenBudget ? (
          <CapChip
            label="budget"
            hint="Its token budget ended the research — it answered with what it had."
          />
        ) : null}
        {call.stoppedOnContextLimit ? (
          <CapChip
            label="context"
            hint="It stopped gathering to avoid overflowing the model's context window."
          />
        ) : null}
      </span>

      <Tooltip
        content={
          call.startedAt != null ? formatTimestamp(call.startedAt) : null
        }
        className="justify-self-end"
      >
        <span className="text-xs text-neutral-400">
          {formatRelative(call.startedAt)}
        </span>
      </Tooltip>
    </div>
  )
}

/** One right-aligned number in a call row. */
function Cell({ value, hint }: { value: string; hint?: string }) {
  return (
    <Tooltip content={hint} side="top" className="justify-self-end">
      <span className="text-sm font-medium tabular-nums text-neutral-800">
        {value}
      </span>
    </Tooltip>
  )
}

/**
 * One tool the agent reached for, as its icon plus how many times it was called.
 * Ids the registry doesn't know are the synthesized delegation tools (`spawn_*`,
 * `await_subagents`) — real calls the agent made, so they're shown with a
 * delegation icon rather than dropped.
 */
function ToolCallChip({
  call,
  tools,
}: {
  call: { toolId: string; count: number }
  tools: ToolOption[]
}) {
  const tool = tools.find((t) => t.id === call.toolId)
  const delegation =
    !tool &&
    (call.toolId.startsWith('spawn_') || call.toolId.endsWith('_subagents'))
  const label = tool?.name ?? call.toolId
  return (
    <Tooltip
      content={`${label} · called ${call.count} ${call.count === 1 ? 'time' : 'times'}`}
    >
      <span
        className={cn(
          'inline-flex items-center gap-1 rounded-md px-1.5 py-1',
          delegation
            ? 'bg-indigo-50 text-indigo-500'
            : toolChip(tool?.color ?? null),
        )}
      >
        {delegation ? (
          <Users className="size-3.5" />
        ) : (
          <ToolIcon
            icon={tool?.icon}
            iconName={tool?.iconName}
            className="size-3.5"
          />
        )}
        <span className="text-[11px] font-semibold tabular-nums">
          {call.count}
        </span>
      </span>
    </Tooltip>
  )
}

/** The agent stopped early — its budget, or the model's window, ended the loop. */
function CapChip({ label, hint }: { label: string; hint: string }) {
  return (
    <Tooltip content={hint}>
      <span className="inline-flex items-center gap-1 rounded-md bg-amber-50 px-1.5 py-1 text-[11px] font-medium text-amber-700">
        <Scissors className="size-3" />
        {label}
      </span>
    </Tooltip>
  )
}
