import { type ReactNode, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { cn } from './cn'

// Lightweight, dependency-free hover tooltip. Replaces native `title=` tooltips
// so the SDK renders a consistent, styled bubble instead of the browser default.
// The bubble is PORTALED to `document.body` and positioned with `fixed` coords
// off the trigger's rect — a CSS-only `absolute` bubble gets trapped inside (and
// painted under) ancestor stacking contexts like the ReactFlow graph canvas, so
// no z-index on an in-flow bubble can lift it out. The portal escapes that.
export type WfTooltipProps = {
  content: ReactNode
  children: ReactNode
  side?: 'top' | 'bottom' | 'left' | 'right'
  /** Extra classes for the wrapper (e.g. `block` to stack in a list). */
  className?: string
}

// Gap between the trigger and the bubble, in px.
const GAP = 6

// The bubble is a `fixed` element; we anchor it to a point on the trigger's rect
// (viewport coords) and shift it into place with a transform per side.
function anchor(
  side: NonNullable<WfTooltipProps['side']>,
  r: DOMRect,
): { top: number; left: number } {
  switch (side) {
    case 'bottom':
      return { top: r.bottom, left: r.left + r.width / 2 }
    case 'left':
      return { top: r.top + r.height / 2, left: r.left }
    case 'right':
      return { top: r.top + r.height / 2, left: r.right }
    default:
      return { top: r.top, left: r.left + r.width / 2 }
  }
}

const transformFor: Record<NonNullable<WfTooltipProps['side']>, string> = {
  top: `translate(-50%, calc(-100% - ${GAP}px))`,
  bottom: `translate(-50%, ${GAP}px)`,
  left: `translate(calc(-100% - ${GAP}px), -50%)`,
  right: `translate(${GAP}px, -50%)`,
}

export function Tooltip({
  content,
  children,
  side = 'top',
  className,
}: WfTooltipProps) {
  const ref = useRef<HTMLSpanElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  // Nothing to show — render the trigger untouched.
  if (content == null || content === '') return <>{children}</>

  function show() {
    const el = ref.current
    if (el) setPos(anchor(side, el.getBoundingClientRect()))
  }

  return (
    <span
      ref={ref}
      className={cn('relative inline-flex', className)}
      onMouseEnter={show}
      onMouseLeave={() => setPos(null)}
    >
      {children}
      {pos && typeof document !== 'undefined'
        ? createPortal(
            <span
              role="tooltip"
              style={{
                position: 'fixed',
                top: pos.top,
                left: pos.left,
                transform: transformFor[side],
              }}
              className={cn(
                'pointer-events-none z-[1000] w-max max-w-xs whitespace-normal break-words rounded-md bg-neutral-900 px-2 py-1 text-left text-xs font-normal text-white shadow-md',
              )}
            >
              {content}
            </span>,
            document.body,
          )
        : null}
    </span>
  )
}
