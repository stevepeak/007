import { GitBranch, History, Sparkles } from 'lucide-react'

import { cn } from '../cn'
import { useWfComponents } from '../context'


// Commit-graph node for a change-history row: a dot on a connecting rail. The
// newest change is dark; older ones are a single muted grey tone.
function HistoryDot({ muted }: { muted?: boolean }) {
  return (
    <span className="relative flex w-3 shrink-0 justify-center self-stretch">
      <span className="absolute inset-y-0 w-px bg-neutral-200" />
      <span
        className={cn(
          'relative mt-2 size-2 rounded-full',
          muted ? 'bg-neutral-300' : 'bg-neutral-800',
        )}
      />
    </span>
  )
}

// Just the field the dropdown renders. Typed structurally rather than as
// `EditSnapshot` so the same menu serves the workflow editor AND the agent
// editor — one stores a graph per entry and the other a config, and neither
// fact matters to a list of labels.
type HistoryRow = { label: string }

// The change-history dropdown: every edit since the asset was opened, newest
// first, click to jump back to that point.
export function HistoryMenu({
  open,
  onToggle,
  snapshots,
  currentIndex,
  changeCount,
  onSelect,
}: {
  open: boolean
  onToggle: () => void
  snapshots: HistoryRow[]
  currentIndex: number
  changeCount: number
  onSelect: (index: number) => void
}) {
  const { Button } = useWfComponents()
  return (
    <div className="relative">
      <Button variant="outline" size="sm" onClick={onToggle}>
        <History className="size-4" />
        History
        {changeCount > 0 ? (
          <span className="ml-1 rounded-full bg-indigo-100 px-1.5 py-0.5 text-[11px] font-semibold text-indigo-700">
            {changeCount}
          </span>
        ) : null}
      </Button>
      {open ? (
        <div className="absolute right-0 z-20 mt-1 max-h-80 w-72 overflow-y-auto rounded-md border border-neutral-200 bg-white shadow-lg">
          {snapshots
            .map((snap, idx) => ({ snap, idx }))
            .reverse()
            .map(({ snap, idx }, i) => (
              <button
                key={idx}
                onClick={() => onSelect(idx)}
                className={cn(
                  'flex w-full items-stretch gap-2 px-3 py-2 text-left text-sm hover:bg-neutral-50',
                  idx === currentIndex && 'bg-indigo-50',
                )}
              >
                <HistoryDot muted={i > 0} />
                <span className="flex-1 truncate self-center">
                  {snap.label}
                </span>
                {idx === currentIndex ? (
                  <span className="self-center text-xs text-indigo-600">
                    current
                  </span>
                ) : null}
              </button>
            ))}
        </div>
      ) : null}
    </div>
  )
}

// Just the fields the dropdown renders. Typed structurally rather than as
// `WfVersionSummary` so the same menu serves workflow *and* agent history —
// the two DTOs are deliberately the same shape (see `WfAgentVersionSummary`).
type VersionRow = {
  id: string
  versionNumber: number
  changeNote: string | null
  aiSummaryShort: string | null
}

// The version-history dropdown: published versions with their notes + AI
// summary, click to load one as a fresh edit.
export function VersionsMenu({
  open,
  onToggle,
  versions,
  onSelect,
}: {
  open: boolean
  onToggle: () => void
  versions: VersionRow[] | undefined
  onSelect: (versionId: string) => void
}) {
  const { Button } = useWfComponents()
  return (
    <div className="relative">
      <Button variant="outline" size="sm" onClick={onToggle}>
        <GitBranch className="size-4" />
        Versions ({versions?.length ?? 0})
      </Button>
      {open ? (
        <div className="absolute right-0 z-20 mt-1 max-h-72 w-72 overflow-y-auto rounded-md border border-neutral-200 bg-white shadow-lg">
          {versions?.length === 0 ? (
            <div className="p-3 text-sm text-neutral-500">
              No versions yet.
            </div>
          ) : null}
          {versions?.map((v) => (
            <button
              key={v.id}
              onClick={() => onSelect(v.id)}
              className="block w-full border-b border-neutral-100 px-3 py-2 text-left text-sm hover:bg-neutral-50"
            >
              <span className="font-medium">v{v.versionNumber}</span>
              {v.changeNote ? (
                <span className="text-neutral-600"> — {v.changeNote}</span>
              ) : null}
              {v.aiSummaryShort ? (
                <span className="mt-0.5 flex items-start gap-1 text-xs text-neutral-500">
                  <Sparkles className="mt-0.5 size-3 shrink-0 text-indigo-500" />
                  <span className="line-clamp-2">{v.aiSummaryShort}</span>
                </span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
