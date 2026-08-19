import { AlertTriangle } from 'lucide-react'

import type { ToolContextField, ToolOption } from '../../server/protocol'
import { cn } from '../cn'
import { toolChip } from '../tool-appearance'
import { ToolIcon } from '../tool-icon'
import { Tooltip } from '../tooltip'
import { contextLabelsFor } from './agent-editor-context'

// Per-tool live/simulated switches for the agent playground.
//
// A playground run fakes tool results by default (the model invents them), which
// is safe but tests the agent against fiction. Toggling a tool to *live* runs
// its real implementation against the host's real services — the same code path
// a production run takes.
//
// The default is drawn from the tool's own `sideEffect` tag: `read` tools only
// look at data, so they start live and the playground exercises the real thing;
// anything that can write — or that never declared what it does — starts
// simulated and has to be switched on deliberately, with a warning.

/** Is this tool safe to run for real without being asked? */
export function defaultsToLive(tool: ToolOption): boolean {
  return tool.sideEffect === 'read'
}

/** Does running this tool for real risk changing data / billing a call? */
export function isRiskyLive(tool: ToolOption): boolean {
  return tool.sideEffect !== 'read'
}

export function ToolModeList({
  tools,
  live,
  contextFields,
  unmetContext,
  onToggle,
  disabled,
}: {
  /** The agent's attached tools, resolved against the registry. */
  tools: ToolOption[]
  /** Ids currently set to run for real. */
  live: ReadonlySet<string>
  /** Host-declared context fields, for naming what a tool requires. */
  contextFields: readonly ToolContextField[]
  /** Context keys a live tool needs that are still blank. */
  unmetContext: ReadonlySet<string>
  onToggle: (toolId: string, live: boolean) => void
  /** Locked while a run is in flight — the modes are part of that run. */
  disabled?: boolean
}) {
  if (tools.length === 0) return null

  const liveCount = tools.filter((t) => live.has(t.id)).length
  // Only *these* need a warning: a live read tool is the intended default.
  const risky = tools.filter((t) => live.has(t.id) && isRiskyLive(t))

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-neutral-700">Tools</span>
        <span className="text-[11px] text-neutral-400">
          {liveCount} live · {tools.length - liveCount} simulated
        </span>
      </div>

      <ul className="divide-y divide-neutral-100 overflow-hidden rounded-lg border border-neutral-200 bg-white">
        {tools.map((t) => {
          const isLive = live.has(t.id)
          return (
            <li key={t.id} className="flex items-center gap-2.5 px-2.5 py-2">
              <span
                className={cn(
                  'flex size-6 shrink-0 items-center justify-center overflow-hidden rounded',
                  toolChip(t.color),
                )}
              >
                <ToolIcon
                  icon={t.icon}
                  iconName={t.iconName}
                  className="size-3.5"
                />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="min-w-0 truncate text-xs font-medium text-neutral-800">
                    {t.name}
                  </span>
                  <ContextChip
                    tool={t}
                    fields={contextFields}
                    live={isLive}
                    unmet={unmetContext}
                  />
                </span>
                <CapabilityBadge tool={t} />
              </span>
              <span
                className={cn(
                  'shrink-0 text-[11px] font-medium',
                  !isLive
                    ? 'text-neutral-400'
                    : isRiskyLive(t)
                      ? 'text-rose-600'
                      : 'text-emerald-600',
                )}
              >
                {isLive ? 'Live' : 'Simulated'}
              </span>
              <ModeSwitch
                live={isLive}
                risky={isRiskyLive(t)}
                disabled={disabled}
                label={t.name}
                onChange={(next) => onToggle(t.id, next)}
              />
            </li>
          )
        })}
      </ul>

      {risky.length > 0 ? (
        <p className="flex items-start gap-1.5 rounded-md border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-[11px] text-rose-700">
          <AlertTriangle className="mt-px size-3.5 shrink-0" />
          <span>
            <strong>{risky.map((t) => t.name).join(', ')}</strong>{' '}
            {risky.length === 1 ? 'runs' : 'run'} for real against live data. A
            playground run is not a dry run — anything{' '}
            {risky.length === 1 ? 'it writes' : 'they write'}, sends or bills
            actually happens, and nothing here can undo it.
          </span>
        </p>
      ) : (
        <p className="text-[11px] text-neutral-400">
          Simulated tools are faked by the model — the agent still picks the
          tool and its arguments, but nothing runs and no data is touched.
        </p>
      )}
    </div>
  )
}

/**
 * What run scope this tool filters by, when it declares one. Shown on the row so
 * it's obvious WHICH tool summoned the Context field below — and highlighted
 * while that tool is live and the value is still blank, since that's the
 * combination that produces a confidently empty answer.
 */
function ContextChip({
  tool,
  fields,
  live,
  unmet,
}: {
  tool: ToolOption
  fields: readonly ToolContextField[]
  live: boolean
  unmet: ReadonlySet<string>
}) {
  const labels = contextLabelsFor(tool, fields)
  if (labels.length === 0) return null
  const blocking =
    live && (tool.requiresContext ?? []).some((k) => unmet.has(k))

  return (
    <Tooltip
      content={
        live
          ? `This tool filters everything it returns by ${labels.join(' and ')}. Set it above before running.`
          : `Runs live only with ${labels.join(' and ')}. Simulated, it needs nothing.`
      }
    >
      <span
        className={cn(
          'shrink-0 rounded px-1.5 py-px text-[10px] font-medium',
          blocking
            ? 'bg-amber-100 text-amber-700'
            : 'bg-neutral-100 text-neutral-500',
        )}
      >
        needs {labels.join(' + ')}
      </span>
    </Tooltip>
  )
}

/** What running this tool for real would do, in the author's words. */
function CapabilityBadge({ tool }: { tool: ToolOption }) {
  if (tool.sideEffect === 'read') {
    return (
      <span className="text-[11px] text-emerald-600">
        Read-only · safe to run live
      </span>
    )
  }
  if (tool.sideEffect === 'write') {
    return (
      <span className="text-[11px] text-amber-600">
        Can edit data · live runs have real consequences
      </span>
    )
  }
  // Untagged: we genuinely don't know what it does, so it's treated as unsafe.
  return (
    <Tooltip content="This tool doesn't declare whether it reads or writes, so the playground assumes the worst and simulates it by default.">
      <span className="text-[11px] text-neutral-400">
        Unclassified · assumed unsafe
      </span>
    </Tooltip>
  )
}

/** Off = simulated, on = live. Red when on for a tool that can change data. */
function ModeSwitch({
  live,
  risky,
  disabled,
  label,
  onChange,
}: {
  live: boolean
  risky: boolean
  disabled?: boolean
  label: string
  onChange: (live: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={live}
      aria-label={`Run ${label} ${live ? 'live' : 'simulated'}`}
      disabled={disabled}
      onClick={() => onChange(!live)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
        live ? (risky ? 'bg-rose-500' : 'bg-emerald-500') : 'bg-neutral-200',
        disabled && 'cursor-not-allowed opacity-60',
      )}
    >
      <span
        className={cn(
          'inline-block size-4 transform rounded-full bg-white shadow transition-transform',
          live ? 'translate-x-4' : 'translate-x-0.5',
        )}
      />
    </button>
  )
}
