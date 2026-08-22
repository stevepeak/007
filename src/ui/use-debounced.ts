import { useEffect, useState } from 'react'

/**
 * A value that settles `delayMs` after it stops changing. For typed input that
 * drives a server query — the field stays responsive while only the pause
 * reaches the network.
 */
export function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(id)
  }, [value, delayMs])
  return debounced
}
