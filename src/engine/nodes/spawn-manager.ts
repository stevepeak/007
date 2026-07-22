import type { SubAgentTarget } from '../graph'

// The in-memory registry behind a delegating agent's `spawn_*` / `await_subagents`
// tools, for ONE execution of ONE agent node. Claude-Code-style: `spawn` kicks a
// sub-run off in the background and returns a handle immediately (the model keeps
// reasoning); `await_subagents` joins on the in-flight sub-runs and — the key
// affordance — SHORT-CIRCUITS as soon as a sub-run signals "important, must stop".
//
// Everything here is deterministic and replay-safe: ids are a monotonic counter
// (no Math.random / Date.now), so a durable `step.do` retry that replays the
// agent loop re-mints the identical spawn ids. Concurrency is bounded by a plain
// counting semaphore; the total is capped so a runaway model can't exceed budget.

/** What a single sub-run yields once it finishes. */
export type SpawnRunResult = {
  /** The sub-agent's/-workflow's Output value. */
  output: unknown
  /** Agent-target trace (AgentNodeMeta); omitted for workflow targets. */
  meta?: unknown
  /** True when the sub-run raised the stop signal (short-circuits joins). */
  stopSignalled: boolean
  /** The stop reason, when `stopSignalled`. */
  reason?: string
}

/** A launched sub-run and its evolving state. `promise` never rejects. */
export type SpawnHandle = {
  spawnId: string
  target: SubAgentTarget
  /** 0-based launch order — doubles as the child run-step `item_index`. */
  ordinal: number
  status: 'running' | 'completed' | 'failed'
  result?: SpawnRunResult
  error?: string
  /** Resolves (never rejects) when the sub-run settles. */
  promise: Promise<void>
}

/** Runs one sub-run to completion. Supplied by the engine wiring. */
export type RunSubAgent = (
  target: SubAgentTarget,
  input: unknown,
  ordinal: number,
) => Promise<SpawnRunResult>

/** The public target shape a handle reports back to the model. */
export type SpawnTargetRef = { kind: SubAgentTarget['kind']; id: string }

export type SpawnAccepted = { spawnId: string; target: SpawnTargetRef }
export type SpawnRejected = { error: string }

export type JoinCompleted = {
  spawnId: string
  target: SpawnTargetRef
  status: 'completed' | 'failed'
  output?: unknown
  stopSignalled: boolean
  reason?: string
  error?: string
}
export type JoinPending = { spawnId: string; target: SpawnTargetRef }
export type JoinResult = {
  completed: JoinCompleted[]
  /** Still-running sub-runs when a stop signal short-circuited the join. */
  pending: JoinPending[]
  /** True when a stop-signalled sub-run ended the join early. */
  stopped: boolean
}

export type CheckEntry = {
  spawnId: string
  target: SpawnTargetRef
  status: 'running' | 'completed' | 'failed'
  stopSignalled: boolean
}

// A minimal resolvable promise — used both for the concurrency semaphore's
// waiters and for the "a handle settled" wakeup the join loop parks on.
type Deferred = { promise: Promise<void>; resolve: () => void }
function makeDeferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

// Counting semaphore: `acquire()` resolves when a permit is free; `release()`
// hands the permit straight to the next waiter (no counter bump) or returns it
// to the pool. Bounds how many sub-runs execute at once within the agent step.
class Semaphore {
  private available: number
  private readonly waiters: Array<() => void> = []
  constructor(permits: number) {
    this.available = permits
  }
  acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve)
    })
  }
  release(): void {
    const next = this.waiters.shift()
    if (next) {
      next()
    } else {
      this.available++
    }
  }
}

export class SpawnManager {
  private readonly handles: SpawnHandle[] = []
  private readonly byId = new Map<string, SpawnHandle>()
  private minted = 0
  private readonly semaphore: Semaphore
  // Replaced (and its old copy resolved) each time a handle settles, so a parked
  // `join` wakes to re-check its selection without polling.
  private settle = makeDeferred()

