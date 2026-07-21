import { GitBranch, History, Sparkles } from 'lucide-react'

import type { WfVersionSummary } from '../../server/protocol'
import { cn } from '../cn'
import { useWfComponents } from '../context'
import type { EditSnapshot } from './use-edit-history'

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

// The change-history dropdown: every edit since the workflow opened, newest
// first, click to jump the canvas to that snapshot.
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
  snapshots: EditSnapshot[]
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

// The version-history dropdown: published versions with their notes + AI
// summary, click to load one as a fresh (undoable) edit.
export function VersionsMenu({
  open,
  onToggle,
  versions,
  onSelect,
}: {
  open: boolean
  onToggle: () => void
  versions: WfVersionSummary[] | undefined
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
