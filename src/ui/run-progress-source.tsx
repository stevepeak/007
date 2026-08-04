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
}

const Ctx = createContext<ProgressContext | null>(null)

/**
 * Provide the progress transport once (high in the host's tree). `useRunProgress`
 * anywhere below then just takes a run id. `pollMs` is the poll cadence while a
 * run is still running (it stops once terminal).
 */
export function WorkflowProgressProvider({
  fetch,
  pollMs = 1500,
  children,
}: {
  fetch: RunProgressFetcher
  pollMs?: number
  children: ReactNode
}) {
  const value = useMemo(() => ({ fetch, pollMs }), [fetch, pollMs])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

function useProgressContext(): ProgressContext {
  const ctx = useContext(Ctx)
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
  const { fetch, pollMs } = useProgressContext()
  const [snap, setSnap] = useState<RunProgressSnapshot>(EMPTY)

  useEffect(() => {
    if (!runId) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async () => {
      let next: RunProgressSnapshot | null = null
      try {
        next = await fetch(runId)
      } catch {
        next = null
      }
      if (!alive) return
      if (next) setSnap(next)
      // Keep polling until the run is terminal (retry on transient fetch error).
      if (!next || next.status === 'running') {
        timer = setTimeout(() => void tick(), pollMs)
      }
    }
    void tick()
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
  }, [runId, fetch, pollMs])

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
}): (runId: string, opts: { label: string; successMessage?: string }) => void {
  const { fetch, toast, pollMs = 1500 } = deps
  return (runId, opts) => {
    const toastId = `run-progress-${runId}`
    let settled = false
    toast.loading(toastId, `${opts.label}…`)

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
        const latest = snap?.items.findLast((i) => i.kind === 'progress')
        if (latest && latest.kind === 'progress') {
          toast.loading(toastId, `${opts.label}: ${latest.message}`)
        }
        setTimeout(() => void tick(), pollMs)
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
