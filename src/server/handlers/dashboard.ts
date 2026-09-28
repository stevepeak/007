import { loadDashboard } from '../../storage/data'
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
      const stats = await loadDashboard(
        c.db,
        // Passed through as one object rather than field-by-field so that a
        // `bucket` the schema allows but `DashboardBucket` doesn't is a compile
        // error here, which is the only place the two vocabularies meet.
        c.params,
        Date.now(),
        // Null when the host wired no reader (or it's local dev) — the storage
        // layer then answers from D1 exactly as it always has.
        await c.analytics(),
        c.logger,
      )
      // Annotated, not inferred: `DashboardStats` and `WfDashboardResult` are
      // declared independently (storage must not depend on the wire protocol),
      // so this assignment is what makes any drift between them a compile error.
      const result: WfDashboardResult = {
        ...stats,
        recentFailures: stats.recentFailures.map((r) => {
          return runSummary(r, opts.sentryTraceUrl, opts.releaseUrl)
        }),
      }
      return result
    },
  }
}
