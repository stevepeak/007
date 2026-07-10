import { Wrench } from 'lucide-react'

import { cn } from './cn'

// Renders a tool's inline-SVG brand icon (trusted, SDK/host-defined) or a
// neutral fallback. Used wherever tools are shown to end users.

export type ToolIconProps = {
  icon?: string | null
  className?: string
}

export function ToolIcon({ icon, className }: ToolIconProps) {
  if (icon) {
    return (
      <span
        className={cn(
          'inline-flex shrink-0 items-center justify-center',
          className,
        )}
        // Trusted markup: tool icons are defined by the SDK or the host, never
        // by user input.
        dangerouslySetInnerHTML={{ __html: icon }}
      />
    )
  }
  return <Wrench className={cn('text-neutral-400', className)} />
}
