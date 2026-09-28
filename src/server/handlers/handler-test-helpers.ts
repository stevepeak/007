import { consoleWfLogger } from '../../engine/logger'
import type { WfDb } from '../../storage/client'
import { recordChange } from '../../storage/data'

import type { CreateWfSdkHandlersOptions, HandlerCtx } from './shared'

// The two fixtures every handler test needs: the builder options a
// `buildXHandlers(...)` takes, and the per-request `HandlerCtx` a handler is
// called with.
//
// Both were hand-rolled in each handler test, and the `ctx` copies were
// character-identical — which is the tell: `HandlerCtx` is a CONTRACT with the
// dispatcher (`resolveCall` in `handlers.ts`), so a field added there has to
// reach every test's fixture or the tests stop modelling the thing they claim
// to. One copy makes that a compile error in one place.

/**
 * `CreateWfSdkHandlersOptions` with only what a handler test needs wired.
 *
 * The defaults are all "this test should not reach here": `resolveDb` throws
 * because the test hands the db in via {@link testHandlerCtx} instead, and
 * `listModels` answers empty so nothing tries the network. `config` merges
 * key-by-key, so passing a `toolRegistry` or a `getModel` keeps the rest.
 *
 * `config` is taken as a PARTIAL of the real one: the host's injection surface
 * has required members a handler test never exercises, so demanding all of them
 * would just push every test back to the whole-object `as unknown as` cast this
 * replaces. Partial keeps the key names checked — a typo'd `listMdoels` still
 * fails — and leaves the one cast here, where it is explained.
 */
export function testHandlerOptions<TDeps = unknown>(
  over: Partial<Omit<CreateWfSdkHandlersOptions<TDeps>, 'config'>> & {
    config?: Partial<CreateWfSdkHandlersOptions<TDeps>['config']>
  } = {},
): CreateWfSdkHandlersOptions<TDeps> {
  const { config, ...rest } = over
  return {
    config: {
      listModels: async () => [],
      ...config,
    },
    resolveDb: () => {
      throw new Error('resolveDb: tests pass the db through the HandlerCtx')
    },
    resolveContext: () => ({}),
    ...rest,
  } as unknown as CreateWfSdkHandlersOptions<TDeps>
}

/**
 * A `HandlerCtx` bound to `db`, carrying `params` as the dispatcher would.
 *
 * `change` is a REAL recorder against the same in-memory db, not a stub: these
 * tests exercise the handlers end to end, and a stub would hide a broken change
 * write — which is the half of a mutation nobody looks at until someone asks
 * who touched a workflow.
 */
export function testHandlerCtx(
  db: WfDb,
  params: unknown,
  over: Partial<HandlerCtx> = {},
): HandlerCtx {
  return {
    params,
    ctx: { userId: 'tester' },
    db,
    req: new Request('http://localhost/api/wf', { method: 'POST' }),
    env: async () => ({}),
    analytics: async () => null,
    logger: consoleWfLogger,
    change: (input) => {
      return recordChange(db, { ...input, actor: { userId: 'tester' } })
    },
    ...over,
  }
}
