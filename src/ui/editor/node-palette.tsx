import {
  Flag,
  GitBranch,
  Layers,
  Lightbulb,
  Repeat,
  Sparkles,
  Split,
  StickyNote,
  Workflow,
  Wrench,
  type LucideIcon,
} from 'lucide-react'

import { cn } from '../cn'

export const PALETTE_DATA_TYPE = 'application/x-workflow-node'

type PaletteCategory = 'Steps' | 'Logic' | 'Other'

type PaletteItem = {
  kind:
    | 'agent'
    | 'tool'
    | 'branch'
    | 'switch'
    | 'iteration'
    | 'workflow'
    | 'feature-request'
    | 'race'
    | 'aggregate'
    | 'note'
  category: PaletteCategory
  label: string
  description: string
  icon: LucideIcon
}

// Section order in the palette. Nodes are grouped by role: Steps do the actual
// work, Logic handles routing/flow control, Other holds non-executing annotations.
const CATEGORY_ORDER: PaletteCategory[] = ['Steps', 'Logic', 'Other']

const PALETTE: PaletteItem[] = [
  {
    kind: 'agent',
    category: 'Steps',
    label: 'Agent',
    description: 'Run an agent.',
    icon: Sparkles,
  },
  {
    kind: 'tool',
    category: 'Steps',
    label: 'Tool',
    description: 'Direct call to a registered tool — no LLM in the loop.',
    icon: Wrench,
  },
  {
    kind: 'workflow',
    category: 'Steps',
    label: 'Workflow',
    description: 'Call another workflow and wait for its result.',
    icon: Workflow,
  },
  {
    kind: 'branch',
    category: 'Logic',
    label: 'Branch',
    description: 'Yes / no routing from a deterministic condition — no LLM.',
    icon: GitBranch,
  },
  {
    kind: 'switch',
    category: 'Logic',
    label: 'Switch',
    description: 'Multi-way routing — match a value to one of many cases.',
    icon: Split,
  },
  {
    kind: 'iteration',
    category: 'Logic',
    label: 'Iteration',
    description: 'Run a subgraph once per item in a list, in parallel.',
    icon: Repeat,
  },
  {
    kind: 'race',
    category: 'Logic',
    label: 'Race',
    description: 'First-to-finish join — fires as soon as any upstream completes.',
    icon: Flag,
  },
  {
    kind: 'aggregate',
    category: 'Logic',
    label: 'Aggregate',
    description:
      'Wait-for-all join — collects every upstream result into one list.',
    icon: Layers,
  },
  {
    kind: 'feature-request',
    category: 'Other',
    label: 'Feature Request',
    description: 'Placeholder for a future idea — passes through unchanged.',
    icon: Lightbulb,
  },
  {
    kind: 'note',
    category: 'Other',
    label: 'Note',
    description: 'A sticky note with Markdown — never affects the workflow.',
    icon: StickyNote,
  },
]

// Drag-add: stash the kind in the dataTransfer payload; the canvas's drop
// handler reads it and inserts a new node at the drop coordinates.
export function NodePalette() {
  return (
    <aside className="border-border bg-muted/30 flex h-full w-56 flex-col border-r bg-gradient-to-b from-blue-500/[0.04] via-purple-500/[0.04] to-teal-500/[0.04]">
      <div className="text-muted-foreground shrink-0 px-4 pt-3 pb-2 text-[11px] font-medium tracking-wide uppercase">
        Add a node
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pb-3">
        {CATEGORY_ORDER.map((category) => {
          const items = PALETTE.filter((item) => item.category === category)
          if (items.length === 0) return null
          return (
            <div key={category} className="flex flex-col gap-2 pt-2 first:pt-0">
              <div className="text-muted-foreground px-1 pt-3 pb-1 text-[10px] font-medium tracking-wide uppercase">
                {category}
              </div>
              {items.map((item) => {
                const Icon = item.icon
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
