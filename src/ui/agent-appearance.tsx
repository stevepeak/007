import { Bot, icons, type LucideIcon } from 'lucide-react'

// The palette an agent card / editor draws from. Icons are stored by their
// PascalCase lucide name and colors by key on `wf_agent`, so both stay small and
// serializable. Any of lucide's ~1750 icons is a valid stored value (resolved
// through `agentIcon`); `AGENT_ICONS` is just the curated quick-pick row shown
// before the user opens the full searchable picker. Full literal Tailwind class
// strings below so v4's scanner keeps them.

// Every lucide icon, keyed by its PascalCase name (e.g. `Bot`, `FileSearch`).
export const ALL_AGENT_ICONS = icons as Record<string, LucideIcon>

// All icon names, sorted for stable ordering in the picker.
export const ALL_AGENT_ICON_NAMES: string[] = Object.keys(ALL_AGENT_ICONS).sort()

// A curated shortlist surfaced as quick picks in the editor's appearance row.
export const AGENT_ICONS: { name: string; Icon: LucideIcon }[] = [
  'Bot',
  'Scale',
  'Gavel',
  'BookText',
  'FileSearch',
  'ShieldCheck',
  'Briefcase',
  'Brain',
  'MessageSquare',
  'Sparkles',
].map((name) => ({ name, Icon: ALL_AGENT_ICONS[name] }))

export const DEFAULT_AGENT_ICON = 'Bot'

export function agentIcon(name: string | null | undefined): LucideIcon {
  return (name && ALL_AGENT_ICONS[name]) || Bot
}

export type AgentColor = {
  key: string
  /** Icon-chip classes: soft tinted background + saturated foreground. */
  chip: string
  /** A single dot color (swatch) for the picker. */
  swatch: string
}

export const AGENT_COLORS: AgentColor[] = [
  {
    key: 'violet',
    chip: 'bg-violet-100 text-violet-600',
    swatch: 'bg-violet-500',
  },
  {
    key: 'emerald',
    chip: 'bg-emerald-100 text-emerald-600',
    swatch: 'bg-emerald-500',
  },
  { key: 'sky', chip: 'bg-sky-100 text-sky-600', swatch: 'bg-sky-500' },
  { key: 'amber', chip: 'bg-amber-100 text-amber-600', swatch: 'bg-amber-500' },
  { key: 'rose', chip: 'bg-rose-100 text-rose-600', swatch: 'bg-rose-500' },
  {
    key: 'indigo',
    chip: 'bg-indigo-100 text-indigo-600',
    swatch: 'bg-indigo-500',
  },
  { key: 'teal', chip: 'bg-teal-100 text-teal-600', swatch: 'bg-teal-500' },
  { key: 'slate', chip: 'bg-slate-100 text-slate-600', swatch: 'bg-slate-500' },
]

const COLOR_BY_KEY = new Map(AGENT_COLORS.map((c) => [c.key, c]))

export const DEFAULT_AGENT_COLOR = 'violet'

export function agentColor(key: string | null | undefined): AgentColor {
  return (key && COLOR_BY_KEY.get(key)) || AGENT_COLORS[0]
}
