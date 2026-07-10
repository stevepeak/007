import type { ReactNode } from 'react'

import { cn } from './cn'

// Lightweight, dependency-free hover tooltip. Replaces native `title=` tooltips
// so the SDK renders a consistent, styled bubble instead of the browser default.
// Pure CSS group-hover — no radix/portal, keeping the SDK's dep surface thin (see
// primitives.tsx). The host's Tailwind runtime supplies the utilities.
export type WfTooltipProps = {
  content: ReactNode
  children: ReactNode
  side?: 'top' | 'bottom' | 'left' | 'right'
  /** Extra classes for the wrapper (e.g. `block` to stack in a list). */
  className?: string
}

const sideClasses: Record<NonNullable<WfTooltipProps['side']>, string> = {
  top: 'bottom-full left-1/2 mb-1.5 -translate-x-1/2',
  bottom: 'top-full left-1/2 mt-1.5 -translate-x-1/2',
  left: 'right-full top-1/2 mr-1.5 -translate-y-1/2',
  right: 'left-full top-1/2 ml-1.5 -translate-y-1/2',
}

export function Tooltip({
  content,
  children,
  side = 'top',
  className,
}: WfTooltipProps) {
  // Nothing to show — render the trigger untouched.
  if (content == null || content === '') return <>{children}</>

  return (
    <span className={cn('group/tooltip relative inline-flex', className)}>
      {children}
      <span
        role="tooltip"
        className={cn(
          'pointer-events-none absolute z-50 w-max max-w-xs whitespace-normal break-words rounded-md bg-neutral-900 px-2 py-1 text-left text-xs font-normal text-white shadow-md',
          'opacity-0 transition-opacity duration-100 group-hover/tooltip:opacity-100',
          sideClasses[side],
        )}
      >
        {content}
      </span>
    </span>
  )
}
