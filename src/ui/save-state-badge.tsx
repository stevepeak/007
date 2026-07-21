import { cn } from './cn'
import { Tooltip } from './tooltip'

// The amber/neutral "Unsaved / Saved" dot shown in the agent and workflow
// editor headers. The dot + label are identical across both; the tooltip copy
// differs slightly, so each caller passes its own.
export function SaveStateBadge({
  dirty,
  dirtyTooltip,
  savedTooltip,
}: {
  dirty: boolean
  dirtyTooltip: string
  savedTooltip: string
}) {
  return (
    <Tooltip side="bottom" content={dirty ? dirtyTooltip : savedTooltip}>
      <span
        className={cn(
          'flex items-center gap-1.5 text-xs',
          dirty ? 'text-amber-600' : 'text-neutral-400',
        )}
      >
        <span
          className={cn(
            'size-1.5 rounded-full',
            dirty ? 'bg-amber-500' : 'bg-neutral-300',
          )}
        />
        {dirty ? 'Unsaved' : 'Saved'}
      </span>
    </Tooltip>
  )
}
