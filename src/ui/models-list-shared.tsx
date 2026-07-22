import {
  Braces,
  Eye,
  Sparkles,
  Wrench,
  type LucideIcon,
} from 'lucide-react'

import type { AgentUsageRef, ModelCapabilities } from '../server/protocol'

export type UsageMap = Record<string, AgentUsageRef[]>
export const NO_AGENTS: AgentUsageRef[] = []

// ── Filters ──────────────────────────────────────────────────────────────────

export const CAP_FILTERS: {
  key: keyof ModelCapabilities
  label: string
  icon: LucideIcon
}[] = [
  { key: 'tools', label: 'Tools', icon: Wrench },
  { key: 'reasoning', label: 'Reasoning', icon: Sparkles },
  { key: 'vision', label: 'Vision', icon: Eye },
  { key: 'structuredOutput', label: 'Structured', icon: Braces },
]

export type ChosenFilter = 'all' | 'enabled' | 'disabled'
export type AgeFilter = 'any' | 'new' | 'recent' | 'older'

export const AGE_MAX_DAYS: Record<Exclude<AgeFilter, 'any' | 'older'>, number> = {
  new: 30,
  recent: 90,
}

export const DAY_MS = 86_400_000

/** Compact context-window label, e.g. 200000 → "200k", 1048576 → "1M". */
export function formatContext(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

/** Compact relative age from an epoch-ms release date, e.g. "5d", "3mo", "2y". */
export function formatAge(releasedAt: number): string {
  const days = Math.max(0, (Date.now() - releasedAt) / DAY_MS)
  if (days < 1) return 'today'
  if (days < 30) return `${Math.round(days)}d`
  if (days < 365) return `${Math.round(days / 30)}mo`
  return `${(days / 365).toFixed(1)}y`
}
