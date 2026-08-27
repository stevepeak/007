import type { CalleeDoneWire } from './callee-protocol'

/**
 * The inline engine's `step.waitForEvent`.
 *
 * A durable run parks on the platform's journal and is woken by `sendEvent`. An
 * inline run has no journal to park on, so it parks on a promise held here — in
 * the RunRoom, the one object that both halves can reach: the walk executes
 * inside it, and the child addresses it by id.
 *
 * In memory, and deliberately so. The wait cannot outlive the run, and the run
 * cannot outlive its room: an inline run that loses its Durable Object is a
 * failed run, exactly as it is for every other reason (see `inline-run.ts`).
 *
 * Split out of the room itself so this — the part with the race in it — can be
 * tested outside workerd.
 */
export class CalleeWaiters {
  private waiters = new Map<string, (wire: CalleeDoneWire) => void>()

  /**
   * Results that arrived before anyone was waiting.
   *
   * The walk registers its waiter before it spawns, so this should stay empty —
   * but "should" is doing load-bearing work in a distributed handshake, and
   * dropping a result would park the caller until its node timeout for no
   * reason. Bounded in practice by the number of calling nodes in one graph.
   */
  private inbox = new Map<string, CalleeDoneWire>()

  /** A spawned callee reporting its result. */
  deliver(eventType: string, wire: CalleeDoneWire): void {
    const waiter = this.waiters.get(eventType)
    if (!waiter) {
      this.inbox.set(eventType, wire)
      return
    }
    this.waiters.delete(eventType)
    waiter(wire)
  }

  /**
   * Wait for one callee's result, or reject after `timeoutMs`.
   *
   * The timeout is the calling node's own declared step timeout — the same knob
   * that bounds a durable caller's `waitForEvent` — so a child that dies without
   * ever reporting surfaces as a legible node failure rather than a run that
   * hangs until its room is evicted.
   */
  wait(eventType: string, timeoutMs: number): Promise<CalleeDoneWire> {
    const early = this.inbox.get(eventType)
    if (early) {
      this.inbox.delete(eventType)
      return Promise.resolve(early)
    }
    return new Promise<CalleeDoneWire>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(eventType)
        reject(
          new Error(
            `Timed out after ${Math.round(
              timeoutMs / 1000,
            )}s waiting for a called workflow to report back.`,
          ),
        )
      }, timeoutMs)
      this.waiters.set(eventType, (wire) => {
        clearTimeout(timer)
        resolve(wire)
      })
    })
  }
}
