import { loadDashboard, type DashboardBucket } from '../../storage/data'
import type { WfDashboardResult } from '../protocol'

import {
  runSummary,
  type CreateWfSdkHandlersOptions,
  type WfHandlers,
} from './shared'

export function buildDashboardHandlers<TDeps>(
  opts: CreateWfSdkHandlersOptions<TDeps>,
): Pick<WfHandlers, 'getDashboard'> {
  return {
    // The home page's whole payload in one round trip. The storage layer clamps
    // the window (the spend query parses every agent step's meta JSON, so an
    // unbounded range is never taken on trust), and the resolved window comes
    // back on the result so the UI labels what it actually charted.
    getDashboard: async (c) => {
      const p = c.params as {
        since?: number
        until?: number
        bucket?: DashboardBucket
      }
      const stats = await loadDashboard(c.db, {
        since: p.since,
        until: p.until,
        bucket: p.bucket,
      })
      // Annotated, not inferred: `DashboardStats` and `WfDashboardResult` are
      // declared independently (storage must not depend on the wire protocol),
      // so this assignment is what makes any drift between them a compile error.
      const result: WfDashboardResult = {
        ...stats,
        recentFailures: stats.recentFailures.map((r) =>
          runSummary(r, opts.sentryTraceUrl),
        ),
      }
      return result
    },
  }
}
