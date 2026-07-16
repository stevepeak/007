import {
  Activity,
  Bot,
  Target,
  Wrench,
  Workflow as WorkflowIcon,
  type LucideIcon,
} from 'lucide-react'

import type { WfCrumb } from './shell'

// The canonical breadcrumb root for each top-level 007 section — its icon and
// signature color, matching the hub cards (see DEFAULT_WF_SECTIONS). Use
// sectionCrumb() so every section reads consistently: Evals / … , Workflows / … .

type WfSectionKey = 'workflows' | 'agents' | 'tools' | 'runs' | 'evals'

const SECTIONS: Record<
  WfSectionKey,
  { title: string; icon: LucideIcon; iconClassName: string; to: string }
> = {
  workflows: { title: 'Workflows', icon: WorkflowIcon, iconClassName: 'text-indigo-500', to: 'workflows' },
  agents: { title: 'Agents', icon: Bot, iconClassName: 'text-violet-500', to: 'agents' },
  tools: { title: 'Tools', icon: Wrench, iconClassName: 'text-emerald-500', to: 'tools' },
  runs: { title: 'Runs', icon: Activity, iconClassName: 'text-sky-500', to: 'runs' },
  evals: { title: 'Evals', icon: Target, iconClassName: 'text-rose-500', to: 'evals' },
}

/**
 * Root breadcrumb for a section — its colored icon + title. Links to the
 * section's landing page by default; pass `current: true` on that landing page
 * itself (no link), or `to` to override the destination (e.g. a scoped runs list).
 */
export function sectionCrumb(
  key: WfSectionKey,
  opts?: { to?: string; current?: boolean },
): WfCrumb {
  const s = SECTIONS[key]
  return {
    label: s.title,
    to: opts?.current ? undefined : (opts?.to ?? s.to),
    icon: s.icon,
    iconClassName: s.iconClassName,
  }
}
