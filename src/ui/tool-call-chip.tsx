import { Users } from 'lucide-react'

import type { ToolOption } from '../server/protocol'

import { cn } from './cn'
import { toolChip } from './tool-appearance'
import { ToolIcon } from './tool-icon'
import { Tooltip } from './tooltip'

/**
 * Whether a recorded tool id is one the engine synthesizes for delegation
 * (`spawn_*`, `await_subagents`, `check_subagents`). Those are real calls the
 * agent made but never appear in the tool catalog.
 */
export function isDelegationToolId(args: { toolId: string }): boolean {
  return args.toolId.startsWith('spawn_') || args.toolId.endsWith('_subagents')
}

/**
 * One tool an agent called, as its icon plus how many times. An id the catalog
 * doesn't know that looks like a delegation tool gets the sub-agent look rather
 * than the missing-tool fallback. `showLabel` adds the tool's name and renders
 * the count as `×n`.
 */
export function ToolCallChip({
  call,
  tools,
  showLabel = false,
}: {
  call: { toolId: string; count: number }
  tools: ToolOption[] | undefined
  showLabel?: boolean
}) {
  const tool = tools?.find((t) => t.id === call.toolId)
  const delegation = !tool && isDelegationToolId({ toolId: call.toolId })
  const label = tool?.name ?? call.toolId
  return (
    <Tooltip
      content={`${label} · called ${call.count} ${call.count === 1 ? 'time' : 'times'}`}
    >
      <span
        className={cn(
          'inline-flex items-center gap-1 rounded-md px-1.5',
          showLabel ? 'py-0.5' : 'py-1',
          delegation
            ? 'bg-indigo-50 text-indigo-500'
            : toolChip(tool?.color ?? null),
        )}
      >
        {delegation ? (
          <Users className="size-3.5 shrink-0" />
        ) : (
          <ToolIcon
            icon={tool?.icon}
            iconName={tool?.iconName}
            iconUrl={tool?.iconUrl}
            className="size-3.5"
          />
        )}
        {showLabel ? (
          <>
            <span className="max-w-[9rem] truncate text-[11px] font-semibold">
              {label}
            </span>
            <span className="text-[11px] font-semibold tabular-nums opacity-70">
              ×{call.count}
            </span>
          </>
        ) : (
          <span className="text-[11px] font-semibold tabular-nums">
            {call.count}
          </span>
        )}
      </span>
    </Tooltip>
  )
}
