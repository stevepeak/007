import {
  Flag,
  Forward,
  GitBranch,
  Layers,
  Lightbulb,
  Play,
  Repeat,
  Shuffle,
  Sparkles,
  Split,
  StickyNote,
  Target,
  Type,
  Workflow,
  Wrench,
  type LucideIcon,
} from 'lucide-react'

import { nodeKindDescriptor, type NodeKindIconName } from '../../engine'

// The one place icon NAMES from the engine's node-kind registry become React
// components. The engine carries names because it depends only on `ai` + `zod`
// and must not pull in `lucide-react`; `Record<NodeKindIconName, LucideIcon>`
// makes a name with no mapping a compile error here.
const NODE_KIND_ICONS: Record<NodeKindIconName, LucideIcon> = {
  Flag,
  Forward,
  GitBranch,
  Layers,
  Lightbulb,
  Play,
  Repeat,
  Shuffle,
  Sparkles,
  Split,
  StickyNote,
  Target,
  Type,
  Workflow,
  Wrench,
}

export function nodeKindIcon(name: NodeKindIconName): LucideIcon {
  return NODE_KIND_ICONS[name]
}

/** Icon for a node kind, or undefined when the string isn't a known kind. */
export function iconForNodeKind(kind: string): LucideIcon | undefined {
  const descriptor = nodeKindDescriptor(kind)
  return descriptor ? NODE_KIND_ICONS[descriptor.icon] : undefined
}
