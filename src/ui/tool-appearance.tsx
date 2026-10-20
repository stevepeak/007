import type { ToolOption } from '../server/protocol'

import { agentColor } from './agent-appearance'
import { cn } from './cn'
import { ToolIcon } from './tool-icon'

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

// Chip box and icon size per avatar size. The small chips are `rounded`, the
// card-scale ones `rounded-lg`.
const AVATAR_SIZES = {
  xs: { box: 'size-5 rounded', icon: 'size-3.5' },
  sm: { box: 'size-6 rounded', icon: 'size-4' },
  md: { box: 'size-7 rounded', icon: 'size-4' },
  lg: { box: 'size-10 rounded-lg', icon: 'size-6' },
  xl: { box: 'size-12 rounded-lg', icon: 'size-7' },
} as const

export type ToolAvatarSize = keyof typeof AVATAR_SIZES

/**
 * A tool's icon on its tinted chip — the one look a tool has on every surface.
 * `tool` may be missing (an id the catalog doesn't know): the chip falls back
 * to neutral and the icon to the generic wrench. `iconClassName` replaces the
 * size's icon class rather than adding to it (`cn` doesn't merge Tailwind).
 */
export function ToolAvatar({
  tool,
  size,
  className,
  iconClassName,
}: {
  tool:
    | Pick<ToolOption, 'color' | 'icon' | 'iconName' | 'iconUrl'>
    | null
    | undefined
  size: ToolAvatarSize
  className?: string
  iconClassName?: string
}) {
  const { box, icon } = AVATAR_SIZES[size]
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center overflow-hidden',
        box,
        toolChip(tool?.color ?? null),
        className,
      )}
    >
      <ToolIcon
        icon={tool?.icon}
        iconName={tool?.iconName}
        iconUrl={tool?.iconUrl}
        className={iconClassName ?? icon}
      />
    </span>
  )
}