  constructor(
    private readonly opts: {
      maxConcurrent: number
      maxSpawns: number
      runSubAgent: RunSubAgent
    },
  ) {
    this.semaphore = new Semaphore(Math.max(1, opts.maxConcurrent))
  }

  /**
   * Launch a sub-run in the background. Returns a handle immediately (does NOT
   * await it). Returns an error object (never throws) when the total-spawns cap
   * is hit, so the model can adapt rather than blow the budget.
   */
  spawn(target: SubAgentTarget, input: unknown): SpawnAccepted | SpawnRejected {
    if (this.minted >= this.opts.maxSpawns) {
      return {
        error: `Sub-agent budget exhausted: at most ${this.opts.maxSpawns} sub-agents may be spawned in this run. Await and use the results you have.`,
      }
    }
    const ordinal = this.minted++
    const spawnId = `spawn-${ordinal}`
    const handle: SpawnHandle = {
      spawnId,
      target,
      ordinal,
      status: 'running',
      promise: Promise.resolve(),
    }
    handle.promise = this.runOne(handle, input)
    this.handles.push(handle)
    this.byId.set(spawnId, handle)
    return { spawnId, target: { kind: target.kind, id: target.id } }
  }

  private async runOne(handle: SpawnHandle, input: unknown): Promise<void> {
    await this.semaphore.acquire()
    try {
      const result = await this.opts.runSubAgent(
        handle.target,
        input,
        handle.ordinal,
      )
      handle.status = 'completed'
      handle.result = result
    } catch (err) {
      handle.status = 'failed'
      handle.error = err instanceof Error ? err.message : String(err)
    } finally {
      this.semaphore.release()
      // Wake any parked join to re-evaluate.
      const prev = this.settle
      this.settle = makeDeferred()
      prev.resolve()
    }
  }

  private select(spawnIds?: string[]): SpawnHandle[] {
    if (!spawnIds || spawnIds.length === 0) return [...this.handles]
    return spawnIds
      .map((id) => this.byId.get(id))
      .filter((h): h is SpawnHandle => h !== undefined)
  }

  /**
   * Wait until every selected sub-run settles, OR until a selected sub-run
   * completes with a stop signal (short-circuit). Omit `spawnIds` to join ALL
   * in-flight spawns. Returns the settled results plus any still-running ones.
   */
  async join(spawnIds?: string[]): Promise<JoinResult> {
    for (;;) {
      // Capture the wakeup BEFORE inspecting state so a settle that races the
      // checks can't be lost (it resolves the captured promise).
      const wait = this.settle.promise
      const selected = this.select(spawnIds)
      const stopHit = selected.some((h) => h.result?.stopSignalled)
      const running = selected.filter((h) => h.status === 'running')
      if (stopHit || running.length === 0) {
        return this.summarize(selected)
      }
      await wait
    }
  }

  private summarize(selected: SpawnHandle[]): JoinResult {
    const completed: JoinCompleted[] = []
    const pending: JoinPending[] = []
    for (const h of selected) {
      const ref = { kind: h.target.kind, id: h.target.id }
      if (h.status === 'running') {
        pending.push({ spawnId: h.spawnId, target: ref })
      } else {
        completed.push({
          spawnId: h.spawnId,
          target: ref,
          status: h.status,
          output: h.result?.output,
          stopSignalled: h.result?.stopSignalled ?? false,
          reason: h.result?.reason,
          error: h.error,
        })
      }
    }
    return {
      completed,
      pending,
      stopped: selected.some((h) => h.result?.stopSignalled),
    }
  }

  /** Non-blocking snapshot of every spawn's current status. */
  check(): CheckEntry[] {
    return this.handles.map((h) => ({
      spawnId: h.spawnId,
      target: { kind: h.target.kind, id: h.target.id },
      status: h.status,
      stopSignalled: h.result?.stopSignalled ?? false,
    }))
  }
}
