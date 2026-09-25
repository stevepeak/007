/**
 * Where the SDK reports a fault it has decided not to throw.
 *
 * Most of the failures in this package are deliberately swallowed: a live log
 * that didn't append, an analytics point that was dropped, a lifecycle callback
 * that threw after the run already produced its output. Swallowing them is
 * correct — none of them should cost a run its answer — but it left every one
 * of them reachable only as a `console.error`, and a console line in a Worker
 * is a Sentry breadcrumb at best (see `consoleLoggingIntegration`). A run that
 * silently loses its log feed had no signal anywhere.
 *
 * This is the seam that gives those sites somewhere to go. The host supplies
 * one `WfLogger` on {@link WfSdkConfig.logger}; the SDK calls it from every
 * catch that used to reach for `console`. Omit it and the behavior is exactly
 * what it was — {@link consoleWfLogger}.
 */
export type WfLogger = {
  /**
   * A degradation: the SDK recovered, but something the caller asked for did
   * not happen (a marker not written, a panel that fell back to D1).
   */
  warn: (message: string, err?: unknown) => void
  /**
   * A fault: something that should have worked did not, and nothing downstream
   * repaired it. These are the ones worth an alert.
   */
  error: (message: string, err?: unknown) => void
}

/**
 * The default: what every one of these sites did before the seam existed.
 *
 * `err` is passed through as the second console argument rather than folded
 * into the message so a structured value stays inspectable in `wrangler tail`.
 */
export const consoleWfLogger: WfLogger = {
  warn: (message, err) => {
    if (err === undefined) console.warn(message)
    else console.warn(message, err)
  },
  error: (message, err) => {
    if (err === undefined) console.error(message)
    else console.error(message, err)
  },
}

/**
 * Wrap a host logger so it can never make things worse.
 *
 * Every call site is inside a catch whose contract is "never throws" — a run
 * that already failed must not also fail to *record* that it failed. A host
 * logger is arbitrary host code (a Sentry client mid-outage, say), so its own
 * throw is caught here and reported to the console instead, which is strictly
 * better than the situation before this file existed.
 */
function guard(logger: WfLogger): WfLogger {
  const call = (
    level: 'warn' | 'error',
    message: string,
    err: unknown,
  ): void => {
    try {
      logger[level](message, err)
    } catch (loggerErr) {
      consoleWfLogger.error(`[wf] logger threw reporting: ${message}`, loggerErr)
      consoleWfLogger[level](message, err)
    }
  }
  return {
    warn: (message, err) => call('warn', message, err),
    error: (message, err) => call('error', message, err),
  }
}

/**
 * Resolve the logger for a call site: the host's if it wired one, the console
 * otherwise. Call it once per entry point and pass the result down — not once
 * per log line — so the guard wrapper is allocated once.
 */
export function resolveWfLogger(logger?: WfLogger): WfLogger {
  return logger ? guard(logger) : consoleWfLogger
}
