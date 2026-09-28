import { describe, expect, test } from 'bun:test'
import type { z } from 'zod'

import { buildStarterGraph } from '../engine/graph-builders'

import { createWfSdkHandlers } from './handlers'
import type { wfInputSchemas } from './handlers/input-schemas'
import type { CreateWfSdkHandlersOptions } from './handlers/shared'
import type { WfDataClient } from './protocol'

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

// ---------------------------------------------------------------------------
// The compile-time half (ART-188).
//
// `HandlerCtx<K>.params` is typed from this table, so a handler can no longer
// disagree with its own schema — reading an undeclared field (which `z.object`
// would have STRIPPED, handing the handler `undefined` with no error) is a type
// error at the read. These assertions pin the property that the type system
// enforces silently, so deleting it shows up as a failing build here rather
// than as casts creeping back into handlers.
//
// The other direction — the CLIENT sending something the schema rejects — is
// enforced in `data-client.ts`, whose `send` takes `WfInputWire<K>`. That is
// where a positional id wrapped under the wrong key (`{ versionID }`) fails.
// ---------------------------------------------------------------------------

/** Compiles only when `A` is assignable to `B`. */
type Assignable<A, B> = A extends B ? true : false
function assignable<A, B>(
  _ok: Assignable<A, B> extends true ? true : never,
): void {}

type ParamsOf<K extends keyof WfDataClient> = z.infer<(typeof wfInputSchemas)[K]>

describe('wfInputSchemas types the handler params', () => {
  test('a named schema yields its exact field types', () => {
    // Required id, optional enum — not `unknown`, which is what the table
    // inferred back when it was ANNOTATED `Record<…, z.ZodType>` instead of
    // `satisfies`-checked.
    assignable<ParamsOf<'retryRun'>, { runId: string }>(true)
    assignable<
      { runId: string; mode?: 'restart' | 'resume' },
      ParamsOf<'retryRun'>
    >(true)
    // A nullable field stays nullable rather than collapsing to `string`.
    assignable<ParamsOf<'setRunNote'>, { note: string | null }>(true)
    expect(true).toBe(true)
  })

  test('a positional id is declared under the key the client wraps it in', () => {
    // `getVersion(versionId)` goes out as `{ versionId }` — the schema has to
    // name that exact key or the dispatcher strips it and the handler sees a
    // missing id.
    assignable<{ versionId: string }, ParamsOf<'getVersion'>>(true)
    assignable<{ workflowId: string }, ParamsOf<'listVersions'>>(true)
    assignable<{ parentRunId: string }, ParamsOf<'listChildRuns'>>(true)
    expect(true).toBe(true)
  })

  test('a NO_INPUT method stays unknown rather than pretending to a shape', () => {
    assignable<{ anything: number }, ParamsOf<'listAgents'>>(true)
    expect(true).toBe(true)
  })
})

describe('required ids reject the empty string', () => {
  // `requireStr` used to enforce this in every handler ("Missing 'x' parameter"
  // on `''` as well as on absent). It now lives in the schema as `.min(1)`,
  // which is the only reason deleting `requireStr` was safe — without it a
  // blank id would reach a D1 lookup and quietly find nothing.
  test.each([
    ['getWorkflow', { workflowId: '' }],
    ['getAgent', { agentId: '' }],
    ['getRun', { runId: '' }],
    ['getConnector', { connectorId: '' }],
    ['getEvalSet', { setId: '' }],
  ] as const)('%s rejects a blank id with 400', async (method, params) => {
    const handle = createWfSdkHandlers(options())
    const res = await handle(post(method, params))
    expect(res.status).toBe(400)
  })

  test('a non-blank id gets past validation', async () => {
    const handle = createWfSdkHandlers(options())
    // 500 = the stub db threw, i.e. the schema let it through.
    const res = await handle(post('getWorkflow', { workflowId: 'wf_1' }))
    expect(res.status).toBe(500)
  })
})
