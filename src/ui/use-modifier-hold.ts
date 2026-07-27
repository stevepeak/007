import { useEffect, useState } from 'react'

// Returns true only while both Cmd (meta) and Control are held down. Used to
// gate rarely-needed / destructive controls (Archive, New workflow) so they're
// hidden by default and only surface during a deliberate two-key hold. Resets
// on blur / tab hide so the keys can't get "stuck" if a keyup is missed.
export function useModifierHold(): boolean {
  const [held, setHeld] = useState(false)

  useEffect(() => {
    const sync = (e: KeyboardEvent) => setHeld(e.metaKey && e.ctrlKey)
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
  }, [])

  return held
}
