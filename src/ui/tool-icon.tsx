import { Wrench } from 'lucide-react'

import { ALL_AGENT_ICONS } from './agent-appearance'
import { cn } from './cn'

// Renders a tool's icon: a first-party lucide icon (by name), a third-party
// inline-SVG brand mark (trusted, SDK/host-defined), or a neutral fallback.
// Used wherever tools are shown to end users. A lucide icon inherits its color
// from the surrounding chip (see `toolChip`); the SVG and the fallback carry
// their own color.

export type ToolIconProps = {
  /** Inline SVG brand mark (trusted). Takes precedence over `iconName`. */
  icon?: string | null
  /** Lucide icon name (PascalCase), e.g. `Calculator`. */
  iconName?: string | null
  className?: string
}

export function ToolIcon({ icon, iconName, className }: ToolIconProps) {
  if (icon) {
    return (
      <span
        className={cn(
          'inline-flex shrink-0 items-center justify-center',
          className,
        )}
        // Trusted markup: tool icons come from the host's own `toolRegistry`
        // metadata (see `WfTool.icon` in server/protocol-tools.ts), authored in
        // code and never derived from user input. Sanitising would strip the
        // brand marks this exists to render.
        // eslint-disable-next-line @eslint-react/dom-no-dangerously-set-innerhtml
        dangerouslySetInnerHTML={{ __html: icon }}
      />
    )
  }
  const Icon = iconName ? ALL_AGENT_ICONS[iconName] : undefined
  if (Icon) {
    // No color of its own — inherits the chip's `text-*` (or ambient color).
    return <Icon className={className} />
  }
  return <Wrench className={cn('text-neutral-400', className)} />
}
