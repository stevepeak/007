import { useEffect, useState } from 'react'

// Which two-key hold reveals a control. Used to gate rarely-needed /
// destructive actions so they're hidden by default and only surface during a
// deliberate hold:
//   'meta+ctrl' — Cmd + Control. The default (Archive, New workflow).
//   'meta+alt'  — Cmd + Option. Reserved for the harshest actions (Delete all
//                 runs), so a muscle-memory hold for the everyday controls
//                 can't surface an irreversible one.
export type ModifierCombo = 'meta+ctrl' | 'meta+alt'

const MATCHERS: Record<ModifierCombo, (e: KeyboardEvent) => boolean> = {
  'meta+ctrl': (e) => e.metaKey && e.ctrlKey,
  'meta+alt': (e) => e.metaKey && e.altKey,
}

// Returns true only while the combo's keys are both held down. Resets on blur /
// tab hide so the keys can't get "stuck" if a keyup is missed.
export function useModifierHold(combo: ModifierCombo = 'meta+ctrl'): boolean {
  const [held, setHeld] = useState(false)

  useEffect(() => {
    const matches = MATCHERS[combo]
    const sync = (e: KeyboardEvent) => setHeld(matches(e))
    const clear = () => setHeld(false)

    window.addEventListener('keydown', sync)
    window.addEventListener('keyup', sync)
    window.addEventListener('blur', clear)
    document.addEventListener('visibilitychange', clear)
    return () => {
      window.removeEventListener('keydown', sync)
      window.removeEventListener('keyup', sync)
      window.removeEventListener('blur', clear)
      document.removeEventListener('visibilitychange', clear)
    }
  }, [combo])

  return held
}
