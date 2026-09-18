import { Wrench } from 'lucide-react'

import { ALL_AGENT_ICONS } from './agent-appearance'
import { cn } from './cn'

// Renders a tool's icon: a third-party inline-SVG brand mark (trusted,
// SDK/host-defined), a first-party lucide icon (by name), the image an MCP
// server advertised about itself (untrusted, `<img>` only), or a neutral
// fallback — in that order. Used wherever tools are shown to end users. A
// lucide icon inherits its color from the surrounding chip (see `toolChip`);
// the SVG, the image and the fallback carry their own color.

export type ToolIconProps = {
  /** Inline SVG brand mark (trusted). Takes precedence over everything. */
  icon?: string | null
  /** Lucide icon name (PascalCase), e.g. `Calculator`. */
  iconName?: string | null
  /** Untrusted image URL (an MCP server's own icon). Lowest precedence. */
  iconUrl?: string | null
  className?: string
}

export function ToolIcon({ icon, iconName, iconUrl, className }: ToolIconProps) {
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
  if (iconUrl) return <RemoteIcon src={iconUrl} className={className} />
  return <Wrench className={cn('text-neutral-400', className)} />
}

/**
 * A third party's icon, kept at arm's length: an `<img>` with a vetted `src`
 * (see `pickServerIcon` in connectors/client.ts), so it can draw pixels and
 * nothing else — no inline markup, no scripts, no referrer leaked. Deliberately
 * not `crossOrigin`: that makes a host without CORS headers fail to load at
 * all, and brand-asset CDNs rarely send them.
 */
export function RemoteIcon({
  src,
  className,
}: {
  src: string
  className?: string
}) {
  return (
    <img
      src={src}
      alt=""
      aria-hidden
      referrerPolicy="no-referrer"
      className={cn('shrink-0 rounded-sm object-contain', className)}
    />
  )
}
