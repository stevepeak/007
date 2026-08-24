import { cn } from '../cn'

// Commit-graph node for a change-history row: a dot on a connecting rail. The
// newest change is dark; older ones are a single muted grey tone.
export function HistoryDot({ muted }: { muted?: boolean }) {
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
