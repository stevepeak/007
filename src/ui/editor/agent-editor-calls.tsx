import { Activity, ArrowUpRight, Scissors, Users } from 'lucide-react'

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
import { WfLink } from '../nav'
import { runStatusDotClass } from '../run-status'
import { toolChip } from '../tool-appearance'
import { ToolIcon } from '../tool-icon'
import { Tooltip } from '../tooltip'
import { EditorSection } from './editor-section'

// "Recent calls" — this agent's last real executions, as METRICS only: how many
// turns it took, what it spent, and which tools it reached for. Deliberately no
// inputs/outputs — the question this section answers is "how hard is this agent
// working, and what does it cost"; every row links straight to its run for the
// data itself.
//
// A call is one recorded agent step, so an agent used by three workflows — or
// spawned as a sub-agent, or run once per item inside an iteration — contributes
// a row per execution, not one per run. Eval runs are excluded server-side:
// they're simulated, and at eval volume they'd drown out real traffic.

const CALL_LIMIT = 20

export function AgentRecentCalls({ agentId }: { agentId: string }) {
  const calls = useAgentCalls(agentId, { limit: CALL_LIMIT })
  const tools = useTools()
  const rows = calls.data ?? []

  return (
    <EditorSection
      icon={Activity}
      title="Recent calls"
      description="What this agent did on its last runs — turns, tokens, cost, and the tools it called."
    >
      {calls.isLoading ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : null}
      {calls.error ? (
        <p className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {(calls.error as Error).message}
        </p>
      ) : null}

      {!calls.isLoading && !calls.error && rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-neutral-200 p-4 text-center text-xs text-neutral-500">
          No runs yet. Playground and eval runs aren&rsquo;t counted — put this
          agent in a workflow and its real calls land here.
        </p>
      ) : null}

      {rows.length > 0 ? (
        <>
          <CallsSummary rows={rows} />
          <div className="space-y-1.5">
            {rows.map((call) => (
              <CallRow
                key={`${call.runId}:${call.nodeId}:${call.itemIndex ?? -1}`}
                call={call}
                tools={tools.data ?? []}
              />
            ))}
          </div>
          {rows.length === CALL_LIMIT ? (
            <p className="text-[11px] text-neutral-400">
              The {CALL_LIMIT} most recent calls.
            </p>
          ) : null}
        </>
      ) : null}
    </EditorSection>
  )
}

/**
 * The averages across the listed calls — the shape of a typical run of this
 * agent, which is what an author is actually tuning when they change max turns
 * or a budget. Averaged over the calls that reported each figure, so one
 * unpriced model doesn't silently drag the cost average toward zero.
 */
