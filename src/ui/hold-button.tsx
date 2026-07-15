import { useEffect, useRef, useState, type ReactNode } from 'react'

import { cn } from './cn'

// Press-and-hold confirm button for destructive-ish actions (e.g. Archive), so a
// stray click can't fire them. Hold for `duration` ms — a fill sweeps across and
// the action fires at 100%; release early to cancel. Matches the ghost Button
// look from primitives so it drops into the same toolbars. Works with pointer or
// keyboard (hold Enter / Space).

export function HoldButton({
  onHold,
  children,
  duration = 700,
  size = 'sm',
  tone = 'ghost',
  title = 'Hold to confirm',
  className,
}: {
  /** Fired once the hold completes. */
  onHold: () => void
  children: ReactNode
  /** Hold time in ms before the action fires. */
  duration?: number
  size?: 'sm' | 'md'
  /** `ghost` blends into a toolbar; `danger` reads as a prominent confirm. */
  tone?: 'ghost' | 'danger'
  title?: string
  className?: string
}) {
  const [progress, setProgress] = useState(0)
  const raf = useRef<number | null>(null)
  const startedAt = useRef(0)

  const cancel = () => {
    if (raf.current != null) {
      cancelAnimationFrame(raf.current)
      raf.current = null
    }
    startedAt.current = 0
    setProgress(0)
  }

  const begin = () => {
    if (raf.current != null) return
    startedAt.current = 0
    const loop = (now: number) => {
      if (startedAt.current === 0) startedAt.current = now
      const p = Math.min(1, (now - startedAt.current) / duration)
      setProgress(p)
      if (p >= 1) {
        raf.current = null
        startedAt.current = 0
        setProgress(0)
        onHold()
        return
      }
      raf.current = requestAnimationFrame(loop)
    }
    raf.current = requestAnimationFrame(loop)
  }

  // Stop the loop if we unmount mid-hold (e.g. the action navigates away).
  useEffect(() => cancel, [])

  const holding = progress > 0
  const danger = tone === 'danger'

  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onPointerDown={begin}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          begin()
        }
      }}
      onKeyUp={cancel}
      onBlur={cancel}
      className={cn(
        'relative inline-flex select-none items-center justify-center gap-1.5 overflow-hidden rounded-md font-medium transition-colors',
        size === 'sm' ? 'h-8 px-2.5 text-xs' : 'h-9 px-3.5 text-sm',
        danger && 'border border-red-300',
        holding
          ? danger
            ? 'text-red-700'
            : 'text-red-600'
          : danger
            ? 'text-red-600 hover:bg-red-50'
            : 'text-neutral-600 hover:bg-neutral-100',
        className,
      )}
    >
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 bg-red-100"
        style={{ width: `${progress * 100}%` }}
      />
      <span className="relative z-10 inline-flex items-center gap-1.5">
        {children}
      </span>
    </button>
  )
}
