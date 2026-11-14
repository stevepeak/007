import { resolveBinding } from '../binding'
import type { WaitNode } from '../graph'
import { interpolateUserText } from '../prompt-variables'
import type { StreamSink } from '../stream-sink'

export type WaitNodeOutput = {
  /** True when every run finished; false when the wait ran out of time. */
  satisfied: boolean
  waitedMs: number
  total: number
  done: number
  /** Ids of the runs still unfinished when the wait ended. */
  pending: string[]
}

/** Reads `wf_run.status` for each id; an id with no row is absent. */
export type RunStatusReader = (
  runIds: string[],
) => Promise<ReadonlyMap<string, { status: string }>>

export type ExecuteWaitNodeArgs = {
  node: WaitNode
  nodeOutputs: Map<string, unknown>
  getRunStatuses?: RunStatusReader
  sink?: StreamSink
  /**
   * Ceiling the backend gives this node's work (its model budget's `totalMs`).
   * The wait ends at whichever comes first, this or `config.timeoutMs`.
   */
  budgetMs?: number
  /** Polled between checks; a cancelled run stops waiting. */
  isCancelled?: () => Promise<boolean>
  /** Eval signal — a simulated run never waits on real runs. */
  simulate?: boolean
  /** Injected by tests. */
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export const WAIT_POLL_INTERVAL_MS = 5_000

/** Statuses after which a run will do no more work it can be waited on for.
 * `done` is an answered run still draining its side arms. */
const FINISHED = new Set(['done', 'completed', 'failed', 'cancelled'])

function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

// Re-running the node (an inline restart, a durable retry) starts the wait over
// from a fresh read, which is safe because the wait only reads.
export async function executeWaitNode(
  deps: ExecuteWaitNodeArgs,
): Promise<{ output: WaitNodeOutput }> {
  const { node, sink } = deps
  const { runIds, timeoutMs, onTimeout, progress } = node.config
  const self = node.label || `Wait node ${node.id}`
  const sleep = deps.sleep ?? defaultSleep
  const now = deps.now ?? Date.now

  const raw = runIds
    ? resolveBinding(runIds, deps.nodeOutputs, { nodeId: node.id, name: 'runIds' })
    : undefined
  if (raw != null && !Array.isArray(raw)) {
    throw new Error(`${self}: \`runIds\` must resolve to a list of run ids.`)
  }
  const ids = [
    ...new Set((raw ?? []).filter((id): id is string => typeof id === 'string' && id !== '')),
  ]

  const startedAt = now()
  const result = (pending: string[]) => {
    return {
      output: {
        satisfied: pending.length === 0,
        waitedMs: now() - startedAt,
        total: ids.length,
        done: ids.length - pending.length,
        pending,
      },
    }
  }
  if (ids.length === 0 || deps.simulate) return result([])
  if (!deps.getRunStatuses) {
    throw new Error(`${self}: this host cannot read run status, so it cannot wait on runs.`)
  }

  const limitMs = Math.min(timeoutMs, deps.budgetMs ?? timeoutMs)
  let lastDone = -1
  while (true) {
    const statuses = await deps.getRunStatuses(ids)
    // A run with no row cannot finish, so it is not waited on.
    const pending = ids.filter((id) => {
      const status = statuses.get(id)?.status
      return status !== undefined && !FINISHED.has(status)
    })
    const done = ids.length - pending.length
    if (progress?.trim() && done !== lastDone && pending.length > 0) {
      lastDone = done
      const line = interpolateUserText(progress, { done, total: ids.length })
      await sink?.log?.({ level: 'progress', message: line })
    }
    if (pending.length === 0) return result([])

    if (now() - startedAt + WAIT_POLL_INTERVAL_MS > limitMs) {
      if (onTimeout === 'fail') {
        throw new Error(
          `${self} timed out after ${Math.round((now() - startedAt) / 1000)}s with ${pending.length} of ${ids.length} runs unfinished.`,
        )
      }
      return result(pending)
    }
    await sleep(WAIT_POLL_INTERVAL_MS)
    if (await deps.isCancelled?.()) return result(pending)
  }
}