function CallsSummary({ rows }: { rows: WfAgentCall[] }) {
  const avg = (values: number[]) =>
    values.length > 0
      ? values.reduce((sum, v) => sum + v, 0) / values.length
      : null
  const avgTurns = avg(rows.map((r) => r.turns))
  const avgTokens = avg(rows.map((r) => r.inputTokens + r.outputTokens))
  const costs = rows.map((r) => r.costUsd).filter((c): c is number => c != null)
  const avgCost = avg(costs)
  const avgToolCalls = avg(
    rows.map((r) => r.toolCalls.reduce((sum, t) => sum + t.count, 0)),
  )

  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-neutral-200 bg-neutral-200">
      <SummaryTile
        label="Avg turns"
        value={avgTurns != null ? avgTurns.toFixed(1) : '—'}
        hint={`Rounds of tool-calling, averaged over the last ${rows.length} call(s)`}
      />
      <SummaryTile
        label="Avg tools"
        value={avgToolCalls != null ? avgToolCalls.toFixed(1) : '—'}
        hint="Tool calls per run of this agent"
      />
      <SummaryTile
        label="Avg tokens"
        value={formatTokens(avgTokens != null ? Math.round(avgTokens) : null)}
        hint="Prompt + completion tokens per run"
      />
      <SummaryTile
        label="Avg cost"
        value={formatUsd(avgCost)}
        hint={
          costs.length < rows.length
            ? `Tokens × the model’s catalog price — ${rows.length - costs.length} call(s) ran on an unpriced model and are excluded`
            : 'Tokens × the model’s catalog price'
        }
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

/**
 * One call. The whole row is a real link to its run (so cmd-click and
 * middle-click work like any other link), with the workflow it ran in as the
 * visible link text — the run page is where the inputs/outputs this section
 * leaves out actually live.
 */
function CallRow({ call, tools }: { call: WfAgentCall; tools: ToolOption[] }) {
  const tokens = call.inputTokens + call.outputTokens
  // Everything a call can be beyond "an agent node in a workflow": a spawned
  // sub-agent, or one item of an iteration.
  const context: string[] = []
  if (call.subAgentName) context.push(`sub-agent of ${call.subAgentName}`)
  if (call.itemIndex != null) context.push(`item ${call.itemIndex + 1}`)
  if (call.versionNumber != null) context.push(`workflow v${call.versionNumber}`)

  return (
    <WfLink
      to={`runs/${call.runId}`}
      title="Open this run"
      className="group block space-y-2 rounded-md border border-neutral-200 px-3 py-2.5 transition-colors hover:border-neutral-300 hover:bg-neutral-50/60"
    >
      <div className="flex items-center gap-1.5">
        <Tooltip content={call.status}>
          <span
            className={cn(
              'block size-2 shrink-0 rounded-full',
              runStatusDotClass[call.status] ?? 'bg-neutral-300',
            )}
          />
        </Tooltip>
        <span className="min-w-0 truncate text-sm font-medium text-neutral-800 group-hover:text-neutral-900 group-hover:underline">
          {call.workflowName ?? '(unknown workflow)'}
        </span>
        <ArrowUpRight className="size-3.5 shrink-0 text-neutral-300 group-hover:text-neutral-500" />
        <Tooltip
          content={
            call.startedAt != null ? formatTimestamp(call.startedAt) : null
          }
          className="ml-auto shrink-0"
        >
          <span className="text-xs text-neutral-400">
            {formatRelative(call.startedAt)}
          </span>
        </Tooltip>
      </div>

      {context.length > 0 ? (
        <p className="truncate text-[11px] text-neutral-400">
          {context.join(' · ')}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Metric
          value={String(call.turns)}
          label={call.turns === 1 ? 'turn' : 'turns'}
          hint={`${call.turns} round(s) of the tool loop${call.model ? ` on ${call.model}` : ''}`}
        />
        <Metric
          value={formatTokens(tokens)}
          label="tokens"
          hint={`${call.inputTokens.toLocaleString()} in · ${call.outputTokens.toLocaleString()} out`}
        />
        <Metric
          value={formatUsd(call.costUsd)}
          label="cost"
          hint={
            call.costUsd == null
              ? 'No catalog price for the model this ran on'
              : undefined
          }
        />
        <Metric
          value={formatDurationMs(call.durationMs)}
          label="elapsed"
          hint="Wall-clock of this agent call"
        />
      </div>

      {call.toolCalls.length > 0 ||
      call.stoppedOnTokenBudget ||
      call.stoppedOnContextLimit ? (
        <div className="flex flex-wrap items-center gap-1">
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
        </div>
      ) : null}

      {call.error ? (
        <p className="truncate text-xs text-red-600">{call.error}</p>
      ) : null}
    </WfLink>
  )
}

function Metric({
  value,
  label,
  hint,
}: {
  value: string
  label: string
  hint?: string
}) {
  return (
    <Tooltip content={hint} side="top">
      <span className="inline-flex items-baseline gap-1">
        <span className="text-sm font-medium tabular-nums text-neutral-800">
          {value}
        </span>
        <span className="text-[11px] text-neutral-400">{label}</span>
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
