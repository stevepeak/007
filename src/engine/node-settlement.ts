import type { ReportResult } from './scheduler'

// How one dispatched node ended, as carried through the `Promise.race` at the
// heart of the rolling walk. Shared by both backends so their loops cannot
// drift apart on failure handling.

/**
 * A settled node dispatch.
 *
 * A failure is folded into the VALUE rather than left as a rejection, and that
 * is the whole reason this type exists. `Promise.race` over a set of dispatches
 * settles on the first one to finish — if that one rejects, the race rejects
 * with a bare error carrying no hint as to which node produced it, and the
 * remaining entries are left unhandled. Tagging the outcome keeps the winner's
 * identity attached to it either way.
 */
export type NodeSettlement =
  | { ok: true; nodeId: string; report: ReportResult }
  | { ok: false; nodeId: string; error: unknown }

/** Wrap a dispatch so it always resolves, tagged with the node it belongs to. */
export function settleOf(
  nodeId: string,
  work: Promise<{ nodeId: string; report: ReportResult }>,
): Promise<NodeSettlement> {
  return work.then(
    (v): NodeSettlement => ({ ok: true, nodeId: v.nodeId, report: v.report }),
    (error: unknown): NodeSettlement => ({ ok: false, nodeId, error }),
  )
}
