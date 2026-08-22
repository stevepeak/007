import { describe, expect, test } from 'bun:test'

import { buildStarterGraph } from '../engine/graph-builders'

import { createWfSdkHandlers } from './handlers'
import type { CreateWfSdkHandlersOptions } from './handlers/shared'

// `wfInputSchemas` is now TOTAL — every `WfDataClient` method declares how its
// wire input is checked, so a new method can't silently skip validation. The
// compiler proves the coverage; these tests pin the two runtime behaviours that
// coverage alone doesn't guarantee.
//
// The second one is the sharp edge. `z.object` STRIPS unknown keys and the
// dispatcher forwards `parsed.data`, so a schema that fails to name a field
// doesn't just leave it unvalidated — it DELETES it before the handler runs.
// Filling in the 32 missing entries meant naming every field 32 handlers read,
// and a miss would look like "the graph you saved was empty" rather than a
// validation error.

function post(method: string, params: unknown): Request {
  return new Request('http://localhost/api/wf', {
    method: 'POST',
    body: JSON.stringify({ method, params }),
  })
}

function options(): CreateWfSdkHandlersOptions<unknown> {
  return {
    config: { listModels: async () => [], toolRegistry: new Map() },
    // Reached only AFTER input validation passes, so throwing here is how a
    // test tells "the schema accepted this" from "the schema rejected it".
    resolveDb: () => {
      throw new Error('reached the handler')
    },
    resolveContext: () => ({ userId: 'user_123' }),
    onError: () => {},
  } as unknown as CreateWfSdkHandlersOptions<unknown>
}

describe('dispatcher input validation', () => {
  test('rejects a malformed body with 400 on a method that used to skip validation', async () => {
    const handle = createWfSdkHandlers(options())

    // `saveVersion` had no entry before, so a numeric id sailed past the
    // dispatcher and surfaced as an opaque 500 from a D1 bind.
    const res = await handle(
      post('saveVersion', { workflowId: 42, graph: buildStarterGraph({ mode: 'manual' }) }),
    )

    expect(res.status).toBe(400)
    // Read as text: the point is that the 400 names the method, and going
    // through `json()` here only buys a cast.
    expect(await res.text()).toContain('saveVersion')
  })

  test('rejects a missing required id rather than passing undefined down', async () => {
    const handle = createWfSdkHandlers(options())
    const res = await handle(post('createEvalSet', { name: 'goals' }))
    expect(res.status).toBe(400)
  })

  test('passes a rich payload through intact instead of stripping it', async () => {
    const handle = createWfSdkHandlers(options())
    const graph = buildStarterGraph({ mode: 'manual' })

    // A valid payload must reach the handler — which then dies on the stub db,
    // NOT on a 400. If `graph` were stripped by the schema, `parseGraph` would
    // reject it here and this would be a 400 instead.
    const ok = await handle(post('createWorkflow', { name: 'Intake', graph }))
    expect(ok.status).toBe(500)

    // The contrast that makes the assertion above mean something: the same call
    // WITHOUT a graph really is a 400, so status 500 above is evidence the blob
    // survived rather than evidence nothing is validated.
    const missing = await handle(post('createWorkflow', { name: 'Intake' }))
    expect(missing.status).toBe(400)
  })

  test('accepts a zero-arg method with an empty body', async () => {
    const handle = createWfSdkHandlers(options())
    // `NO_INPUT` must not reject the `{}` that `createHttpWfDataClient` sends
    // for a method with no params.
    const res = await handle(post('listAgents', {}))
    expect(res.status).toBe(500)
  })
})
