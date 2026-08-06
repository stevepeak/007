import { agentColor } from './agent-appearance'

// Tools reuse the shared appearance palette (see `agent-appearance`): icons are
// stored as lucide PascalCase names and colors as palette keys, so a tool card
// and an agent card read as one design language. This thin re-export gives the
// tool call-sites a domain-appropriate name instead of reaching for `agent*`.

// Resolve a tool's stored color key to its chip/swatch classes.
const toolColor = agentColor

/**
 * The chip classes wrapping a tool's icon: the tool's tinted palette color when
 * set, else a neutral gray (the historical default for icon-less tools).
 */
export function toolChip(color: string | null | undefined): string {
  return color ? toolColor(color).chip : 'bg-neutral-100 text-neutral-500'
}

/**
 * Foreground-only classes for a tool icon drawn without a chip background (tab
 * strip, page header). Same palette as {@link toolChip}, same neutral default.
 * Set it on a *wrapper* so the icon inherits it — `ToolIcon`'s fallback carries
 * its own color and `cn` doesn't resolve competing Tailwind classes.
 */
export function toolText(color: string | null | undefined): string {
  return color ? toolColor(color).text : 'text-neutral-500'
}
