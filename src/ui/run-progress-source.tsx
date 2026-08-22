import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

import type { RunSurfaceItem, RunSurfaceStatus } from './run-progress-view'

// The SINGLE progress-consumption interface a 007 client wires up once and
// reuses everywhere. The SDK owns the shape (the snapshot, the hook, the toast);
// the host owns the transport — it supplies ONE `fetch(runId)` that returns a
// snapshot (typically a poll of the persisted progress feed). Every surface
// (inline component, toast, a chat's "what's happening", a document's
// "Generating summary…") then consumes the same hook/component with just a run
// id. No per-surface bespoke wiring, no live-connection/token coupling.

/** A point-in-time view of a run's user-facing progress. */
export type RunProgressSnapshot = {
  status: RunSurfaceStatus
  items: RunSurfaceItem[]
  /** Optional determinate-bar count; omit for an indeterminate bar. */
  progress?: { completed: number; total: number }
}

/** The host-supplied transport: resolve a run id to its current snapshot. */
export type RunProgressFetcher = (runId: string) => Promise<RunProgressSnapshot>

/** A minimal toast surface the host adapts to its toaster (e.g. sonner). */
export type RunProgressToaster = {
  loading: (id: string, message: string) => void
  success: (id: string, message: string) => void
  error: (id: string, message: string) => void
  dismiss: (id: string) => void
}

type ProgressContext = {
  fetch: RunProgressFetcher
  pollMs: number
  maxFailures: number
  maxBackoffMs: number
  maxDurationMs: number
}

const RunProgressContext = createContext<ProgressContext | null>(null)

/**
 * Defaults for the poll loop's self-limiting behavior — see {@link nextPollDelay}.
 */
const DEFAULT_POLL_MS = 1500
const DEFAULT_MAX_FAILURES = 6
const DEFAULT_MAX_BACKOFF_MS = 30_000
const DEFAULT_MAX_DURATION_MS = 15 * 60_000

/**
 * How long to wait before the next poll, given how many times in a row the
 * fetch has failed. A healthy loop stays at `pollMs`; a failing one backs off
 * exponentially up to `maxBackoffMs`.
 *
 * This exists because the loop used to retry a failed fetch at the SAME fixed
 * cadence forever. When the host was failing *because* it was overloaded, every
 * mounted surface kept hammering it — the poll stopped being a symptom of the
 * outage and became its engine. Backing off (and eventually giving up, see
 * `maxFailures`) is what lets an overloaded host recover.
 *
 * Jittered so that many surfaces/tabs that started together don't stay in
 * lockstep and re-converge on the host as one synchronized wave.
 */
export function nextPollDelay(
  failures: number,
  opts: { pollMs: number; maxBackoffMs: number },
  random: () => number = Math.random,
): number {
  if (failures <= 0) return opts.pollMs
  const backoff = Math.min(
    opts.pollMs * 2 ** failures,
    Math.max(opts.pollMs, opts.maxBackoffMs),
  )
  // ±20% jitter.
  return Math.round(backoff * (0.8 + random() * 0.4))
}

/**
 * Provide the progress transport once (high in the host's tree). `useRunProgress`
 * anywhere below then just takes a run id. `pollMs` is the poll cadence while a
 * run is still running (it stops once terminal).
 *
 * The loop is bounded three ways, so it can always end: it stops when the run
 * settles, when `maxFailures` fetches have failed back-to-back, and when a run
 * has been watched for `maxDurationMs` without settling (a run whose host row
 * is stranded mid-flight would otherwise be polled forever).
 */
export function WorkflowProgressProvider({
  fetch,
  pollMs = DEFAULT_POLL_MS,
  maxFailures = DEFAULT_MAX_FAILURES,
  maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
  maxDurationMs = DEFAULT_MAX_DURATION_MS,
  children,
}: {
  fetch: RunProgressFetcher
  pollMs?: number
  /** Consecutive failed fetches before the loop gives up. */
  maxFailures?: number
  /** Ceiling on the exponential backoff between failed polls. */
  maxBackoffMs?: number
  /** Wall-clock ceiling on watching a single run that never settles. */
  maxDurationMs?: number
  children: ReactNode
}) {
  const value = useMemo(
    () => ({ fetch, pollMs, maxFailures, maxBackoffMs, maxDurationMs }),
    [fetch, pollMs, maxFailures, maxBackoffMs, maxDurationMs],
  )
  return <RunProgressContext.Provider value={value}>{children}</RunProgressContext.Provider>
}

