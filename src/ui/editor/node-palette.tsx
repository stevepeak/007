import {
  NODE_KIND_CATEGORY_ORDER,
  NODE_KIND_REGISTRY,
  WF_NODE_KINDS,
  type NodeKindCategory,
  type NodeKindIconName,
  type WfNodeKind,
} from '../../engine'
import { cn } from '../cn'

import { nodeKindIcon } from './node-kind-icons'

export const PALETTE_DATA_TYPE = 'application/x-workflow-node'

type PaletteItem = {
  kind: WfNodeKind
  category: NodeKindCategory
  label: string
  description: string
  icon: NodeKindIconName
}

// Derived from the node-kind registry, in registry order. A kind with no
// `palette` entry is one the author cannot drag in (trigger/output are
// template-owned), so it is simply absent here — no second table to keep in
// sync, and a new kind shows up the moment it declares its palette copy.
const PALETTE: PaletteItem[] = WF_NODE_KINDS.flatMap((kind) => {
  const { label, icon, palette } = NODE_KIND_REGISTRY[kind]
  return palette
    ? [{ kind, label, icon, category: palette.category, description: palette.description }]
    : []
})

// Drag-add: stash the kind in the dataTransfer payload; the canvas's drop
// handler reads it and inserts a new node at the drop coordinates.
export function NodePalette() {
  return (
    <aside className="border-border bg-muted/30 flex h-full w-56 flex-col border-r bg-gradient-to-b from-blue-500/[0.04] via-purple-500/[0.04] to-teal-500/[0.04]">
      <div className="text-muted-foreground shrink-0 px-4 pt-3 pb-2 text-[11px] font-medium tracking-wide uppercase">
        Add a node
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pb-3">
        {NODE_KIND_CATEGORY_ORDER.map((category) => {
          const items = PALETTE.filter((item) => item.category === category)
          if (items.length === 0) return null
          return (
            <div key={category} className="flex flex-col gap-2 pt-2 first:pt-0">
              <div className="text-muted-foreground px-1 pt-3 pb-1 text-[10px] font-medium tracking-wide uppercase">
                {category}
              </div>
              {items.map((item) => {
                const Icon = nodeKindIcon(item.icon)
                return (
                  <div
                    key={item.kind}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData(PALETTE_DATA_TYPE, item.kind)
                      e.dataTransfer.effectAllowed = 'move'
                    }}
                    className={cn(
                      'bg-card hover:border-ring/60 cursor-grab rounded-md border p-2 shadow-sm transition-colors',
                      'active:cursor-grabbing',
                    )}
                  >
                    <div className="flex items-start gap-2">
                      <Icon className="text-muted-foreground mt-0.5 size-4 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium">{item.label}</div>
                        <div className="text-muted-foreground mt-0.5 text-xs leading-snug">
                          {item.description}
                        </div>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>
    </aside>
  )
}
