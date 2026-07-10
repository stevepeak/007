import {
  Bot,
  Brain,
  Briefcase,
  BookText,
  FileSearch,
  Gavel,
  MessageSquare,
  Scale,
  ShieldCheck,
  Sparkles,
  type LucideIcon,
} from 'lucide-react'

// The palette an agent card / editor draws from. Icons are stored by name and
// colors by key on `wf_agent`, so the set stays small and serializable. Full
// literal Tailwind class strings so v4's scanner keeps them.

export const AGENT_ICONS: { name: string; Icon: LucideIcon }[] = [
  { name: 'Bot', Icon: Bot },
  { name: 'Scale', Icon: Scale },
  { name: 'Gavel', Icon: Gavel },
  { name: 'BookText', Icon: BookText },
  { name: 'FileSearch', Icon: FileSearch },
  { name: 'ShieldCheck', Icon: ShieldCheck },
  { name: 'Briefcase', Icon: Briefcase },
  { name: 'Brain', Icon: Brain },
  { name: 'MessageSquare', Icon: MessageSquare },
  { name: 'Sparkles', Icon: Sparkles },
]

const ICON_BY_NAME = new Map(AGENT_ICONS.map((i) => [i.name, i.Icon]))

export const DEFAULT_AGENT_ICON = 'Bot'

export function agentIcon(name: string | null | undefined): LucideIcon {
  return (name && ICON_BY_NAME.get(name)) || Bot
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