function useProgressContext(): ProgressContext {
  const ctx = useContext(RunProgressContext)
  if (!ctx) {
    throw new Error(
      'useRunProgress requires a <WorkflowProgressProvider> above it.',
    )
  }
  return ctx
}

const EMPTY: RunProgressSnapshot = { status: 'running', items: [] }

/**
 * Subscribe to a run's progress by id. Polls the provider's `fetch` while the
 * run is running and stops when it settles. Feed the result straight into
 * {@link WorkflowRunProgress}. Pass `null` to stay idle (e.g. before a run id
 * exists).
 */
export function useRunProgress(runId: string | null): RunProgressSnapshot {
  const { fetch, pollMs, maxFailures, maxBackoffMs, maxDurationMs } =
    useProgressContext()
  const [snap, setSnap] = useState<RunProgressSnapshot>(EMPTY)

  useEffect(() => {
    if (!runId) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    let failures = 0
    const startedAt = Date.now()

    // We stopped watching without the run settling — either the transport kept
    // failing or the run outlived `maxDurationMs`. Surface it as terminal so
    // the UI stops spinning; the run itself may well still be going server-side,
    // which is why we leave the timeline we already have intact.
    const giveUp = () => {
      setSnap((prev) =>
        prev.status === 'running' ? { ...prev, status: 'failed' } : prev,
      )
    }

    const tick = async () => {
      let next: RunProgressSnapshot | null = null
      try {
        next = await fetch(runId)
      } catch {
        next = null
      }
      if (!alive) return
      if (next) {
        failures = 0
        setSnap(next)
        if (next.status !== 'running') return // settled — we're done
      } else {
        failures += 1
        if (failures >= maxFailures) return giveUp()
      }
      if (Date.now() - startedAt >= maxDurationMs) return giveUp()
      timer = setTimeout(
        () => void tick(),
        nextPollDelay(failures, { pollMs, maxBackoffMs }),
      )
    }
    void tick()
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
  }, [runId, fetch, pollMs, maxFailures, maxBackoffMs, maxDurationMs])

  return runId ? snap : EMPTY
}

/**
 * Build a pre-packaged progress TOAST driver — the SDK's convenience for hosts
 * that want a fire-and-forget "follow this run" toast (e.g. right after a
 * document upload). Configure it ONCE with the same `fetch` plus a `toast`
 * adapter, then call the returned function with a run id. It polls to terminal
 * and settles the toast to success/failure. Imperative (no hook), so it fits
 * non-React flows like an upload loop.
 */
export function createRunProgressToast(deps: {
  fetch: RunProgressFetcher
  toast: RunProgressToaster
  pollMs?: number
  maxFailures?: number
  maxBackoffMs?: number
  maxDurationMs?: number
}): (runId: string, opts: { label: string; successMessage?: string }) => void {
  const {
    fetch,
    toast,
    pollMs = DEFAULT_POLL_MS,
    maxFailures = DEFAULT_MAX_FAILURES,
    maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
    maxDurationMs = DEFAULT_MAX_DURATION_MS,
  } = deps
  return (runId, opts) => {
    const toastId = `run-progress-${runId}`
    let settled = false
    let failures = 0
    const startedAt = Date.now()
    toast.loading(toastId, `${opts.label}…`)

    // Same three bounds as `useRunProgress`: settle, give up after
    // `maxFailures` back-to-back transport failures, or hit the wall clock.
    const giveUp = () => {
      settled = true
      toast.error(toastId, `${opts.label} failed`)
    }

    const tick = async () => {
      if (settled) return
      let snap: RunProgressSnapshot | null = null
      try {
        snap = await fetch(runId)
      } catch {
        snap = null
      }
      if (settled) return
      if (!snap || snap.status === 'running') {
        if (snap) {
          failures = 0
          const latest = snap.items.findLast((i) => i.kind === 'progress')
          if (latest && latest.kind === 'progress') {
            toast.loading(toastId, `${opts.label}: ${latest.message}`)
          }
        } else {
          failures += 1
          if (failures >= maxFailures) return giveUp()
        }
        if (Date.now() - startedAt >= maxDurationMs) return giveUp()
        setTimeout(
          () => void tick(),
          nextPollDelay(failures, { pollMs, maxBackoffMs }),
        )
        return
      }
      settled = true
      if (snap.status === 'completed') {
        toast.success(toastId, opts.successMessage ?? `${opts.label} complete`)
      } else {
        toast.error(toastId, `${opts.label} failed`)
      }
    }
    void tick()
  }
}
