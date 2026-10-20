import { Lock } from 'lucide-react'
import type { ButtonHTMLAttributes } from 'react'

import { cn } from './cn'

// The console's one on/off switch: a pill track with a sliding thumb. Green when
// on, or red for `tone: 'risk'` — an "on" that can change real data.

const TRACK =
  'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors'
const THUMB =
  'inline-flex size-4 transform items-center justify-center rounded-full bg-white shadow transition-transform'

export function Switch({
  checked,
  onChange,
  disabled,
  locked,
  tone = 'ok',
  label,
  ariaLabel,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  /** Shown as locked (a lock on the thumb) and non-interactive, but not dimmed. */
  locked?: boolean
  tone?: 'ok' | 'risk'
  /** Visible text beside the track; the whole row is the click target. */
  label?: string
  ariaLabel?: string
}) {
  const blocked = disabled || locked
  const track = cn(
    TRACK,
    checked
      ? tone === 'risk'
        ? 'bg-rose-500'
        : 'bg-emerald-500'
      : 'bg-neutral-200',
  )
  const thumb = (
    <span className={cn(THUMB, checked ? 'translate-x-4' : 'translate-x-0.5')}>
      {locked ? <Lock className="size-2.5 text-neutral-400" /> : null}
    </span>
  )
  const button: ButtonHTMLAttributes<HTMLButtonElement> = {
    type: 'button',
    role: 'switch',
    'aria-checked': checked,
    'aria-label': ariaLabel,
    'aria-disabled': blocked,
    disabled: blocked,
    onClick: () => onChange(!checked),
  }

  if (label != null) {
    return (
      <button
        {...button}
        className="flex items-center gap-2 py-2 text-sm text-neutral-600 transition-colors hover:text-neutral-900"
      >
        <span className={track}>{thumb}</span>
        {label}
      </button>
    )
  }
  return (
    <button
      {...button}
      className={cn(
        track,
        locked && 'cursor-not-allowed',
        disabled && !locked && 'cursor-not-allowed opacity-60',
      )}
    >
      {thumb}
    </button>
  )
}
