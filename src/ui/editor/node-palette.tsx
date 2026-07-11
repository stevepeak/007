import {
  GitBranch,
  Lightbulb,
  Repeat,
  Scale,
  Sparkles,
  Split,
  StickyNote,
  Wrench,
  type LucideIcon,
} from 'lucide-react'

import { cn } from '../cn'

export const PALETTE_DATA_TYPE = 'application/x-workflow-node'

type PaletteItem = {
  kind:
    | 'agent'
    | 'tool'
    | 'judge'
    | 'branch'
    | 'switch'
    | 'iteration'
    | 'feature-request'
    | 'note'
  label: string
  description: string
  icon: LucideIcon
}

const PALETTE: PaletteItem[] = [
  {
    kind: 'agent',
    label: 'Agent',
    description: 'Run an agent.',
    icon: Sparkles,
  },
  {
    kind: 'tool',
    label: 'Tool',
    description: 'Direct call to a registered tool — no LLM in the loop.',
    icon: Wrench,
  },
  {
    kind: 'judge',
    label: 'Judge',
    description: 'Yes / no routing decided by a small LLM call.',
    icon: Scale,
  },
  {
    kind: 'branch',
    label: 'Branch',
    description: 'Yes / no routing from a deterministic condition — no LLM.',
    icon: GitBranch,
  },
  {
    kind: 'switch',
    label: 'Switch',
    description: 'Multi-way routing — match a value to one of many cases.',
    icon: Split,
  },
  {
    kind: 'iteration',
    label: 'Iteration',
    description: 'Run a subgraph once per item in a list, in parallel.',
    icon: Repeat,
  },
  {
    kind: 'feature-request',
    label: 'Feature Request',
    description: 'Placeholder for a future idea — passes through unchanged.',
    icon: Lightbulb,
  },
  {
    kind: 'note',
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
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 pb-3">
        {PALETTE.map((item) => {
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
    </aside>
  )
}
