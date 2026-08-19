import { Bot, icons, type LucideIcon } from 'lucide-react'

// The palette an agent card / editor draws from. Icons are stored by their
// PascalCase lucide name and colors by key on `wf_agent`, so both stay small and
// serializable. Any of lucide's ~1750 icons is a valid stored value (resolved
// through `agentIcon`); `AGENT_ICONS` is just the curated grid the appearance
// popover opens on, before you type and search the whole set. Full literal
// Tailwind class strings below so v4's scanner keeps them.

// Every lucide icon, keyed by its PascalCase name (e.g. `Bot`, `FileSearch`).
export const ALL_AGENT_ICONS = icons as Record<string, LucideIcon>

// All icon names, sorted for stable ordering in the picker.
export const ALL_AGENT_ICON_NAMES: string[] = Object.keys(ALL_AGENT_ICONS).sort()

// The curated grid the appearance popover shows before you search — the icons
// that actually suit an agent, rather than the first 40 lucide names
// alphabetically. Ordered roughly by theme so the grid reads as groups.
export const AGENT_ICONS: { name: string; Icon: LucideIcon }[] = [
  'Bot',
  'Brain',
  'Sparkles',
  'Wand',
  'Cpu',
  'Zap',
  'Scale',
  'Gavel',
  'Landmark',
  'ShieldCheck',
  'Stamp',
  'Handshake',
  'BookText',
  'BookOpen',
  'Library',
  'Newspaper',
  'FileText',
  'FileSearch',
  'ClipboardList',
  'NotebookPen',
  'Search',
  'Telescope',
  'Microscope',
  'Compass',
  'Map',
  'Target',
  'MessageSquare',
  'MessagesSquare',
  'Mail',
  'Phone',
  'Megaphone',
  'Users',
  'Briefcase',
  'Building2',
  'ChartLine',
  'ChartPie',
  'Calculator',
  'Coins',
  'Wrench',
  'Cog',
  'Workflow',
  'GitBranch',
  'Database',
  'Server',
  'Lock',
  'KeyRound',
  'Flame',
  'Rocket',
].map((name) => ({ name, Icon: ALL_AGENT_ICONS[name] }))

export const DEFAULT_AGENT_ICON = 'Bot'

export function agentIcon(name: string | null | undefined): LucideIcon {
  return (name && ALL_AGENT_ICONS[name]) || Bot
}

export type AgentColor = {
  key: string
  /** Icon-chip classes: soft tinted background + saturated foreground. */
  chip: string
  /** Foreground only, for a bare icon drawn without a chip background. */
  text: string
  /** A single dot color (swatch) for the picker. */
  swatch: string
}

export const AGENT_COLORS: AgentColor[] = [
  {
    key: 'red',
    chip: 'bg-red-100 text-red-600',
    text: 'text-red-600',
    swatch: 'bg-red-500',
  },
  {
    key: 'orange',
    chip: 'bg-orange-100 text-orange-600',
    text: 'text-orange-600',
    swatch: 'bg-orange-500',
  },
  {
    key: 'amber',
    chip: 'bg-amber-100 text-amber-600',
    text: 'text-amber-600',
    swatch: 'bg-amber-500',
  },
  {
    key: 'yellow',
    chip: 'bg-yellow-100 text-yellow-600',
    text: 'text-yellow-600',
    swatch: 'bg-yellow-500',
  },
  {
    key: 'lime',
    chip: 'bg-lime-100 text-lime-600',
    text: 'text-lime-600',
    swatch: 'bg-lime-500',
  },
  {
    key: 'green',
    chip: 'bg-green-100 text-green-600',
    text: 'text-green-600',
    swatch: 'bg-green-500',
  },
  {
    key: 'emerald',
    chip: 'bg-emerald-100 text-emerald-600',
    text: 'text-emerald-600',
    swatch: 'bg-emerald-500',
  },
  {
    key: 'teal',
    chip: 'bg-teal-100 text-teal-600',
    text: 'text-teal-600',
    swatch: 'bg-teal-500',
  },
  {
    key: 'cyan',
    chip: 'bg-cyan-100 text-cyan-600',
    text: 'text-cyan-600',
    swatch: 'bg-cyan-500',
  },
  {
    key: 'sky',
    chip: 'bg-sky-100 text-sky-600',
    text: 'text-sky-600',
    swatch: 'bg-sky-500',
  },
  {
    key: 'blue',
    chip: 'bg-blue-100 text-blue-600',
    text: 'text-blue-600',
    swatch: 'bg-blue-500',
  },
  {
    key: 'indigo',
    chip: 'bg-indigo-100 text-indigo-600',
    text: 'text-indigo-600',
    swatch: 'bg-indigo-500',
  },
  {
    key: 'violet',
    chip: 'bg-violet-100 text-violet-600',
    text: 'text-violet-600',
    swatch: 'bg-violet-500',
  },
  {
    key: 'purple',
    chip: 'bg-purple-100 text-purple-600',
    text: 'text-purple-600',
    swatch: 'bg-purple-500',
  },
  {
    key: 'fuchsia',
    chip: 'bg-fuchsia-100 text-fuchsia-600',
    text: 'text-fuchsia-600',
    swatch: 'bg-fuchsia-500',
  },
  {
    key: 'pink',
    chip: 'bg-pink-100 text-pink-600',
    text: 'text-pink-600',
    swatch: 'bg-pink-500',
  },
  {
    key: 'rose',
    chip: 'bg-rose-100 text-rose-600',
    text: 'text-rose-600',
    swatch: 'bg-rose-500',
  },
  {
    key: 'stone',
    chip: 'bg-stone-100 text-stone-600',
    text: 'text-stone-600',
    swatch: 'bg-stone-500',
  },
  {
    key: 'slate',
    chip: 'bg-slate-100 text-slate-600',
    text: 'text-slate-600',
    swatch: 'bg-slate-500',
  },
  {
    key: 'zinc',
    chip: 'bg-zinc-100 text-zinc-600',
    text: 'text-zinc-600',
    swatch: 'bg-zinc-500',
  },
]

const COLOR_BY_KEY = new Map(AGENT_COLORS.map((c) => [c.key, c]))

export const DEFAULT_AGENT_COLOR = 'violet'

export function agentColor(key: string | null | undefined): AgentColor {
  return (
    (key && COLOR_BY_KEY.get(key)) ||
    COLOR_BY_KEY.get(DEFAULT_AGENT_COLOR) ||
    AGENT_COLORS[0]
  )
}
