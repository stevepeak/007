import { AGENT_COLORS, type AgentColor, agentColor } from './agent-appearance'

// Tools reuse the shared appearance palette (see `agent-appearance`): icons are
// stored as lucide PascalCase names and colors as palette keys, so a tool card
// and an agent card read as one design language. These thin re-exports give the
// tool call-sites a domain-appropriate name instead of reaching for `agent*`.

export type ToolColor = AgentColor

/** The palette a tool's icon chip draws from — the same 8 keys agents use. */
export const TOOL_COLORS = AGENT_COLORS

/** Resolve a tool's stored color key to its chip/swatch classes. */
export const toolColor = agentColor

/**
 * The chip classes wrapping a tool's icon: the tool's tinted palette color when
 * set, else a neutral gray (the historical default for icon-less tools).
 */
export function toolChip(color: string | null | undefined): string {
  return color ? toolColor(color).chip : 'bg-neutral-100 text-neutral-500'
}
