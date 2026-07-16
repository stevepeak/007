import { Check, ChevronDown, Minus, Plus } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import type { WfAgentSummary } from '../server/protocol'
import { agentColor, agentIcon } from './agent-appearance'
import { cn } from './cn'
import { useAgents, useAgentVersions } from './hooks'

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
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const fetched = useAgents()
  const agents = agentsProp ?? fetched.data ?? []

  useEffect(() => {
    if (!open) return
    function onDocMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocMouseDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const selected = agents.find((a) => a.id === value.agentId)
  const SelectedIcon = selected ? agentIcon(selected.icon) : null

  return (
    <div ref={ref} className={cn('relative flex items-stretch gap-1.5', className)}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md border border-neutral-300 bg-transparent px-2 text-left text-sm outline-none focus:border-neutral-500 disabled:opacity-50"
      >
        {selected && SelectedIcon ? (
          <>
            <span
              className={cn(
                'flex size-5 shrink-0 items-center justify-center rounded',
                agentColor(selected.color).chip,
              )}
            >
              <SelectedIcon className="size-3" />
            </span>
            <span className="min-w-0 flex-1 truncate">{selected.name}</span>
          </>
        ) : (
          <span className="text-muted-foreground flex-1">{placeholder}</span>
        )}
        <ChevronDown className="size-4 shrink-0 text-neutral-400" />
      </button>

      {value.agentId ? (
        <VersionStepper
          agentId={value.agentId}
          version={value.version}
          disabled={disabled}
          onChange={(version) => onChange({ ...value, version })}
        />
      ) : null}

      {open ? (
        <div
          role="listbox"
          className="absolute left-0 right-0 top-full z-50 mt-1 max-h-72 overflow-y-auto rounded-md border border-neutral-200 bg-white p-1 shadow-lg"
        >
          {agents.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-neutral-400">
              No agents yet.
            </div>
          ) : (
            agents.map((a) => {
              const Icon = agentIcon(a.icon)
              const isSelected = a.id === value.agentId
              return (
                <button
                  key={a.id}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => {
                    // Switching agents resets the pin to Latest — a version
                    // number is only meaningful for the agent it came from.
                    onChange({
                      agentId: a.id,
                      version: a.id === value.agentId ? value.version : null,
                    })
                    setOpen(false)
                  }}
                  className={cn(
                    'flex w-full items-start gap-2 rounded-md p-2 text-left transition hover:bg-neutral-50',
                    isSelected && 'bg-neutral-50',
                  )}
                >
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
                </button>
              )
            })
          )}
        </div>
      ) : null}
    </div>
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
