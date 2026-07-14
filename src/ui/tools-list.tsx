import { cn } from './cn'
import { useTools } from './hooks'
import { ToolIcon } from './tool-icon'

// The tools registered in the host's `toolRegistry` (via the injected data
// client's `listTools`), shown as read-only cards — name, icon, and one-line
// description. Reached from the hub's Tools card. Cards aren't clickable yet;
// this is just a catalog of what's available to agents and workflows.
export type ToolsListProps = {
  className?: string
}

export function ToolsList({ className }: ToolsListProps) {
  const { data, isLoading, error } = useTools()

  return (
    <div className={cn('mx-auto max-w-3xl space-y-4 p-6', className)}>
      <div className="text-sm text-neutral-500">
        Tools available to agents and workflows — registered by the host and
        called during a run.
      </div>

      {isLoading ? (
        <div className="text-sm text-neutral-500">Loading…</div>
      ) : null}
      {error ? (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {(error as Error).message} — are you signed in with an active tenant?
        </div>
      ) : null}
      {data?.length === 0 ? (
        <div className="text-sm text-neutral-500">
          No tools registered for this tenant yet.
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {data?.map((t) => (
          <div
            key={t.id}
            className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-white p-4 text-left"
          >
            <div className="flex w-full items-center gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-neutral-100">
                <ToolIcon icon={t.icon} className="size-6" />
              </span>
              <span className="min-w-0 flex-1 truncate text-base font-medium text-neutral-900">
                {t.name}
              </span>
            </div>
            <p className="line-clamp-2 min-h-[2.5rem] text-sm text-neutral-500">
              {t.description || 'No description yet.'}
            </p>
          </div>
        ))}
      </div>
    </div>
  )
}
