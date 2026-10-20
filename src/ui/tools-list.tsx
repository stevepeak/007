import type { ToolOption } from '../server/protocol'

import { AssetCard } from './asset-card'
import { cn } from './cn'
import { useTools } from './hooks'
import { ListQueryState } from './query-state'
import { ToolAvatar } from './tool-appearance'

// The tools registered in the host's `toolRegistry` (via the injected data
// client's `listTools`), shown as cards — name, icon, and one-line description.
// Reached from the hub's Tools card. Each card links to that tool's detail page
// (`tools/<id>`): recent calls + a real-execution playground.
//
// Grouped by who wrote them. The three kinds look identical in the picker and
// are not interchangeable in practice: a built-in is defined inside the SDK and
// is fixed until the package is bumped, a custom tool is a file in this
// deployment's own repo, and an MCP tool is a third party's — discovered from a
// connector at runtime, so it can appear, change, or start failing without
// either repo being touched. That is the first thing anyone asks on being handed
// an unfamiliar console, and it used to be unanswerable from the UI.

export type ToolsListProps = {
  className?: string
}

const GROUPS = [
  {
    origin: 'host' as const,
    title: 'Custom',
    note: 'Written for this deployment — its own code, its own data.',
  },
  {
    origin: 'sdk' as const,
    title: 'Built-in',
    note: 'Shipped with the workflow platform. This deployment supplies their credentials and storage, not their behaviour.',
  },
  {
    origin: 'connector' as const,
    title: 'Provided by MCP',
    note: 'Proxied from a connected MCP server. A third party owns their behaviour and their descriptions — they can change without a deploy.',
  },
]

export function ToolsList({ className }: ToolsListProps) {
  const { data, isLoading, error } = useTools()

  return (
    <div className={cn('mx-auto max-w-3xl space-y-6 p-6', className)}>
      <div className="text-sm text-neutral-500">
        Tools available to agents and workflows — registered by the host and
        called during a run.
      </div>

      <ListQueryState
        query={{ isLoading, error, data }}
        isEmpty={(data) => data?.length === 0}
        empty={
          <div className="text-sm text-neutral-500">
            No tools registered yet.
          </div>
        }
      />

      {/* Custom first: on any real deployment it is the longer list and the one
          someone came here to look at. */}
      {data
        ? GROUPS.map((group) => (
            <ToolGroup
              key={group.origin}
              title={group.title}
              note={group.note}
              tools={data.filter((t) => t.origin === group.origin)}
            />
          ))
        : null}
    </div>
  )
}

function ToolGroup({
  title,
  note,
  tools,
}: {
  title: string
  note: string
  tools: ToolOption[]
}) {
  // A host with no built-ins registered gets no empty heading.
  if (tools.length === 0) return null
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <h2 className="text-sm font-semibold text-neutral-900">
          {title}{' '}
          <span className="font-normal text-neutral-400">({tools.length})</span>
        </h2>
        <p className="text-xs text-neutral-500">{note}</p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {tools.map((t) => (
          <AssetCard
            key={t.id}
            to={`tools/${t.id}`}
            avatar={<ToolAvatar tool={t} size="lg" />}
            title={t.name}
            description={t.description}
          />
        ))}
      </div>
    </section>
  )
}
