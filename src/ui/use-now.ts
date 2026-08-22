import { useCallback, useEffect, useState } from 'react'

// Reading `Date.now()` while rendering is impure: the value moves on every
// render, so anything derived from it — a query window, an age bucket, an
// elapsed duration — is silently different each pass and can never settle. It's
// why a `useMemo` over a time window can't hold: the memo hands back a new
// object whenever React happens to re-run it, and react-query reads that as a
// new key. React's compiler rejects the pattern outright.
//
// The fix isn't to stop using the clock, it's to say WHEN it was read. These two
// hooks are the two honest answers: read it when the user acts, or read it on a
// timer. Nothing here reads it during render.

/**
 * A picked value and the instant it was picked.
 *
 * This is what a query WINDOW wants. `since: pickedAt - 24h` has to name a
 * fixed instant, or paging through results quietly slides the window out from
 * under the offsets. Anchoring on an EVENT rather than an effect is what keeps
 * it to one fetch: an effect would re-anchor a render late, after the memo had
 * already built (and fired) a window against the previous timestamp.
 *
 * Returns the tuple in `useState` order — value, setter — with the timestamp
 * between them, so it drops into an existing `const [x, setX] = useState(…)`.
 */
export function usePickedAt<T>(initial: T): [T, number, (next: T) => void] {
  const [picked, setPicked] = useState(() => ({
    // A lazy initialiser runs once, on mount — not on every render — so this is
    // a capture, not a read during render.
    value: initial,
    at: Date.now(),
  }))
  const pick = useCallback((next: T) => {
    setPicked({ value: next, at: Date.now() })
  }, [])
  return [picked.value, picked.at, pick]
}

/**
 * "Now", re-read on a timer — deliberately live.
 *
 * This is what an ELAPSED DURATION wants: a running clock beside a run that
 * hasn't finished. Pass `null` to stop the timer — a finished run's duration is
 * fixed, and ticking it would re-render the page forever for no change.
 */
export function useTickingNow(intervalMs: number | null): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (intervalMs == null) return
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])

  return now
}
