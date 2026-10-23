import { NoObjectGeneratedError } from 'ai'

import { apiErrorDetail } from './error-detail'
import { errorMessage } from './error-message'

// Why a run stopped, as the routes an `on-failure` node can wire.
//
// Exactly one route per failure, so a handler never fires two arms for one
// event. Order inside `classifyFailure` is the tie-break: a 429 whose request
// also timed out is `rate_limited`, because waiting is the fix either way and
// the status code is the more specific signal.
//
// Classification reads the live error where it can, and falls back to the
// message: on the durable engine an error that crossed a `step.do` boundary is
// rebuilt as a bare `Error`, so its class and status code are gone and the text
// is all that is left.

export const FAILURE_ROUTES = [
  'timeout',
  'rate_limited',
  'external_error',
  'internal_error',
  'invalid_output',
  'invalid_input',
  'limit_exceeded',
  'cancelled',
] as const
export type FailureRoute = (typeof FAILURE_ROUTES)[number]

export function isFailureRoute(value: unknown): value is FailureRoute {
  return (
    typeof value === 'string' &&
    (FAILURE_ROUTES as readonly string[]).includes(value)
  )
}

/** Human labels for the editor's route handles and the run viewer. */
export const FAILURE_ROUTE_LABELS: Record<FailureRoute, string> = {
  timeout: 'Timeout',
  rate_limited: 'Rate limited',
  external_error: 'External error',
  internal_error: 'Internal error',
  invalid_output: 'Invalid output',
  invalid_input: 'Invalid input',
  limit_exceeded: 'Limit exceeded',
  cancelled: 'Cancelled',
}

/** Who asked for a run to stop. `id` is the host principal, opaque to the SDK. */
export type CancelledBy = { kind: 'user' | 'system'; id?: string }

/**
 * Thrown in place of starting a node once the run has been asked to stop. Never
 * swallowed by `continueOnError`: it is thrown before the node runs, outside the
 * node's own failure handling.
 */
export class RunCancelledError extends Error {
  readonly failureRoute = 'cancelled' as const
  constructor() {
    super('Run cancelled.')
    this.name = 'RunCancelledError'
  }
}

/**
 * What a failed run hands its `on-failure` handler — the handler run's trigger
 * output. `input` is the failed run's own trigger input, so a handler can name
 * the entity it cleans up without a ref into the graph that failed.
 */
export type RunFailurePayload = {
  route: FailureRoute
  error: string
  /** The run that failed — the handler run's parent. */
  runId: string
  /** The node whose failure stopped the run; absent for a run-level fault
   * (a stall, the node budget, a cancel between nodes). */
  failedNodeId?: string
  statusCode?: number
  cancelledBy?: CancelledBy
  input: unknown
}

type Tagged = { failureRoute?: unknown; failedNodeId?: unknown }

/**
 * Pin a route (and the failing node) onto a thrown value, so the classification
 * made where the real error object existed survives to the run's catch. A tool
 * can do the same to choose its own route: throw an error whose `failureRoute`
 * is one of {@link FAILURE_ROUTES}.
 */
export function tagFailure(
  err: unknown,
  tag: { route?: FailureRoute; nodeId?: string },
): unknown {
  if (err == null || typeof err !== 'object') return err
  const t = err as Tagged
  if (tag.route && !isFailureRoute(t.failureRoute)) t.failureRoute = tag.route
  if (tag.nodeId && typeof t.failedNodeId !== 'string') {
    t.failedNodeId = tag.nodeId
  }
  return err
}

/** The node a {@link tagFailure}-tagged error failed in, if it carries one. */
export function failedNodeIdOf(err: unknown): string | undefined {
  const id = (err as Tagged | null | undefined)?.failedNodeId
  return typeof id === 'string' ? id : undefined
}

const NAME_ROUTES: Record<string, FailureRoute> = {
  RunCancelledError: 'cancelled',
  TimeoutError: 'timeout',
  WorkflowTimeoutError: 'timeout',
  WorkflowBudgetError: 'limit_exceeded',
  IterationTooManyItemsError: 'limit_exceeded',
  ZodError: 'invalid_input',
  ParseError: 'invalid_output',
  WorkflowStalledError: 'internal_error',
}

/** Walk `cause` (depth-capped) for the first error whose name we know. */
function routeByName(err: unknown): FailureRoute | null {
  let current: unknown = err
  for (let depth = 0; current != null && depth < 5; depth++) {
    const name = (current as { name?: unknown }).name
    if (typeof name === 'string' && Object.hasOwn(NAME_ROUTES, name)) {
      return NAME_ROUTES[name]
    }
    if (NoObjectGeneratedError.isInstance(current)) return 'invalid_output'
    current = (current as { cause?: unknown }).cause
  }
  return null
}

function routeByStatus(status: number | undefined): FailureRoute | null {
  if (status == null) return null
  if (status === 429) return 'rate_limited'
  if (status === 402) return 'limit_exceeded'
  if (status === 408 || status === 504) return 'timeout'
  // 4xx from a provider is a request it refused — bad key, unknown model, a
  // parameter it doesn't accept. That is configuration, not our code.
  if (status >= 400) return 'external_error'
  return null
}

const MESSAGE_ROUTES: [RegExp, FailureRoute][] = [
  [/rate.?limit|too many requests|\bHTTP 429\b/i, 'rate_limited'],
  [/timed? ?out|exceeded its total budget/i, 'timeout'],
  [/insufficient (credits|quota|funds)|payment required|\bHTTP 402\b/i, 'limit_exceeded'],
  [/execution budget|maxItems|too many items/i, 'limit_exceeded'],
  [/output does not satisfy|no object generated|could not parse/i, 'invalid_output'],
  [/fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|socket hang up|network|\bHTTP 5\d\d\b|service unavailable|bad gateway/i, 'external_error'],
]

/** The one route a thrown value stops a run under. Unknown → `internal_error`. */
export function classifyFailure(err: unknown): FailureRoute {
  const tagged = (err as Tagged | null | undefined)?.failureRoute
  if (isFailureRoute(tagged)) return tagged
  const byName = routeByName(err)
  if (byName) return byName
  const detail = apiErrorDetail(err)
  const byStatus = routeByStatus(detail?.statusCode)
  if (byStatus) return byStatus
  if (detail) return 'external_error'
  const message = errorMessage(err)
  for (const [pattern, route] of MESSAGE_ROUTES) {
    if (pattern.test(message)) return route
  }
  return 'internal_error'
}

/** The provider status code behind a failure, when the live error still has it. */
export function failureStatusCode(err: unknown): number | undefined {
  return apiErrorDetail(err)?.statusCode
}
