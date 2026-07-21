import { Check, Minus, Plus } from 'lucide-react'
import { useMemo } from 'react'

import type { WfAgentSummary } from '../server/protocol'
import { agentColor, agentIcon } from './agent-appearance'
import { cn } from './cn'
import { useAgents, useAgentVersions } from './hooks'
import { RichSelect } from './rich-select'

// A rich, reusable agent picker used across 007 (workflow agent nodes, the New
// Goal dialog, …). A native <select> can only render text, so we roll our own
// popover to show each agent's icon chip, name, and description. On the far
// right sits a version-pin stepper: an agent reference either floats to the
// latest published version (`version: null`) or pins to an exact version, and
// the −/+ buttons step through `Latest ↔ v-max … v1`.

export type AgentSelectValue = {
  agentId: string
  /** Pinned published version, or `null` to float to the latest. */
  version: number | null
}

export function AgentSelect({
  value,
  onChange,
  agents: agentsProp,
  disabled,
  placeholder = 'Select an agent…',
  className,
}: {
  value: AgentSelectValue
  onChange: (value: AgentSelectValue) => void
  /** Agent list; falls back to `useAgents()` when omitted. */
  agents?: WfAgentSummary[]
  disabled?: boolean
  placeholder?: string
  className?: string
}) {
  const fetched = useAgents()
  const agents = agentsProp ?? fetched.data ?? []

  return (
    <RichSelect
      options={agents}
      value={value.agentId}
      getKey={(a) => a.id}
      onChange={(a) =>
        // Switching agents resets the pin to Latest — a version number is only
        // meaningful for the agent it came from.
        onChange({
          agentId: a.id,
          version: a.id === value.agentId ? value.version : null,
        })
      }
      disabled={disabled}
      placeholder={placeholder}
      className={cn('flex items-stretch gap-1.5', className)}
      triggerClassName="min-w-0 flex-1"
      listClassName="left-0 right-0 top-full"
      empty={
        <div className="px-3 py-6 text-center text-sm text-neutral-400">
          No agents yet.
        </div>
      }
      trailing={
        value.agentId ? (
          <VersionStepper
            agentId={value.agentId}
            version={value.version}
            disabled={disabled}
            onChange={(version) => onChange({ ...value, version })}
          />
        ) : null
      }
      renderValue={(a) => {
        const Icon = agentIcon(a.icon)
        return (
          <>
            <span
              className={cn(
                'flex size-5 shrink-0 items-center justify-center rounded',
                agentColor(a.color).chip,
              )}
            >
              <Icon className="size-3" />
            </span>
            <span className="min-w-0 flex-1 truncate">{a.name}</span>
          </>
        )
      }}
      renderOption={(a, isSelected) => {
        const Icon = agentIcon(a.icon)
        return (
          <>
            <span
              className={cn(
                'flex size-8 shrink-0 items-center justify-center rounded-md',
                agentColor(a.color).chip,
              )}
            >
              <Icon className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-neutral-900">
                {a.name}
              </span>
              <span className="mt-0.5 line-clamp-2 block text-xs text-neutral-500">
                {a.description || 'No description yet.'}
              </span>
            </span>
            {isSelected ? (
              <Check className="mt-0.5 size-4 shrink-0 text-neutral-900" />
            ) : null}
          </>
        )
      }}
    />
  )
}

// The −/+ pin control. The ordered options run `[Latest, v-max, …, v1]`; `+`
// moves toward Latest (index 0), `−` steps down toward v1. Latest floats to
// whatever is newest; a number freezes the reference to that exact version.
function VersionStepper({
  agentId,
  version,
  disabled,
  onChange,
}: {
  agentId: string
  version: number | null
  disabled?: boolean
  onChange: (version: number | null) => void
}) {
  const versionsQuery = useAgentVersions(agentId)

  // Published versions, newest first. Only published versions are pinnable.
  const numbers = useMemo(
    () =>
      (versionsQuery.data ?? [])
        .filter((v) => v.publishedAt != null)
        .map((v) => v.versionNumber)
        .sort((a, b) => b - a),
    [versionsQuery.data],
  )

  // The pin ladder: null (Latest) then each version number, newest → oldest.
  const options = useMemo<(number | null)[]>(
    () => [null, ...numbers],
    [numbers],
  )
  const index = options.indexOf(version)
  // A pinned number that no longer exists (or versions still loading) — clamp
  // to a known rung so the stepper stays usable.
  const safeIndex = index === -1 ? 0 : index

  const atLatest = safeIndex <= 0
  const atOldest = safeIndex >= options.length - 1
  const canStep = options.length > 1 && !disabled

  const label = version == null ? 'Latest' : `v${version}`

  return (
    <div className="flex h-9 shrink-0 items-center rounded-md border border-neutral-300">
      <button
        type="button"
        aria-label="Older version"
        disabled={!canStep || atOldest}
        onClick={() => onChange(options[safeIndex + 1] ?? version)}
        className="flex size-8 items-center justify-center rounded-l-md text-neutral-500 transition hover:bg-neutral-100 disabled:pointer-events-none disabled:opacity-30"
      >
        <Minus className="size-3.5" />
      </button>
      <span className="min-w-[3.25rem] px-1 text-center text-xs font-medium tabular-nums text-neutral-700">
        {label}
      </span>
      <button
        type="button"
        aria-label="Newer version"
        disabled={!canStep || atLatest}
        onClick={() => onChange(options[safeIndex - 1] ?? null)}
        className="flex size-8 items-center justify-center rounded-r-md text-neutral-500 transition hover:bg-neutral-100 disabled:pointer-events-none disabled:opacity-30"
      >
        <Plus className="size-3.5" />
      </button>
    </div>
  )
}
